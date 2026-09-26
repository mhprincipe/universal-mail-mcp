import { expect, it } from 'vitest';
import { deploymentArgs } from '../scripts/oauth-deployment.js';
const config = { project: 'yahoo-mail-mcp', region: 'us-central1', service: 'yahoo-mail-mcp', resource: 'https://mail.example/mcp', issuer: 'https://identity.example/' };
it('setup exposes discovery with no mailbox credentials and bounded resources', () => {
  const args = deploymentArgs(config, 'setup');
  expect(args).toContain('--clear-secrets');
  expect(args).toContain('--timeout=300');
  expect(args).toContain('--min=0'); expect(args).toContain('--max=1');
  expect(args).toContain('--cpu=1'); expect(args).toContain('--memory=512Mi');
  expect(args.join(' ')).toContain('AUTH_MODE=oauth-setup');
  expect(args.join(' ')).toContain('ALLOWED_HOSTS=mail.example');
  expect(args.join(' ')).toContain('SENT_COPY_MODE=unverified');
  expect(args.join(' ')).not.toContain('yahoo-app-password:latest');
});
it('active mode requires exact identities and excludes the legacy secret', () => {
  expect(() => deploymentArgs(config, 'activate')).toThrow();
  const args = deploymentArgs({ ...config, owner: 'auth0|owner', clients: 'chatgpt,claude' }, 'activate');
  expect(args.join(' ')).toContain('AUTH_MODE=oauth');
  expect(args.join(' ')).toContain('OAUTH_OWNER_SUB=auth0|owner');
  expect(args.join(' ')).toContain('OAUTH_CLIENT_IDS=chatgpt,claude');
  expect(args.join(' ')).not.toContain('yahoo-mcp-access-secret:latest');
  expect(args.join(' ')).toContain('YAHOO_APP_PASSWORD=yahoo-app-password:latest');
});
it.each([{ resource: 'http://mail.example/mcp' }, { resource: 'https://mail.example/wrong' }, { owner: '*', clients: 'client' }, { owner: 'owner', clients: '*' }, { owner: 'owner~injected', clients: 'client' }])('rejects unsafe deployment inputs %j', bad => {
  expect(() => deploymentArgs({ ...config, owner: 'owner', clients: 'client', ...bad }, 'activate')).toThrow();
});
const envOf = (args: string[]) => Object.fromEntries(args.find(a => a.startsWith('--set-env-vars='))!
  .replace('--set-env-vars=^~^', '').split('~').map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
const active = { ...config, owner: 'auth0|owner', clients: 'claude' };
it('carries a verified Sent-copy mode and allowed origins through activation', () => {
  // These were hardcoded, so every redeploy silently re-disabled sending and
  // erased the origins a browser-based client needs.
  const env = envOf(deploymentArgs({ ...active, sentCopyMode: 'yahoo', allowedOrigins: 'claude.ai,claude.com' }, 'activate'));
  expect(env.SENT_COPY_MODE).toBe('yahoo');
  expect(env.ALLOWED_ORIGINS).toBe('claude.ai,claude.com');
});
it('still defaults to sending disabled and no origins when unspecified', () => {
  const env = envOf(deploymentArgs(active, 'activate'));
  expect(env.SENT_COPY_MODE).toBe('unverified');
  expect(env.ALLOWED_ORIGINS).toBe('');
});
it('setup mode forces sending disabled even when a verified mode is supplied', () => {
  const env = envOf(deploymentArgs({ ...config, sentCopyMode: 'yahoo', allowedOrigins: 'claude.ai' }, 'setup'));
  expect(env.SENT_COPY_MODE).toBe('unverified');
  expect(env.ALLOWED_ORIGINS).toBe('');
});
it.each(['bogus', 'UNVERIFIED', 'yahoo append'])('rejects an unknown Sent-copy mode %s', sentCopyMode => {
  expect(() => deploymentArgs({ ...active, sentCopyMode }, 'activate')).toThrow();
});
it.each(['https://claude.ai', 'claude.ai/path', 'claude ai', '*'])('rejects an origin that is not a bare hostname %s', allowedOrigins => {
  expect(() => deploymentArgs({ ...active, allowedOrigins }, 'activate')).toThrow();
});
