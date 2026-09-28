import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { profiles } from '../../src/providers.js';
import { OFFICIAL_IMAGE_REPOSITORY } from '../../src/setup/gcloud.js';
import { main } from '../../src/setup/main.js';
import { createFakeGcloud, type FakeGcloud, type GcloudStep } from '../../testkit/src/fakeGcloud.js';

// SET-77 (added): `node setup.js` itself: the real gcloud adapter, prompt,
// screen, progress file and log, wired to the flow. Only the mail checks and
// the final self-check are stood in (they would reach real mail servers).
const P = 'universal-mail-a1b2c3';
const ACCT = '0X0X0X-111111-222222';
const SA = `universal-mail-server@${P}.iam.gserviceaccount.com`;
const URL = 'https://universal-mail-a1b2c3-uc.a.run.app';
const IMAGE = `${OFFICIAL_IMAGE_REPOSITORY}@sha256:${'ab'.repeat(32)}`;
const NOW = Date.parse('2026-09-25T10:00:00Z');
const region = '--region=us-central1';
const project = `--project=${P}`;
const yahoo = profiles.find(p => p.id === 'yahoo')!;

let fake: FakeGcloud | undefined;
let home: string | undefined;
afterEach(() => { fake?.cleanup(); fake = undefined; if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });

// A person at the Cloud Shell prompt: each answer is typed when a question appears.
function terminal(answers: string[]) {
  const stdin = new PassThrough();
  let screen = '';
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      screen += chunk.toString();
      // A question ends with its prompt mark and a space; the answer follows.
      if (screen.endsWith('› ')) setImmediate(() => stdin.write(`${answers.shift() ?? ''}\n`));
      done();
    }
  });
  return { stdin, stdout, screen: () => screen };
}

// Everything a fresh install asks of Google, as gcloud would answer it.
const freshInstall = (): GcloudStep[] => {
  const secret = (name: string) => [
    { args: ['secrets', 'describe', name, project], stderr: `ERROR: NOT_FOUND: Secret [${name}] not found.`, exitCode: 1 },
    { args: ['secrets', 'create', name, '--replication-policy=automatic', project], repeat: true },
    { args: ['secrets', 'versions', 'add', name, '--data-file=-', project], repeat: true },
    { args: ['secrets', 'versions', 'list', name, '--filter=state:enabled', '--format=value(name)', project], stdout: `projects/1/secrets/${name}/versions/1\n`, repeat: true }
  ];
  return [
    { args: ['config', 'get-value', 'account'], stdout: 'you@gmail.com\n' },
    // No project chosen in Cloud Shell, so no version 1 to convert.
    { args: ['config', 'get-value', 'project'], stdout: '(unset)\n' },
    { args: ['organizations', 'list', '--format=json'], stdout: '[]' },
    { args: ['billing', 'accounts', 'list', '--format=json'], stdout: JSON.stringify([{ name: `billingAccounts/${ACCT}`, open: true }]) },
    { args: ['projects', 'list', '--filter=labels.universal-mail=true', '--format=json'], stdout: '[]', repeat: true },
    { args: ['projects', 'create', P, '--name=Universal Mail', '--labels=universal-mail=true', '--quiet'] },
    { args: ['billing', 'projects', 'describe', P, '--format=json'], stdout: JSON.stringify({ billingEnabled: false }) },
    { args: ['billing', 'projects', 'link', P, `--billing-account=${ACCT}`] },
    { args: ['services', 'list', '--enabled', project, '--format=json'], stdout: '[]' },
    { args: ['services', 'enable', 'run.googleapis.com', 'secretmanager.googleapis.com', 'billingbudgets.googleapis.com', project] },
    { args: ['services', 'list', '--enabled', project, '--format=json'], repeat: true,
      stdout: JSON.stringify(['run', 'secretmanager', 'billingbudgets'].map(s => ({ config: { name: `${s}.googleapis.com` } }))) },
    { args: ['billing', 'budgets', 'list', `--billing-account=${ACCT}`, '--format=json', `--billing-project=${P}`], stdout: '[]' },
    { args: ['billing', 'budgets', 'create', `--billing-account=${ACCT}`, `--display-name=Universal Mail $1 alarm (${P})`, '--budget-amount=1USD', `--filter-projects=projects/${P}`, '--threshold-rule=percent=0.5', '--threshold-rule=percent=1.0', `--billing-project=${P}`] },
    ...secret('universal-mail-credentials'),
    ...secret('universal-mail-state'),
    { args: ['run', 'services', 'describe', 'universal-mail', region, project, '--format=value(status.url)'], stderr: 'ERROR: Cannot find service [universal-mail]', exitCode: 1 },
    { args: ['artifacts', 'docker', 'images', 'describe', IMAGE, '--format=json'], stdout: '{}' },
    { args: ['iam', 'service-accounts', 'create', 'universal-mail-server', '--display-name=Universal Mail server', project] },
    ...['universal-mail-state', 'universal-mail-credentials'].flatMap(secretName => ['roles/secretmanager.secretAccessor', 'roles/secretmanager.secretVersionManager'].map(role =>
      ({ args: ['secrets', 'add-iam-policy-binding', secretName, `--member=serviceAccount:${SA}`, `--role=${role}`, project] }))),
    { args: ['run', 'deploy', 'universal-mail', `--image=${IMAGE}`, region, project, `--service-account=${SA}`, '--allow-unauthenticated', '--max-instances=1',
      '--set-secrets=UNIVERSAL_MAIL_STATE=universal-mail-state:latest,UNIVERSAL_MAIL_CREDENTIALS=universal-mail-credentials:latest', '--quiet'] },
    { args: ['run', 'services', 'describe', 'universal-mail', region, project, '--format=value(status.url)'], stdout: `${URL}\n` },
    { args: ['run', 'services', 'update', 'universal-mail', region, project, `--update-env-vars=PUBLIC_URL=${URL}`, '--quiet'] },
    { args: ['run', 'services', 'update', 'universal-mail', region, project, `--update-env-vars=SETTINGS_SAVED_AT=${new Date(NOW).toISOString()}`, '--quiet'] }
  ];
};

