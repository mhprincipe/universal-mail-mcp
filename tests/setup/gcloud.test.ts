import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OFFICIAL_IMAGE_REPOSITORY, createGcloudRunner, createGoogleCloud } from '../../src/setup/gcloud.js';
import { GoogleRefusal, NotReadyYet } from '../../src/setup/google.js';
import { createSetupLog } from '../../src/setup/log.js';
import { createCanary } from '../../testkit/src/canary.js';
import { createFakeGcloud, type FakeGcloud, type GcloudStep } from '../../testkit/src/fakeGcloud.js';

// The commands below are what the live install will run. Google's wording in
// the failure cases is as documented; the live install confirms it.
const P = 'universal-mail-a1b2c3';
const ACCT = '0X0X0X-111111-222222';
const SA = `universal-mail-server@${P}.iam.gserviceaccount.com`;
const URL = 'https://universal-mail-a1b2c3-uc.a.run.app';
const IMAGE = `${OFFICIAL_IMAGE_REPOSITORY}@sha256:${'ab'.repeat(32)}`;
const region = '--region=us-central1';
const project = `--project=${P}`;

let fake: FakeGcloud | undefined;
let home: string | undefined;
afterEach(() => { fake?.cleanup(); fake = undefined; if (home) rmSync(home, { recursive: true, force: true }); home = undefined; });

function adapter(steps: GcloudStep[]) {
  fake = createFakeGcloud(steps);
  home = mkdtempSync(join(tmpdir(), 'gcloud-log-'));
  const log = createSetupLog(home, Date);
  const run = createGcloudRunner({ command: fake.command, env: fake.env, log });
  return { google: createGoogleCloud({ run, newProjectId: () => P }), log, logText: () => readFileSync(join(home!, '.universal-mail', 'setup-log.jsonl'), 'utf8') };
}

