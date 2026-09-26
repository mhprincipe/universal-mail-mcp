import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeGcloud, type FakeGcloud, type GcloudStep } from '../testkit/src/fakeGcloud.js';

// REL-05 (added): the one-time release setup (scripts/release-setup.sh), run
// by the owner in Cloud Shell. Against a scripted gcloud: exactly these
// commands, each thing created only if it's missing, and the three values
// GitHub needs printed at the end.
const root = fileURLToPath(new URL('..', import.meta.url));
const P = 'universal-mail-rel-zqrw';
const SA = `release-publisher@${P}.iam.gserviceaccount.com`;
const REPO = 'mhprincipe/universal-mail-mcp';
const project = `--project=${P}`;
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';

let fake: FakeGcloud | undefined;
afterEach(() => { fake?.cleanup(); fake = undefined; });

const missing = (args: string[]): GcloudStep => ({ args, exitCode: 1, stderr: 'ERROR: NOT_FOUND' });
const reads = (exists: boolean): GcloudStep[] => [
  { args: ['billing', 'accounts', 'list', '--filter=open=true', '--format=value(name)', '--limit=1'], stdout: 'billingAccounts/0X0X0X-111111-222222\n' },
  exists ? { args: ['projects', 'describe', P, '--format=value(projectNumber)'], stdout: '123456789012\n', repeat: true }
    : { args: ['projects', 'describe', P, '--format=value(projectNumber)'], exitCode: 1, stderr: 'ERROR: NOT_FOUND' }
];
const always: GcloudStep[] = [
  { args: ['billing', 'projects', 'link', P, '--billing-account=0X0X0X-111111-222222'] },
  { args: ['services', 'enable', 'artifactregistry.googleapis.com', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com', project] },
  // Anyone may read the images (every install pulls from here); only the publisher may write.
  { args: ['artifacts', 'repositories', 'add-iam-policy-binding', 'release', '--location=us', '--member=allUsers', '--role=roles/artifactregistry.reader', project] },
  { args: ['artifacts', 'repositories', 'add-iam-policy-binding', 'release', '--location=us', `--member=serviceAccount:${SA}`, '--role=roles/artifactregistry.writer', project] },
  // Only this repository's workflows may act as the publisher.
  { args: ['iam', 'service-accounts', 'add-iam-policy-binding', SA, '--role=roles/iam.workloadIdentityUser',
    `--member=principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}`, project] }
];
const creates: GcloudStep[] = [
  { args: ['projects', 'create', P, '--name=Universal Mail releases'] },
  { args: ['projects', 'describe', P, '--format=value(projectNumber)'], stdout: '123456789012\n', repeat: true },
  missing(['artifacts', 'repositories', 'describe', 'release', '--location=us', project]),
  { args: ['artifacts', 'repositories', 'create', 'release', '--repository-format=docker', '--location=us', '--description=Universal Mail server images', project] },
  missing(['iam', 'service-accounts', 'describe', SA, project]),
  { args: ['iam', 'service-accounts', 'create', 'release-publisher', '--display-name=Universal Mail release publisher', project] },
  missing(['iam', 'workload-identity-pools', 'describe', 'github', '--location=global', project]),
  { args: ['iam', 'workload-identity-pools', 'create', 'github', '--location=global', '--display-name=GitHub', project] },
  missing(['iam', 'workload-identity-pools', 'providers', 'describe', 'universal-mail', '--workload-identity-pool=github', '--location=global', project]),
  { args: ['iam', 'workload-identity-pools', 'providers', 'create-oidc', 'universal-mail', '--workload-identity-pool=github', '--location=global',
    '--issuer-uri=https://token.actions.githubusercontent.com', '--attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository',
    `--attribute-condition=assertion.repository=='${REPO}'`, project] }
];
const found: GcloudStep[] = [
  { args: ['artifacts', 'repositories', 'describe', 'release', '--location=us', project], stdout: '{}' },
  { args: ['iam', 'service-accounts', 'describe', SA, project], stdout: '{}' },
  { args: ['iam', 'workload-identity-pools', 'describe', 'github', '--location=global', project], stdout: '{}' },
  { args: ['iam', 'workload-identity-pools', 'providers', 'describe', 'universal-mail', '--workload-identity-pool=github', '--location=global', project], stdout: '{}' }
];

function run(steps: GcloudStep[]) {
  fake = createFakeGcloud(steps);
  return spawnSync(bash, [join(root, 'scripts', 'release-setup.sh')], { cwd: root, encoding: 'utf8', env: fake.env, timeout: 120_000 });
}

describe('the one-time release setup', () => {
  it.skipIf(!existsSync(bash) && process.platform === 'win32')('REL-05 a first run creates the project, the image store and the publisher, and prints what GitHub needs (added)', () => {
    const r = run([...reads(false), ...creates, ...always]);
    expect(r.stderr).not.toMatch(/FAKE-GCLOUD: unscripted/);
    expect(r.status).toBe(0);
    expect(fake!.unscripted()).toEqual([]);
    expect(r.stdout).toContain('GCP_WORKLOAD_IDENTITY_PROVIDER = projects/123456789012/locations/global/workloadIdentityPools/github/providers/universal-mail');
    expect(r.stdout).toContain(`GCP_RELEASE_SERVICE_ACCOUNT = ${SA}`);
    expect(r.stdout).toContain(`UPDATE_FEED_URL = https://raw.githubusercontent.com/${REPO}/release/latest.json`);
  }, 120_000);

  it.skipIf(!existsSync(bash) && process.platform === 'win32')('REL-05 run again, it finds everything and creates nothing', () => {
    const r = run([...reads(true), ...found, ...always]);
    expect(r.status).toBe(0);
    expect(fake!.unscripted()).toEqual([]);
    expect(fake!.calls().filter(c => c.includes('create') || c.includes('create-oidc'))).toEqual([]);
    expect(r.stdout).toContain(`GCP_RELEASE_SERVICE_ACCOUNT = ${SA}`);
  }, 120_000);

  it.skipIf(!existsSync(bash) && process.platform === 'win32')('REL-05 no open billing account: it stops before changing anything, and says why', () => {
    const r = run([{ args: ['billing', 'accounts', 'list', '--filter=open=true', '--format=value(name)', '--limit=1'], stdout: '' }]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('No open billing account');
    expect(fake!.calls()).toHaveLength(1);
  }, 120_000);
});
