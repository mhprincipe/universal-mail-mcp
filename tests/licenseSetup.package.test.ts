import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeGcloud, type FakeGcloud, type GcloudStep } from '../testkit/src/fakeGcloud.js';

// SUB-13 (design §13.3): the one-time setup of the license service
// (scripts/license-setup.sh), against the scripted gcloud: exactly these
// commands, secrets on standard input only, the key never printed, and the
// three addresses at the end.
const root = fileURLToPath(new URL('..', import.meta.url));
const P = 'universal-mail-rel-zqrw';
const RUNNER = `universal-mail-license@${P}.iam.gserviceaccount.com`;
const IMAGE = `us-docker.pkg.dev/${P}/release/server@sha256:${'ab'.repeat(32)}`;
const URL_ = 'https://universal-mail-license-abc-uc.a.run.app';
const project = `--project=${P}`;
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';

let fake: FakeGcloud | undefined;
afterEach(() => { fake?.cleanup(); fake = undefined; });

const missing = (args: string[]): GcloudStep => ({ args, exitCode: 1, stderr: 'ERROR: NOT_FOUND' });
const binding = (secret: string): GcloudStep => ({ args: ['secrets', 'add-iam-policy-binding', secret, `--member=serviceAccount:${RUNNER}`, '--role=roles/secretmanager.secretAccessor', project] });
const always: GcloudStep[] = [
  { args: ['services', 'enable', 'run.googleapis.com', 'firestore.googleapis.com', 'secretmanager.googleapis.com', project] },
  { args: ['projects', 'add-iam-policy-binding', P, `--member=serviceAccount:${RUNNER}`, '--role=roles/datastore.user'] },
  binding('universal-mail-license-key'), binding('universal-mail-paddle-webhook'), binding('universal-mail-paddle-client'),
  { args: ['run', 'deploy', 'universal-mail-license', `--image=${IMAGE}`, '--region=us-central1', project, `--service-account=${RUNNER}`,
    '--command=node', '--args=dist/src/licenseService/index.js', '--allow-unauthenticated', '--max-instances=2',
    '--set-secrets=LICENSE_SIGNING_KEY=universal-mail-license-key:latest,PADDLE_WEBHOOK_SECRET=universal-mail-paddle-webhook:latest,PADDLE_CLIENT_TOKEN=universal-mail-paddle-client:latest',
    '--set-env-vars=PADDLE_PRICE_MONTHLY=pri_m,PADDLE_PRICE_YEARLY=pri_y', '--quiet'] },
  { args: ['run', 'services', 'describe', 'universal-mail-license', '--region=us-central1', project, '--format=value(status.url)'], stdout: `${URL_}\n` },
  { args: ['run', 'services', 'update', 'universal-mail-license', '--region=us-central1', project, `--update-env-vars=LICENSE_SERVICE_URL=${URL_}`, '--quiet'] }
];
const creates: GcloudStep[] = [
  missing(['firestore', 'databases', 'describe', '--database=(default)', project]),
  { args: ['firestore', 'databases', 'create', '--database=(default)', '--location=nam5', '--type=firestore-native', project] },
  missing(['iam', 'service-accounts', 'describe', RUNNER, project]),
  { args: ['iam', 'service-accounts', 'create', 'universal-mail-license', '--display-name=Universal Mail license service', project] },
  missing(['secrets', 'describe', 'universal-mail-license-key', project]),
  { args: ['secrets', 'create', 'universal-mail-license-key', '--replication-policy=automatic', '--data-file=-', project] },
  missing(['secrets', 'describe', 'universal-mail-paddle-webhook', project]),
  { args: ['secrets', 'create', 'universal-mail-paddle-webhook', '--replication-policy=automatic', '--data-file=-', project] },
  missing(['secrets', 'describe', 'universal-mail-paddle-client', project]),
  { args: ['secrets', 'create', 'universal-mail-paddle-client', '--replication-policy=automatic', '--data-file=-', project] }
];
const found: GcloudStep[] = [
  { args: ['firestore', 'databases', 'describe', '--database=(default)', project], stdout: '{}' },
  { args: ['iam', 'service-accounts', 'describe', RUNNER, project], stdout: '{}' },
  { args: ['secrets', 'describe', 'universal-mail-license-key', project], stdout: '{}' },
  { args: ['secrets', 'describe', 'universal-mail-paddle-webhook', project], stdout: '{}' },
  { args: ['secrets', 'describe', 'universal-mail-paddle-client', project], stdout: '{}' }
];

function run(steps: GcloudStep[], env: Record<string, string> = {}) {
  fake = createFakeGcloud(steps);
  return spawnSync(bash, [join(root, 'scripts', 'license-setup.sh')], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...fake.env, IMAGE, PADDLE_PRICE_MONTHLY: 'pri_m', PADDLE_PRICE_YEARLY: 'pri_y', PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_secret_canary', PADDLE_CLIENT_TOKEN: 'live_client_canary', ...env }
  });
}
const skip = !existsSync(bash) && process.platform === 'win32';

describe('the one-time license service setup', () => {
  it.skipIf(skip)('SUB-13 a first run: the records store, the runner, the key and Paddle\'s secrets (on standard input only), the service; then the addresses (added)', () => {
    const r = run([...creates, ...always]);
    expect(r.stderr).not.toMatch(/FAKE-GCLOUD: unscripted/);
    expect(r.status).toBe(0);
    expect(fake!.unscripted()).toEqual([]);
    const inputs = fake!.inputs().filter(i => i.stdin);
    expect(inputs.map(i => i.args[2])).toEqual(['universal-mail-license-key', 'universal-mail-paddle-webhook', 'universal-mail-paddle-client']);
    const key = JSON.parse(inputs[0]!.stdin!);
    expect(key).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(typeof key.d).toBe('string');
    expect(inputs[1]!.stdin).toBe('pdl_ntfset_secret_canary');
    // Nothing secret on the screen.
    expect(r.stdout + r.stderr).not.toContain(key.d);
    expect(r.stdout + r.stderr).not.toContain('canary');
    expect(r.stdout).toContain(`LICENSE_SERVICE_URL = ${URL_}`);
    expect(r.stdout).toContain(`${URL_}/webhook/paddle`);
    expect(r.stdout).toContain(`${URL_}/welcome`);
  }, 120_000);

  it.skipIf(skip)('SUB-13 run again: everything found, nothing created; Paddle\'s secrets get a new version only when given', () => {
    const r = run([...found,
      { args: ['secrets', 'versions', 'add', 'universal-mail-paddle-webhook', '--data-file=-', project] },
      ...always], { PADDLE_CLIENT_TOKEN: '' });
    expect(r.status).toBe(0);
    expect(fake!.unscripted()).toEqual([]);
    expect(fake!.calls().filter(c => c.includes('create'))).toEqual([]);
    expect(fake!.inputs().filter(i => i.stdin).map(i => i.args[3])).toEqual(['universal-mail-paddle-webhook']);
  }, 120_000);

  it.skipIf(skip)('SUB-13 a first run without Paddle\'s secrets stops and says which to set', () => {
    const r = run([...creates.slice(0, 6), ...always.slice(0, 3), missing(['secrets', 'describe', 'universal-mail-paddle-webhook', project])], { PADDLE_WEBHOOK_SECRET: '', PADDLE_CLIENT_TOKEN: '' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('universal-mail-paddle-webhook has no value yet');
    expect(fake!.calls().some(c => c.includes('deploy'))).toBe(false);
  }, 120_000);
});
