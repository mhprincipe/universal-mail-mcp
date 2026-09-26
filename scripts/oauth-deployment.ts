import { loadOAuthConfig } from '../src/oauth.js';

export type Deployment = { project: string; region: string; service: string; resource: string; issuer: string; owner?: string; clients?: string; sentCopyMode?: string; allowedOrigins?: string };
const sentModes = new Set(['unverified', 'yahoo', 'append']);
const hostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
export function deploymentArgs(input: Deployment, mode: 'setup' | 'activate'): string[] {
  for (const value of Object.values(input)) if (value && /[~\r\n]/.test(value)) throw new Error('Invalid configuration delimiter');
  for (const value of [input.project, input.region, input.service]) if (!/^[a-z][a-z0-9-]+$/.test(value)) throw new Error('Invalid cloud identifier');
  const issuer = new URL(input.issuer);
  if (!input.issuer.endsWith('/') || issuer.pathname !== '/') throw new Error('Issuer must be the tenant HTTPS origin with trailing slash');
  // Setup mode denies everything, so it always ships with sending off and no
  // origins. Activation carries the operator's verified values instead of
  // resetting them, which previously re-closed the Sent gate on every deploy.
  const sentCopyMode = mode === 'setup' ? 'unverified' : (input.sentCopyMode?.trim() || 'unverified');
  if (!sentModes.has(sentCopyMode)) throw new Error('Unknown Sent-copy mode');
  const allowedOrigins = mode === 'setup' ? '' : (input.allowedOrigins?.trim() || '');
  for (const host of allowedOrigins.split(',').map(x => x.trim()).filter(Boolean)) {
    if (!hostname.test(host)) throw new Error('Allowed origins must be bare hostnames');
  }
  const env = {
    NODE_ENV: 'production', MAX_MESSAGE_BYTES: '20971520', SENT_COPY_MODE: sentCopyMode,
    AUTH_MODE: mode === 'setup' ? 'oauth-setup' : 'oauth',
    OAUTH_ISSUER: input.issuer, OAUTH_JWKS_URI: new URL('/.well-known/jwks.json', issuer).href,
    OAUTH_RESOURCE: input.resource, OAUTH_OWNER_SUB: mode === 'setup' ? '' : input.owner ?? '',
    OAUTH_CLIENT_IDS: mode === 'setup' ? '' : input.clients ?? '',
    ALLOWED_HOSTS: new URL(input.resource).hostname, ALLOWED_ORIGINS: allowedOrigins
  };
  loadOAuthConfig(env);
  return ['run', 'deploy', input.service, '--source=.', `--project=${input.project}`, `--region=${input.region}`,
    `--service-account=yahoo-mail-mcp@${input.project}.iam.gserviceaccount.com`, '--allow-unauthenticated',
    '--min=0', '--max=1', '--cpu=1', '--memory=512Mi', '--concurrency=8', '--timeout=300',
    // Replace the complete environment deliberately: no stale legacy credential or auth switch survives.
    '--set-env-vars=^~^' + Object.entries(env).map(([key, value]) => `${key}=${value}`).join('~'),
    mode === 'setup' ? '--clear-secrets' : '--set-secrets=YAHOO_EMAIL=yahoo-email:latest,YAHOO_APP_PASSWORD=yahoo-app-password:latest'];
}
