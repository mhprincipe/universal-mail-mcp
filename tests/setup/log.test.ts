import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildReport } from '../../src/setup/log.js';
import { createCanary, scanForCanaries } from '../../testkit/src/canary.js';
import { createWorld, typical } from './flowHarness.js';

let w: ReturnType<typeof createWorld> | undefined;
afterEach(() => { w?.cleanup(); w = undefined; });

const events = (world: ReturnType<typeof createWorld>) =>
  readFileSync(join(world.home, '.universal-mail', 'setup-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

describe('the setup log', () => {
  it('SET-60 every run is logged: steps, every Google call with its outcome and time, every password check\'s outcome', async () => {
    w = createWorld();
    typical(w);
    await w.run();
    const log = events(w);
    expect(log[0]).toMatchObject({ type: 'run-start', version: '2.0.0', cloudShell: true });
    expect(typeof log[0].node).toBe('string');
    expect(log.filter(e => e.type === 'step' && e.phase === 'done').map(e => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const project = log.find(e => e.type === 'google' && e.op === 'createProject');
    expect(project).toMatchObject({ outcome: 'ok' });
    expect(typeof project.ms).toBe('number');
    expect(log.filter(e => e.type === 'mail' && e.op === 'check').map(e => `${e.provider} ${e.outcome}`)).toEqual(['yahoo ok', 'gmail ok']);
    expect(log.at(-1)).toMatchObject({ type: 'run-end', outcome: 'done' });
    // Every event is timed and belongs to this run.
    expect(new Set(log.map(e => e.run)).size).toBe(1);
    for (const e of log) expect(typeof e.at).toBe('string');
  });

  it('SET-60 a failure is logged with Google\'s own words and the code shown to the person', async () => {
    w = createWorld();
    typical(w);
    const original = w.fake.google.createBudget;
    w.fake.google.createBudget = async () => { throw Object.assign(new Error('ERROR: (gcloud.billing.budgets.create) PERMISSION_DENIED: Billing Budgets API has not been used in project 1234 before'), { exitCode: 1 }); };
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-UNEXPECTED' });
    w.fake.google.createBudget = original;
    // The person sees plain words, never Google's text or a stack trace.
    expect(w.screen()).toContain('Something unexpected went wrong at step 5 of 8.');
    expect(w.screen()).not.toMatch(/PERMISSION_DENIED|\n\s+at /);
    const failed = events(w).find(e => e.type === 'google' && e.op === 'createBudget');
    expect(failed).toMatchObject({ outcome: 'error' });
    expect(failed.error).toContain('PERMISSION_DENIED: Billing Budgets API has not been used');
    const error = events(w).find(e => e.type === 'error');
    expect(error).toMatchObject({ step: 5 });
    expect(error.stack).toContain('PERMISSION_DENIED');
    expect(events(w).at(-1)).toMatchObject({ type: 'run-end', outcome: 'stopped', code: 'SETUP-UNEXPECTED' });
  });

  it('SET-61 no password or key ever reaches the log, even inside Google\'s error text', async () => {
    w = createWorld();
    typical(w);
    const leaked = w.accounts['me@yahoo.com']!.password;
    w.fake.google.putSecret = async () => { throw new Error(`INVALID_ARGUMENT: bad payload near "${leaked}"`); };
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-UNEXPECTED' });
    const text = readFileSync(join(w.home, '.universal-mail', 'setup-log.jsonl'), 'utf8');
    expect(scanForCanaries(Object.values(w.accounts).map(a => a.password), { logs: [text], dirs: [w.home] })).toEqual([]);
    expect(text).toContain('[removed]');
  });

  it('SET-62 node setup.js report gives one block that is safe to paste', async () => {
    w = createWorld({ google: { servicesReadyAfterMs: 60 * 60_000 } });
    typical(w);
    await w.run();
    const report = buildReport(w.home, { version: '2.0.0' });
    expect(report).toMatch(/^Universal Mail setup report/);
    expect(report).toContain('Safe to paste: contains no passwords or keys.');
    expect(report).toContain('Stopped with: GOOGLE-SERVICE-NOT-READY');
    expect(report).toContain('Last step completed: 3 of 8');
    expect(report).toContain('"op":"enableServices"');
    const secrets = [...Object.values(w.accounts).map(a => a.password)];
    expect(scanForCanaries(secrets, { logs: [report] })).toEqual([]);
  });

  it('SET-62 the report never includes the secret part of the server\'s address', async () => {
    w = createWorld();
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'done' });
    const { key } = JSON.parse(readFileSync(join(w.home, '.universal-mail', 'progress.json'), 'utf8'));
    expect(key).toBeTruthy();
    expect(buildReport(w.home, { version: '2.0.0' })).not.toContain(key);
  });

  it('SET-62 a report with no setup yet says so plainly', () => {
    w = createWorld();
    expect(buildReport(w.home, { version: '2.0.0' })).toContain('No setup has been run on this machine yet.');
  });
});

// The planted secret in SET-61 must be a real canary.
void createCanary;