// Each scripted gcloud call is a real process; with the whole suite running,
// two dozen of them can outlast Vitest's 5 s default, which says nothing
// about the adapter.
describe('the gcloud adapter', { timeout: 60_000 }, () => {
  it('SET-63 a fresh install runs exactly these commands, and reads their answers (added)', async () => {
    const secretValue = createCanary('credentials');
    const { google, log } = adapter([
      { args: ['config', 'get-value', 'account'], stdout: 'you@gmail.com\n' },
      { args: ['billing', 'accounts', 'list', '--format=json'], stdout: JSON.stringify([{ name: `billingAccounts/${ACCT}`, open: true }]) },
      { args: ['organizations', 'list', '--format=json'], stdout: '[]' },
      { args: ['projects', 'list', '--filter=labels.universal-mail=true', '--format=json'], stdout: '[]' },
      { args: ['projects', 'create', P, '--name=Universal Mail', '--labels=universal-mail=true', '--quiet'] },
      { args: ['billing', 'projects', 'describe', P, '--format=json'], stdout: JSON.stringify({ billingEnabled: false }) },
      { args: ['billing', 'projects', 'link', P, `--billing-account=${ACCT}`] },
      { args: ['services', 'list', '--enabled', project, '--format=json'], stdout: '[]' },
      { args: ['services', 'enable', 'run.googleapis.com', 'secretmanager.googleapis.com', 'billingbudgets.googleapis.com', project] },
      { args: ['billing', 'budgets', 'list', `--billing-account=${ACCT}`, '--format=json'], stdout: '[]' },
      { args: ['billing', 'budgets', 'create', `--billing-account=${ACCT}`, `--display-name=Universal Mail $1 alarm (${P})`, '--budget-amount=1USD', `--filter-projects=projects/${P}`, '--threshold-rule=percent=0.5', '--threshold-rule=percent=1.0'] },
      { args: ['secrets', 'describe', 'universal-mail-credentials', project], stderr: 'ERROR: NOT_FOUND: Secret [universal-mail-credentials] not found.', exitCode: 1 },
      { args: ['secrets', 'create', 'universal-mail-credentials', '--replication-policy=automatic', project] },
      { args: ['secrets', 'versions', 'add', 'universal-mail-credentials', '--data-file=-', project] },
      { args: ['secrets', 'versions', 'list', 'universal-mail-credentials', '--filter=state:enabled', '--format=value(name)', project], stdout: 'projects/1/secrets/universal-mail-credentials/versions/1\n' },
      { args: ['secrets', 'versions', 'access', 'latest', '--secret=universal-mail-credentials', project], stdout: secretValue },
      { args: ['run', 'services', 'describe', 'universal-mail', region, project, '--format=value(status.url)'], stderr: 'ERROR: Cannot find service [universal-mail]', exitCode: 1 },
      { args: ['artifacts', 'docker', 'images', 'describe', IMAGE, '--format=json'], stdout: '{}' },
      { args: ['iam', 'service-accounts', 'create', 'universal-mail-server', '--display-name=Universal Mail server', project] },
      // Version manager: it adds versions and destroys old ones (INS-06), nothing more.
      ...['universal-mail-state', 'universal-mail-credentials'].flatMap(secret => ['roles/secretmanager.secretAccessor', 'roles/secretmanager.secretVersionManager'].map(role =>
        ({ args: ['secrets', 'add-iam-policy-binding', secret, `--member=serviceAccount:${SA}`, `--role=${role}`, project] }))),
      { args: ['run', 'deploy', 'universal-mail', `--image=${IMAGE}`, region, project, `--service-account=${SA}`, '--allow-unauthenticated', '--max-instances=1',
        '--set-secrets=UNIVERSAL_MAIL_STATE=universal-mail-state:latest,UNIVERSAL_MAIL_CREDENTIALS=universal-mail-credentials:latest', '--quiet'] },
      { args: ['run', 'services', 'describe', 'universal-mail', region, project, '--format=value(status.url)'], stdout: `${URL}\n` },
      { args: ['run', 'services', 'update', 'universal-mail', region, project, `--update-env-vars=PUBLIC_URL=${URL}`, '--quiet'] }
    ]);
    log.secret(secretValue);

    expect(await google.signedInAccount()).toBe('you@gmail.com');
    expect(await google.billing()).toEqual({ state: 'active', trial: false, accountId: ACCT });
    expect(await google.blocksPublicServices()).toBe(false);
    expect(await google.findProject()).toBeUndefined();
    expect(await google.createProject()).toBe(P);
    expect(await google.billingLinked(P)).toBe(false);
    await google.linkBilling(P, ACCT);
    expect(await google.servicesReady(P)).toBe(false);
    await google.enableServices(P);
    expect(await google.budgetExists(P, ACCT)).toBe(false);
    await google.createBudget(P, ACCT, 1);
    expect(await google.secretExists(P, 'universal-mail-credentials')).toBe(false);
    await google.putSecret(P, 'universal-mail-credentials', secretValue);
    expect(await google.readSecret(P, 'universal-mail-credentials')).toBe(secretValue);
    expect(await google.serverUrl(P)).toBeUndefined();
    expect(await google.imageTrusted(IMAGE)).toBe(true);
    expect(await google.startServer(P, IMAGE, { UNIVERSAL_MAIL_STATE: 'universal-mail-state', UNIVERSAL_MAIL_CREDENTIALS: 'universal-mail-credentials' })).toBe(URL);

    expect(fake!.unscripted()).toEqual([]);
    // A secret travels on standard input, never on a command line.
    const inputs = fake!.inputs();
    expect(inputs.find(i => i.args.includes('--data-file=-'))?.stdin).toBe(secretValue);
    expect(inputs.filter(i => i.args.some(a => a.includes(secretValue)))).toEqual([]);
  });

  it('SET-74 a restart changes one marker setting, so Cloud Run starts a new revision that reads the latest settings (added)', async () => {
    const { google } = adapter([
      { args: ['run', 'services', 'update', 'universal-mail', region, project, '--update-env-vars=SETTINGS_SAVED_AT=2026-09-25T10:00:00.000Z', '--quiet'] }
    ]);
    await google.restartServer(P, Date.parse('2026-09-25T10:00:00Z'));
    expect(fake!.unscripted()).toEqual([]);
  });

  it('SET-79 the menu\'s commands: the running image, removing the $1 alarm, deleting the project (added)', async () => {
    const { google } = adapter([
      { args: ['run', 'services', 'describe', 'universal-mail', region, project, '--format=value(spec.template.spec.containers[0].image)'], stdout: `${IMAGE}\n` },
      { args: ['billing', 'budgets', 'list', `--billing-account=${ACCT}`, '--format=json'],
        stdout: JSON.stringify([{ name: `billingAccounts/${ACCT}/budgets/other-1`, displayName: 'Someone else\'s budget' }, { name: `billingAccounts/${ACCT}/budgets/um-77`, displayName: `Universal Mail $1 alarm (${P})` }]) },
      { args: ['billing', 'budgets', 'delete', 'um-77', `--billing-account=${ACCT}`, '--quiet'] },
      { args: ['projects', 'delete', P, '--quiet'] }
    ]);
    expect(await google.serverImage(P)).toBe(IMAGE);
    await google.deleteBudget(P, ACCT);
    await google.deleteProject(P);
    expect(fake!.unscripted()).toEqual([]);
    // Only our own alarm: someone else's budget is never touched.
    expect(fake!.calls().filter(c => c.includes('delete') && c.includes('budgets')).map(c => c[3])).toEqual(['um-77']);
  });

  it('SET-55 version 1: Cloud Shell\'s project, v1\'s service and its Sent mode; labelling the project (added: commands)', async () => {
    const v1 = { spec: { template: { spec: { containers: [{ env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'SENT_COPY_MODE', value: 'yahoo' }] }] } } } };
    const { google } = adapter([
      { args: ['config', 'get-value', 'project'], stdout: 'yahoo-mail-mcp\n' },
      { args: ['run', 'services', 'describe', 'yahoo-mail-mcp', region, '--project=yahoo-mail-mcp', '--format=json'], stdout: JSON.stringify(v1) },
      { args: ['projects', 'update', 'yahoo-mail-mcp', '--update-labels=universal-mail=true'] },
      { args: ['run', 'services', 'describe', 'yahoo-mail-mcp', region, '--project=elsewhere', '--format=json'], stderr: 'ERROR: Cannot find service [yahoo-mail-mcp]', exitCode: 1 }
    ]);
    expect(await google.currentProject()).toBe('yahoo-mail-mcp');
    expect(await google.v1Service('yahoo-mail-mcp')).toEqual({ sentCopyMode: 'yahoo' });
    await google.labelProject('yahoo-mail-mcp');
    expect(await google.v1Service('elsewhere')).toBeUndefined();
    expect(fake!.unscripted()).toEqual([]);
  });

  it('SET-79 no server yet: no image; no alarm of ours: nothing deleted', async () => {
    const { google } = adapter([
      { args: ['run', 'services', 'describe', 'universal-mail', region, project, '--format=value(spec.template.spec.containers[0].image)'], stderr: 'ERROR: Cannot find service [universal-mail]', exitCode: 1 },
      { args: ['billing', 'budgets', 'list', `--billing-account=${ACCT}`, '--format=json'], stdout: '[]' }
    ]);
    expect(await google.serverImage(P)).toBeUndefined();
    await google.deleteBudget(P, ACCT);
    expect(fake!.unscripted()).toEqual([]);
  });

  it('SET-76 each save keeps only the newest two versions, so secrets never cost anything (added)', async () => {
    const name = 'universal-mail-state';
    const { google } = adapter([
      { args: ['secrets', 'create', name, '--replication-policy=automatic', project], exitCode: 1, stderr: `ERROR: ALREADY_EXISTS: Secret [${name}] already exists.` },
      { args: ['secrets', 'versions', 'add', name, '--data-file=-', project] },
      // Google lists them in any order; the numbers decide.
      { args: ['secrets', 'versions', 'list', name, '--filter=state:enabled', '--format=value(name)', project],
        stdout: [3, 5, 1, 4].map(v => `projects/1/secrets/${name}/versions/${v}`).join('\n') },
      { args: ['secrets', 'versions', 'destroy', '3', `--secret=${name}`, project, '--quiet'] },
      { args: ['secrets', 'versions', 'destroy', '1', `--secret=${name}`, project, '--quiet'] }
    ]);
    await google.putSecret(P, name, '{}');
    expect(fake!.unscripted()).toEqual([]);
    expect(fake!.inputs().filter(i => i.args.includes('destroy')).map(i => i.args[3])).toEqual(['3', '1']);
  });

  it('SET-66 a rerun recognises everything that already exists, from Google\'s own answers (added)', async () => {
    const { google } = adapter([
      { args: ['projects', 'list', '--filter=labels.universal-mail=true', '--format=json'], stdout: JSON.stringify([{ projectId: P }]) },
      { args: ['billing', 'projects', 'describe', P, '--format=json'], stdout: JSON.stringify({ billingEnabled: true, billingAccountName: `billingAccounts/${ACCT}` }) },
      // Google names enabled services two ways; both are understood.
      { args: ['services', 'list', '--enabled', project, '--format=json'], stdout: JSON.stringify([
        { config: { name: 'run.googleapis.com' } }, { name: `projects/123/services/secretmanager.googleapis.com` }, { config: { name: 'billingbudgets.googleapis.com' } }
      ]) },
      { args: ['billing', 'budgets', 'list', `--billing-account=${ACCT}`, '--format=json'], stdout: JSON.stringify([{ displayName: 'Someone else\'s budget' }, { displayName: `Universal Mail $1 alarm (${P})` }]) },
      // Only someone else's budget: ours still has to be created.
      { args: ['billing', 'budgets', 'list', `--billing-account=${ACCT}`, '--format=json'], stdout: JSON.stringify([{ displayName: 'Someone else\'s budget' }]) },
      { args: ['secrets', 'describe', 'universal-mail-state', project], stdout: 'name: projects/123/secrets/universal-mail-state' },
      { args: ['secrets', 'versions', 'access', 'latest', '--secret=universal-mail-state', project], exitCode: 1, stderr: 'ERROR: NOT_FOUND: Secret Version [latest] not found.' },
      { args: ['run', 'services', 'describe', 'universal-mail', region, project, '--format=value(status.url)'], stdout: `${URL}\n` },
      { args: ['artifacts', 'docker', 'images', 'describe', IMAGE, '--format=json'], exitCode: 1, stderr: 'ERROR: NOT_FOUND: image not found' },
      { args: ['iam', 'service-accounts', 'create', 'universal-mail-server', '--display-name=Universal Mail server', project], exitCode: 1, stderr: 'ERROR: ALREADY_EXISTS: Service account universal-mail-server already exists' },
      { args: ['secrets', 'add-iam-policy-binding', 'universal-mail-state', `--member=serviceAccount:${SA}`, '--role=roles/secretmanager.secretAccessor', project], exitCode: 1, stderr: 'ERROR: INTERNAL: backend error' }
    ]);
    expect(await google.findProject()).toBe(P);
    expect(await google.billingLinked(P)).toBe(true);
    expect(await google.servicesReady(P)).toBe(true);
    expect(await google.budgetExists(P, ACCT)).toBe(true);
    expect(await google.budgetExists(P, ACCT)).toBe(false);
    expect(await google.secretExists(P, 'universal-mail-state')).toBe(true);
    expect(await google.readSecret(P, 'universal-mail-state')).toBeUndefined();
    expect(await google.serverUrl(P)).toBe(URL);
    // An official-looking image that isn't there is not trusted.
    expect(await google.imageTrusted(IMAGE)).toBe(false);
    // A service identity from an earlier run is reused; the next failure is reported with Google's words.
    await expect(google.startServer(P, IMAGE, { UNIVERSAL_MAIL_STATE: 'universal-mail-state' })).rejects.toThrow(/INTERNAL: backend error/);
    expect(fake!.unscripted()).toEqual([]);
  });

  it('SET-67 no gcloud, signed out, no billing, closed billing and company policies are all read correctly (added)', async () => {
    const { google, log, logText } = adapter([
      { args: ['config', 'get-value', 'account'], stdout: '(unset)\n' },
      { args: ['billing', 'accounts', 'list', '--format=json'], stdout: '[]' },
      { args: ['billing', 'accounts', 'list', '--format=json'], stdout: JSON.stringify([{ name: `billingAccounts/${ACCT}`, open: false }]) },
      { args: ['organizations', 'list', '--format=json'], stdout: JSON.stringify([{ name: 'organizations/4242' }]) },
      { args: ['resource-manager', 'org-policies', 'describe', 'iam.allowedPolicyMemberDomains', '--organization=4242', '--effective', '--format=json'],
        stdout: JSON.stringify({ listPolicy: { allowedValues: ['C0abc123'] } }) },
      { args: ['secrets', 'describe', 'universal-mail-state', project], exitCode: 1, stderr: 'ERROR: PERMISSION_DENIED: caller lacks permission' }
    ]);
    expect(await google.signedInAccount()).toBeUndefined();
    expect(await google.billing()).toEqual({ state: 'missing', trial: false });
    expect(await google.billing()).toEqual({ state: 'suspended', trial: false });
    expect(await google.blocksPublicServices()).toBe(true);
    await expect(google.secretExists(P, 'universal-mail-state')).rejects.toThrow(/caller lacks permission/);

    // gcloud itself missing: reported and logged, not a crash.
    const missing = createGcloudRunner({ command: ['this-program-does-not-exist-7f3k'], log });
    expect((await missing(['config', 'get-value', 'account'])).status).toBe(127);
    expect(logText()).toContain('"status":127');
  });

  it('SET-20 an image from anywhere else, or not pinned by digest, is refused without asking Google (adapter)', async () => {
    const { google } = adapter([]);
    for (const image of [`${OFFICIAL_IMAGE_REPOSITORY}:latest`, `${OFFICIAL_IMAGE_REPOSITORY}:2.0.0`, `docker.io/someone/server@sha256:${'ab'.repeat(32)}`, `${OFFICIAL_IMAGE_REPOSITORY}@sha256:short`]) {
      expect(await google.imageTrusted(image), image).toBe(false);
    }
    expect(fake!.calls()).toEqual([]);
  });

  it('SET-64 Google\'s known refusals become the plain problems (added)', async () => {
    const { google } = adapter([
      { args: ['projects', 'create', P, '--name=Universal Mail', '--labels=universal-mail=true', '--quiet'], exitCode: 1,
        stderr: 'ERROR: (gcloud.projects.create) FAILED_PRECONDITION: Precondition check failed. You have reached your project quota.' },
      { args: ['billing', 'projects', 'link', P, `--billing-account=${ACCT}`], exitCode: 1,
        stderr: 'ERROR: (gcloud.billing.projects.link) FAILED_PRECONDITION: Precondition check failed: billing account is not open.' },
      { args: ['run', 'services', 'update', 'universal-mail', region, project, '--update-env-vars=PUBLIC_URL=x', '--quiet'], exitCode: 1,
        stderr: 'ERROR: (gcloud.run.services.update) PERMISSION_DENIED: Permission denied on secret: projects/1/secrets/universal-mail-state/versions/latest for Revision service account' },
      { args: ['services', 'enable', 'run.googleapis.com', 'secretmanager.googleapis.com', 'billingbudgets.googleapis.com', project], exitCode: 1,
        stderr: "ERROR: FAILED_PRECONDITION: Operation denied by org policy on resource 'projects/universal-mail-a1b2c3': constraints/iam.allowedPolicyMemberDomains" },
      { args: ['billing', 'budgets', 'create', `--billing-account=${ACCT}`, `--display-name=Universal Mail $1 alarm (${P})`, '--budget-amount=1USD', `--filter-projects=projects/${P}`, '--threshold-rule=percent=0.5', '--threshold-rule=percent=1.0'], exitCode: 1,
        stderr: 'ERROR: (gcloud.billing.budgets.create) PERMISSION_DENIED: Cloud Billing Budget API has not been used in project 1 before or it is disabled. SERVICE_DISABLED' },
      { args: ['secrets', 'create', 'universal-mail-state', '--replication-policy=automatic', project], exitCode: 1, stderr: 'ERROR: something nobody expected' }
    ]);
    await expect(google.createProject()).rejects.toEqual(new GoogleRefusal('SETUP-PROJECT-QUOTA'));
    await expect(google.linkBilling(P, ACCT)).rejects.toEqual(new GoogleRefusal('SETUP-BILLING-SUSPENDED'));
    await expect((google as unknown as { updateUrl(p: string, u: string): Promise<void> }).updateUrl(P, 'x')).rejects.toBeInstanceOf(NotReadyYet);
    await expect(google.enableServices(P)).rejects.toEqual(new GoogleRefusal('SETUP-ORG-POLICY'));
    await expect(google.createBudget(P, ACCT, 1)).rejects.toMatchObject({ what: 'service' });
    // Anything else: an error carrying the command and Google's words, for the log.
    await expect(google.putSecret(P, 'universal-mail-state', 'x')).rejects.toThrow(/secrets create universal-mail-state.*something nobody expected/s);
  });

  it('SET-65 every command is logged with its arguments, exit status, time and Google\'s words; never its input or a secret (added)', async () => {
    const secretValue = createCanary('state');
    const { google, log, logText } = adapter([
      { args: ['secrets', 'create', 'universal-mail-state', '--replication-policy=automatic', project], exitCode: 1, stderr: 'ERROR: ALREADY_EXISTS: Secret [universal-mail-state] already exists.' },
      { args: ['secrets', 'versions', 'add', 'universal-mail-state', '--data-file=-', project], exitCode: 1, stderr: `ERROR: INVALID_ARGUMENT: payload "${secretValue}" too large` },
      { args: ['secrets', 'versions', 'access', 'latest', '--secret=universal-mail-state', project], stdout: secretValue }
    ]);
    log.secret(secretValue);
    await expect(google.putSecret(P, 'universal-mail-state', secretValue)).rejects.toThrow();
    await google.readSecret(P, 'universal-mail-state');
    const entries = logText().trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'gcloud');
    expect(entries.map(e => [e.args.slice(0, 3).join(' '), e.status])).toEqual([
      ['secrets create universal-mail-state', 1], ['secrets versions add', 1], ['secrets versions access', 0]
    ]);
    expect(entries[0].stderr).toContain('ALREADY_EXISTS');
    expect(entries[1].stderr).toContain('INVALID_ARGUMENT');
    for (const e of entries) expect(typeof e.ms).toBe('number');
    expect(logText()).not.toContain(secretValue);
    // Standard output (which can be a secret's contents) is never written, only its size.
    expect(entries[2]).toMatchObject({ stdoutBytes: secretValue.length });
    expect(entries[2].stdout).toBeUndefined();
  });
});
