import { describe, expect, it } from 'vitest';
import { CHECK_CODES } from '../../src/check/codes.js';
import { CheckFailure, failureEvent, runChecks, type Stage } from '../../src/check/runner.js';
import { createCanary } from '../../testkit/src/canary.js';
import { ReportSchema } from './reportSchema.js';

// Diagnostics (design §7): stages run in order, a failure stops what depends
// on it, and the report is built only from typed fields, so it is always safe
// to paste into a chat.
const clock = { now: () => Date.parse('2026-09-25T15:02:11Z') };
const facts = { accounts: 2, providers: ['yahoo', 'gmail'], trial: false };
const pass = (name: Stage['name'], after: Stage['after'] = []): Stage => ({ name, after, run: async () => undefined });
const fail = (name: Stage['name'], error: unknown, after: Stage['after'] = []): Stage => ({ name, after, run: async () => { throw error; } });

describe('the check report', () => {
  it('DIA-01 every report matches the schema: all passing, a failure, something unexpected', async () => {
    const scenarios: Stage[][] = [
      [pass('server'), pass('signin', ['server']), pass('account:fleet', ['server'])],
      [pass('server'), fail('account:fleet', new CheckFailure('MAIL-APP-PASSWORD-REJECTED', { provider: 'gmail' }), ['server']), pass('tools:fleet', ['account:fleet'])],
      [fail('server', new TypeError('boom'))]
    ];
    for (const stages of scenarios) {
      const report = await runChecks(stages, { version: '2.0.0', clock, facts });
      expect(() => ReportSchema.parse(report)).not.toThrow();
    }
    const failed = await runChecks(scenarios[1]!, { version: '2.0.0', clock, facts });
    expect(failed.result).toBe('FAIL');
    expect(failed.at).toBe('2026-09-25T15:02:11.000Z');
    expect(failed.stages[1]).toEqual({ stage: 'account:fleet', status: 'FAIL', code: 'MAIL-APP-PASSWORD-REJECTED', cause: 'Gmail no longer accepts the app password.', fix: CHECK_CODES['MAIL-APP-PASSWORD-REJECTED'].fix });
    expect((await runChecks(scenarios[0]!, { version: '2.0.0', clock, facts })).result).toBe('PASS');
  });

  it('DIA-02 a failed stage marks the stages that depend on it NOT_RUN, and they never run; others carry on', async () => {
    const ran: string[] = [];
    const tracked = (stage: Stage): Stage => ({ ...stage, run: async () => { ran.push(stage.name); await stage.run(); } });
    const report = await runChecks([
      pass('server'),
      fail('account:fleet', new CheckFailure('MAIL-UNREACHABLE', { provider: 'gmail' }), ['server']),
      pass('tools:fleet', ['account:fleet']),
      pass('live:fleet', ['tools:fleet']),
      pass('account:me', ['server']),
      pass('tools:me', ['account:me'])
    ].map(tracked), { version: '2.0.0', clock, facts });
    expect(report.stages.map(s => `${s.stage}=${s.status}`)).toEqual([
      'server=PASS', 'account:fleet=FAIL', 'tools:fleet=NOT_RUN', 'live:fleet=NOT_RUN', 'account:me=PASS', 'tools:me=PASS'
    ]);
    expect(report.stages[2]).toEqual({ stage: 'tools:fleet', status: 'NOT_RUN', after: 'account:fleet' });
    // NOT_RUN names the stage that failed, even two steps back.
    expect(report.stages[3]).toEqual({ stage: 'live:fleet', status: 'NOT_RUN', after: 'account:fleet' });
    expect(ran).toEqual(['server', 'account:fleet', 'account:me', 'tools:me']);
  });

  it('DIA-03 canaries planted in every failure path never appear in a report', async () => {
    const canary = createCanary('provider-error-text');
    const nested = new Error('outer', { cause: new Error(canary) });
    const odd = { toString: () => canary, message: canary };
    const errors: unknown[] = [
      new Error(`IMAP said: ${canary}`), nested, odd, canary,
      Object.assign(new CheckFailure('MAIL-UNREACHABLE', { provider: canary }), { detail: canary }),
      new CheckFailure('MAIL-APP-PASSWORD-REJECTED', { provider: 'gmail' }, canary)
    ];
    const seen: unknown[] = [];
    const report = await runChecks(
      errors.map((error, i) => fail(`account:a${i}`, error)),
      { version: '2.0.0', clock, facts: { ...facts, providers: ['yahoo', canary] }, onError: (_stage, error) => seen.push(error) }
    );
    const text = JSON.stringify(report);
    expect(text).not.toContain(canary);
    expect(report.stages.every(s => s.status === 'FAIL')).toBe(true);
    // An unknown provider name is never repeated back: it becomes a plain phrase.
    expect(report.stages[4]).toMatchObject({ code: 'MAIL-UNREACHABLE', cause: CHECK_CODES['MAIL-UNREACHABLE'].cause.replace('{provider}', 'Your provider') });
    expect(report.facts.providers).toEqual(['yahoo', 'other']);
    // The server's own log still gets each error, to diagnose it.
    expect(seen).toHaveLength(errors.length);
  });

  it('DIA-01 a failure with a code missing from the registry is reported as unexpected, not a crash', async () => {
    const stray = new CheckFailure('NOT-A-CODE' as never, { provider: 'gmail' });
    const report = await runChecks([fail('server', stray), pass('signin', ['server'])], { version: '2.0.0', clock, facts });
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report.stages[0]).toMatchObject({ status: 'FAIL', code: 'CHECK-UNEXPECTED' });
  });

  it('DIA-03 the server\'s log line for a failure: code, error name and where it happened, never its words', () => {
    const canary = createCanary('server-said');
    const unexpected = failureEvent('account:me', new TypeError(`Cannot read ${canary}`));
    expect(unexpected).toMatchObject({ event: 'check_stage_failed', stage: 'account:me', code: 'CHECK-UNEXPECTED', error: 'TypeError' });
    expect(unexpected.at!.length).toBeGreaterThan(0);
    expect(unexpected.at!.every(frame => frame.startsWith('at '))).toBe(true);
    expect(JSON.stringify(unexpected)).not.toContain(canary);

    const known = failureEvent('account:me', new CheckFailure('MAIL-UNREACHABLE', { provider: canary }, 'TRANSIENT_NETWORK'));
    expect(known).toEqual({ event: 'check_stage_failed', stage: 'account:me', code: 'MAIL-UNREACHABLE', error: 'CheckFailure', detail: 'TRANSIENT_NETWORK' });
    // A detail that isn't a plain label (free text, perhaps a server's reply) is dropped.
    const wordy = failureEvent('account:me', new CheckFailure('MAIL-UNREACHABLE', {}, `NO [ALERT] ${canary} said the server`));
    expect(wordy).toEqual({ event: 'check_stage_failed', stage: 'account:me', code: 'MAIL-UNREACHABLE', error: 'CheckFailure' });
    // Not even a thrown string or a stack-less object gets through.
    for (const odd of [canary, { message: canary, stack: canary }]) expect(JSON.stringify(failureEvent('server', odd))).not.toContain(canary);
  });

  it('DIA-05 every report opens with its plain-English readme', async () => {
    const report = await runChecks([pass('server')], { version: '2.0.0', clock, facts });
    expect(Object.keys(report).slice(0, 3)).toEqual(['report', 'schema', 'readme']);
    expect(report.readme).toContain('NOT_RUN means an earlier stage failed');
    expect(report.readme).toContain('no mail content, passwords');
  });

  it('DIA-01 every check code has a cause and a fix, and {provider} is the only value a cause may hold', () => {
    for (const [name, entry] of Object.entries(CHECK_CODES)) {
      expect(entry.cause, name).toMatch(/\.$/);
      expect(entry.fix, name).toMatch(/\.$/);
      expect(`${entry.cause} ${entry.fix}`.replace(/\{provider\}/g, ''), name).not.toMatch(/[{}]/);
    }
  });
});
