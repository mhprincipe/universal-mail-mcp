import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { GoogleRefusal, NotReadyYet, type GoogleCloud } from './google.js';
import type { SetupLog } from './log.js';

// GoogleCloud, for real: gcloud in Cloud Shell. Each method is one or a few
// commands, all written down in tests/setup/gcloud.test.ts. Google's wording
// in classify() is as documented; the live install confirms it.

export const OFFICIAL_IMAGE_REPOSITORY = 'us-docker.pkg.dev/universal-mail-rel-zqrw/release/server';
const REGION = 'us-central1';
const SERVICE = 'universal-mail';
const SERVER_IDENTITY = 'universal-mail-server';
const SERVICES = ['run.googleapis.com', 'secretmanager.googleapis.com', 'billingbudgets.googleapis.com'];

export type GcloudRunner = (args: string[], input?: string) => Promise<{ status: number; stdout: string; stderr: string }>;

// A failure nobody planned for: it carries the command and Google's words,
// which go to the log (the person sees SETUP-UNEXPECTED).
export class GcloudError extends Error {
  constructor(readonly args: string[], readonly status: number, readonly stderr: string) {
    super(`gcloud ${args.join(' ')} failed (exit ${status}): ${stderr.trim()}`);
  }
}

// Runs gcloud without a shell, input on standard input. Logs the arguments,
// exit status, time and Google's words; only the size of the output, which
// can be a secret's contents.
export function createGcloudRunner(options: { command?: string[]; env?: NodeJS.ProcessEnv; log: SetupLog }): GcloudRunner {
  const [program, ...prefix] = options.command ?? ['gcloud'];
  return (args, input) => new Promise(resolve => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    const finish = (status: number) => {
      options.log.event({ type: 'gcloud', args, status, ms: Date.now() - started, stderr: stderr.slice(-4000), stdoutBytes: Buffer.byteLength(stdout) });
      resolve({ status, stdout, stderr });
    };
    const child = spawn(program!, [...prefix, ...args], { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { stderr += error.message; finish(127); });
    child.on('close', code => finish(code ?? 1));
    child.stdin.end(input ?? '');
  });
}

// Google's refusals with a plain answer, and Google still catching up.
function classify(args: string[], stderr: string): Error {
  if (/project quota|quota.*projects?\b/i.test(stderr)) return new GoogleRefusal('SETUP-PROJECT-QUOTA');
  if (/billing account (is )?not open|billing account .*(closed|suspended)|BILLING_DISABLED/i.test(stderr)) return new GoogleRefusal('SETUP-BILLING-SUSPENDED');
  if (/org(anization)? policy|constraints\/iam\.allowedPolicyMemberDomains/i.test(stderr)) return new GoogleRefusal('SETUP-ORG-POLICY');
  if (/Permission denied on secret|for Revision service account|service account .* does not exist/i.test(stderr)) return new NotReadyYet('permission');
  if (/SERVICE_DISABLED|has not been used in project|it is disabled/i.test(stderr)) return new NotReadyYet('service');
  return new GcloudError(args, 1, stderr);
}

const notFound = (stderr: string) => /NOT_FOUND|not found|Cannot find/i.test(stderr);
const alreadyExists = (stderr: string) => /ALREADY_EXISTS|already exists/i.test(stderr);

