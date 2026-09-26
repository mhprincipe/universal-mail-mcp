import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deploymentArgs, type Deployment } from './oauth-deployment.js';
import { releaseOAuth } from './oauth-release.js';

// v1's settings are yours to give; none are built in.
const required = (name: string) => process.env[name] ?? (() => { throw new Error(`Set ${name}.`); })();
const mode = process.argv[2];
if (mode !== 'setup' && mode !== 'activate') throw new Error('Usage: node dist/scripts/deploy-oauth.js setup|activate [--apply]');
const input: Deployment = {
  project: required('PROJECT'), region: process.env.REGION ?? 'us-central1', service: required('SERVICE'),
  resource: required('OAUTH_RESOURCE'),
  issuer: required('OAUTH_ISSUER'),
  owner: process.env.OAUTH_OWNER_SUB, clients: process.env.OAUTH_CLIENT_IDS,
  sentCopyMode: process.env.SENT_COPY_MODE, allowedOrigins: process.env.ALLOWED_ORIGINS
};
const args = deploymentArgs(input, mode);
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ mode, project: input.project, resource: input.resource, issuer: input.issuer, mailboxAccess: mode === 'setup' ? 'denied for everyone' : 'owner and approved clients only', sending: 'disabled', timeoutSeconds: 300, applyCommand: `node dist/scripts/deploy-oauth.js ${mode} --apply` }, null, 2));
} else {
  // Public preflight: fetch only the pinned provider's discovery, never mailbox data or tokens.
  const provider = await fetch(new URL('/.well-known/openid-configuration', input.issuer), { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!provider.ok) throw new Error('Issuer discovery unavailable; deployment not started');
  const metadata = await provider.json() as { issuer?: string; jwks_uri?: string };
  if (metadata.issuer !== input.issuer || metadata.jwks_uri !== new URL('/.well-known/jwks.json', input.issuer).href) throw new Error('Issuer metadata mismatch; deployment not started');
  const shared = [`--project=${input.project}`, `--region=${input.region}`];
  const previous = JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe', input.service, ...shared, '--format=json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { status: { url: string; traffic: { revisionName?: string; percent?: number }[] } };
  if (previous.status.url + '/mcp' !== input.resource) throw new Error('Cloud Run canonical URL differs; deployment not started');
  const traffic = previous.status.traffic.filter(t => t.percent).map(t => ({ revision: t.revisionName, percent: t.percent }));
  if (!traffic.length || traffic.some(t => !t.revision) || traffic.reduce((n, t) => n + t.percent!, 0) !== 100) throw new Error('Cannot record rollback traffic; deployment not started');
  mkdirSync('verification', { recursive: true });
  const record = `verification/oauth-rollback-${Date.now()}.json`;
  writeFileSync(record, JSON.stringify({ capturedAt: new Date().toISOString(), project: input.project, region: input.region, service: input.service, traffic }, null, 2));
  console.log(`Saved revision-only rollback record: ${record}`);
  await releaseOAuth(() => {
    // Cloud Shell uses npm directly; npm-run invocations can use its resolved CLI.
    if (process.env.npm_execpath) execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'verify'], { stdio: 'inherit' });
    else execFileSync('npm', ['run', 'verify'], { stdio: 'inherit' });
  }, () => { execFileSync('gcloud', args, { stdio: 'inherit' }); }, async () => {
  execFileSync(process.execPath, ['dist/scripts/diagnose-oauth.js'], { stdio: 'inherit', env: { ...process.env, OAUTH_RESOURCE: input.resource, OAUTH_ISSUER: input.issuer, OAUTH_TEST_TOKEN: '', LIVE_READ_CONFIRMED: '' } });
  const base = new URL(input.resource).origin;
  const discovery = await fetch(base + '/.well-known/oauth-protected-resource/mcp', { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!discovery.ok) throw new Error('Deployment completed but public OAuth discovery failed; inspect before continuing');
  const resource = await discovery.json() as { resource?: string; authorization_servers?: string[] };
  if (resource.resource !== input.resource || resource.authorization_servers?.[0] !== input.issuer) throw new Error('Deployed metadata mismatch');
  for (const path of ['/mcp', '/ready']) {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (r.status !== 401 || !r.headers.get('www-authenticate')?.includes(base + '/.well-known/oauth-protected-resource/mcp')) throw new Error(`Protected route check failed: ${path}`);
    await r.body?.cancel();
  }
  console.log('PASS: public OAuth discovery and unauthenticated rejection. This does not prove client login or authenticated mailbox access.');
  });
}