const mail = {
  detect: async () => ({ provider: yahoo }),
  check: async (_a: string, password: string) => password === 'app-password-1' ? { ok: true as const, folders: 12, safeMove: true } : { ok: false as const, reason: 'rejected' as const },
  sendTest: async () => ({ copies: 1 as const })
};

function run(argv: string[], answers: string[], options: { cloudShell?: boolean; steps?: GcloudStep[] } = {}) {
  fake = createFakeGcloud(options.steps ?? freshInstall());
  home ??= mkdtempSync(join(tmpdir(), 'setup-main-'));
  const t = terminal(answers);
  const selfTests: string[] = [];
  const done = main(argv, {
    env: { ...fake.env, ...(options.cloudShell === false ? {} : { CLOUD_SHELL: 'true' }) },
    stdin: t.stdin, stdout: t.stdout, home, gcloud: fake.command, image: IMAGE,
    projectId: () => P, clock: { now: () => NOW, sleep: async () => undefined },
    overrides: { mail, selfTest: async target => { selfTests.push(`${target.url}/${target.key}`); return { passed: 12, total: 12 }; } }
  });
  return { done, screen: t.screen, selfTests };
}

describe('node setup.js', () => {
  it('SET-77 a whole install, through the real gcloud adapter, prompt, screen, progress and log (added)', { timeout: 120_000 }, async () => {
    const r = run([], ['me@yahoo.com', '', 'app-password-1', '', '', '']);
    expect(await r.done).toBe(0);
    expect(fake!.unscripted()).toEqual([]);
    const screen = r.screen();
    expect(screen).toContain('Step 8 of 8');
    expect(screen).toContain('All done.');
    expect(screen).toContain(URL);
    // The password was never shown, logged or written anywhere but Google's secret (on standard input).
    expect(screen).not.toContain('app-password-1');
    expect(readFileSync(join(home!, '.universal-mail', 'setup-log.jsonl'), 'utf8')).not.toContain('app-password-1');
    expect(readFileSync(join(home!, '.universal-mail', 'progress.json'), 'utf8')).not.toContain('app-password-1');
    expect(fake!.inputs().filter(i => i.stdin?.includes('app-password-1')).map(i => i.args[3])).toEqual(['universal-mail-credentials']);
    expect(JSON.parse(readFileSync(join(home!, '.universal-mail', 'progress.json'), 'utf8'))).toMatchObject({ step: 8, project: P });
    expect(r.selfTests).toHaveLength(1);
    expect(r.selfTests[0]).toMatch(new RegExp(`^${URL}/[A-Za-z0-9_-]{20,}$`));
  });

  it('SET-77 report prints the paste-safe block, even before any setup has run', async () => {
    const r = run(['report'], []);
    expect(await r.done).toBe(0);
    expect(r.screen()).toContain('Universal Mail setup report');
    expect(r.screen()).toContain('No setup has been run on this machine yet.');
    expect(fake!.calls()).toEqual([]);
  });

  it('SET-77 outside Cloud Shell: the plain message, a failing exit code, and nothing asked of Google', async () => {
    const r = run([], [], { cloudShell: false });
    expect(await r.done).toBe(1);
    expect(r.screen()).toContain('This needs to run in Google Cloud Shell.');
    expect(fake!.calls()).toEqual([]);
  });

  it('SET-77 something it doesn\'t recognise: how to use it, and nothing else', async () => {
    const r = run(['--frobnicate'], []);
    expect(await r.done).toBe(2);
    expect(r.screen()).toContain('node setup.js report');
    expect(fake!.calls()).toEqual([]);
    expect(existsSync(join(home!, '.universal-mail', 'progress.json'))).toBe(false);
  });
});