export function createGoogleCloud(options: { run: GcloudRunner; newProjectId?: () => string }) {
  const { run } = options;
  const ok = async (args: string[], input?: string) => {
    const r = await run(args, input);
    if (r.status !== 0) throw classify(args, r.stderr);
    return r.stdout;
  };
  const json = async (args: string[]) => JSON.parse((await ok(args)) || 'null');
  const project = (p: string) => `--project=${p}`;
  const identity = (p: string) => `${SERVER_IDENTITY}@${p}.iam.gserviceaccount.com`;
  const budgetName = (p: string) => `Universal Mail $1 alarm (${p})`;

  const serverUrl = async (p: string) => {
    const r = await run(['run', 'services', 'describe', SERVICE, `--region=${REGION}`, project(p), '--format=value(status.url)']);
    if (r.status !== 0) { if (notFound(r.stderr)) return undefined; throw classify([], r.stderr); }
    return r.stdout.trim() || undefined;
  };
  const updateUrl = async (p: string, url: string) => {
    await ok(['run', 'services', 'update', SERVICE, `--region=${REGION}`, project(p), `--update-env-vars=PUBLIC_URL=${url}`, '--quiet']);
  };

  const google: GoogleCloud & { updateUrl(p: string, url: string): Promise<void> } = {
    async signedInAccount() {
      const account = (await ok(['config', 'get-value', 'account'])).trim();
      return !account || account === '(unset)' ? undefined : account;
    },
    async billing() {
      const accounts = (await json(['billing', 'accounts', 'list', '--format=json'])) as Array<{ name: string; open: boolean }> ?? [];
      if (!accounts.length) return { state: 'missing', trial: false };
      const open = accounts.find(a => a.open);
      if (!open) return { state: 'suspended', trial: false };
      // Open question for the live install: how gcloud shows a free-trial account.
      return { state: 'active', trial: false, accountId: open.name.replace(/^billingAccounts\//, '') };
    },
    async blocksPublicServices() {
      const orgs = (await json(['organizations', 'list', '--format=json'])) as Array<{ name: string }> ?? [];
      for (const org of orgs) {
        const policy = await json(['resource-manager', 'org-policies', 'describe', 'iam.allowedPolicyMemberDomains',
          `--organization=${org.name.replace(/^organizations\//, '')}`, '--effective', '--format=json']);
        if (policy?.listPolicy?.allowedValues?.length || policy?.booleanPolicy?.enforced) return true;
      }
      return false;
    },
    // No command answers this in advance: a full quota shows up when creating
    // the project, and becomes SETUP-PROJECT-QUOTA there (before any other change).
    canCreateProject: async () => true,
    async findProject() {
      const projects = (await json(['projects', 'list', '--filter=labels.universal-mail=true', '--format=json'])) as Array<{ projectId: string }> ?? [];
      return projects[0]?.projectId;
    },
    async billingLinked(p) {
      return (await json(['billing', 'projects', 'describe', p, '--format=json']))?.billingEnabled === true;
    },
    async servicesReady(p) {
      const enabled = (await json(['services', 'list', '--enabled', project(p), '--format=json'])) as Array<{ name?: string; config?: { name?: string } }> ?? [];
      const names = new Set(enabled.map(s => s.config?.name ?? s.name?.split('/').pop() ?? ''));
      return SERVICES.every(s => names.has(s));
    },
    async budgetExists(_p, account) {
      const budgets = (await json(['billing', 'budgets', 'list', `--billing-account=${account}`, '--format=json'])) as Array<{ displayName?: string }> ?? [];
      return budgets.some(b => b.displayName === budgetName(_p));
    },
    async secretExists(p, name) {
      const r = await run(['secrets', 'describe', name, project(p)]);
      if (r.status === 0) return true;
      if (notFound(r.stderr)) return false;
      throw classify([], r.stderr);
    },
    async readSecret(p, name) {
      const r = await run(['secrets', 'versions', 'access', 'latest', `--secret=${name}`, project(p)]);
      if (r.status === 0) return r.stdout;
      if (notFound(r.stderr)) return undefined;
      throw classify([], r.stderr);
    },
    serverUrl,
    async imageTrusted(image) {
      // Only the official repository, pinned to an exact digest.
      if (!new RegExp(`^${OFFICIAL_IMAGE_REPOSITORY.replace(/[.]/g, '\\.')}@sha256:[0-9a-f]{64}$`).test(image)) return false;
      const r = await run(['artifacts', 'docker', 'images', 'describe', image, '--format=json']);
      return r.status === 0;
    },

    async createProject() {
      const id = options.newProjectId?.() ?? `universal-mail-${randomBytes(3).toString('hex')}`;
      await ok(['projects', 'create', id, '--name=Universal Mail', '--labels=universal-mail=true', '--quiet']);
      return id;
    },
    async linkBilling(p, account) { await ok(['billing', 'projects', 'link', p, `--billing-account=${account}`]); },
    async enableServices(p) { await ok(['services', 'enable', ...SERVICES, project(p)]); },
    async createBudget(p, account, dollars) {
      await ok(['billing', 'budgets', 'create', `--billing-account=${account}`, `--display-name=${budgetName(p)}`,
        `--budget-amount=${dollars}USD`, `--filter-projects=projects/${p}`, '--threshold-rule=percent=0.5', '--threshold-rule=percent=1.0']);
    },
    async putSecret(p, name, value) {
      const created = await run(['secrets', 'create', name, '--replication-policy=automatic', project(p)]);
      if (created.status !== 0 && !alreadyExists(created.stderr)) throw classify(['secrets', 'create', name], created.stderr);
      // The value goes on standard input, never on the command line.
      await ok(['secrets', 'versions', 'add', name, '--data-file=-', project(p)], value);
      // Only the newest two versions stay: six are free, so two secrets never cost anything.
      const listed = await ok(['secrets', 'versions', 'list', name, '--filter=state:enabled', '--format=value(name)', project(p)]);
      const numbers = listed.split('\n').map(line => Number(line.trim().split('/').at(-1))).filter(n => Number.isInteger(n) && n > 0).sort((a, b) => b - a);
      for (const old of numbers.slice(2)) await ok(['secrets', 'versions', 'destroy', String(old), `--secret=${name}`, project(p), '--quiet']);
    },
    async startServer(p, image, settings) {
      const created = await run(['iam', 'service-accounts', 'create', SERVER_IDENTITY, '--display-name=Universal Mail server', project(p)]);
      if (created.status !== 0 && !alreadyExists(created.stderr)) throw classify(['iam', 'service-accounts', 'create'], created.stderr);
      // The server may read its two secrets, add versions and destroy old ones. Nothing else.
      for (const secret of Object.values(settings)) {
        for (const role of ['roles/secretmanager.secretAccessor', 'roles/secretmanager.secretVersionManager']) {
          await ok(['secrets', 'add-iam-policy-binding', secret, `--member=serviceAccount:${identity(p)}`, `--role=${role}`, project(p)]);
        }
      }
      await ok(['run', 'deploy', SERVICE, `--image=${image}`, `--region=${REGION}`, project(p), `--service-account=${identity(p)}`,
        '--allow-unauthenticated', '--max-instances=1',
        `--set-secrets=${Object.entries(settings).map(([env, secret]) => `${env}=${secret}:latest`).join(',')}`, '--quiet']);
      const url = await serverUrl(p);
      if (!url) throw new GcloudError(['run', 'services', 'describe'], 1, 'the server started but reported no address');
      await updateUrl(p, url);
      return url;
    },
    async currentProject() {
      const current = (await ok(['config', 'get-value', 'project'])).trim();
      return !current || current === '(unset)' ? undefined : current;
    },
    // Version 1's service (its deploy script: yahoo-mail-mcp, us-central1), and its Sent mode.
    async v1Service(p) {
      const r = await run(['run', 'services', 'describe', 'yahoo-mail-mcp', `--region=${REGION}`, project(p), '--format=json']);
      if (r.status !== 0) { if (notFound(r.stderr)) return undefined; throw classify([], r.stderr); }
      const env = (JSON.parse(r.stdout)?.spec?.template?.spec?.containers?.[0]?.env ?? []) as Array<{ name: string; value?: string }>;
      const mode = env.find(e => e.name === 'SENT_COPY_MODE')?.value;
      return { sentCopyMode: mode === 'yahoo' || mode === 'append' ? mode : 'unverified' };
    },
    async labelProject(p) { await ok(['projects', 'update', p, '--update-labels=universal-mail=true']); },
    async serverImage(p) {
      const r = await run(['run', 'services', 'describe', SERVICE, `--region=${REGION}`, project(p), '--format=value(spec.template.spec.containers[0].image)']);
      if (r.status !== 0) { if (notFound(r.stderr)) return undefined; throw classify([], r.stderr); }
      return r.stdout.trim() || undefined;
    },
    async deleteBudget(p, account) {
      const budgets = (await json(['billing', 'budgets', 'list', `--billing-account=${account}`, '--format=json'])) as Array<{ name?: string; displayName?: string }> ?? [];
      // Only our own alarm, found by its name.
      for (const budget of budgets.filter(b => b.displayName === budgetName(p) && b.name)) {
        await ok(['billing', 'budgets', 'delete', budget.name!.split('/').at(-1)!, `--billing-account=${account}`, '--quiet']);
      }
    },
    async deleteProject(p) { await ok(['projects', 'delete', p, '--quiet']); },
    async restartServer(p, now) {
      await ok(['run', 'services', 'update', SERVICE, `--region=${REGION}`, project(p), `--update-env-vars=SETTINGS_SAVED_AT=${new Date(now).toISOString()}`, '--quiet']);
    },
    updateUrl
  };
  return google;
}
