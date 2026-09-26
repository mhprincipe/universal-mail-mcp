import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { diagnoseOAuth } from './oauth-diagnostics.js';
import { createTokenVerifier, loadOAuthConfig, requiredScopes } from '../src/oauth.js';
import { callReadTool, expectedTools } from './verification-client.js';

// No dotenv, token arguments, or raw exceptions. Public checks are the default.
const resource = process.env.OAUTH_RESOURCE ?? (() => { throw new Error('Set OAUTH_RESOURCE to the v1 MCP address.'); })();
const issuer = process.env.OAUTH_ISSUER ?? (() => { throw new Error('Set OAUTH_ISSUER to the v1 Auth0 issuer.'); })();
const token = process.env.OAUTH_TEST_TOKEN;
const headers = { Authorization: `Bearer ${token ?? ''}` };
const client = new Client({ name: 'oauth-diagnostic-client', version: '1' });
const startedAt = new Date().toISOString();
const report = await diagnoseOAuth({ resource, issuer, token, owner: process.env.OAUTH_OWNER_SUB, clients: process.env.OAUTH_CLIENT_IDS, oidc: true, mailbox: process.env.LIVE_READ_CONFIRMED === 'yes' }, {
  request: (url, init) => fetch(url, init),
  verify: async (value, jwksUri) => {
    const config = loadOAuthConfig({ AUTH_MODE: 'oauth', OAUTH_RESOURCE: resource, OAUTH_ISSUER: issuer, OAUTH_JWKS_URI: jwksUri, OAUTH_OWNER_SUB: process.env.OAUTH_OWNER_SUB, OAUTH_CLIENT_IDS: process.env.OAUTH_CLIENT_IDS })!;
    return createTokenVerifier(config)(value);
  },
  session: () => ({
    initialize: () => client.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers, redirect: 'error' } }), { timeout: 30000 }),
    tools: async () => {
      const tools = (await client.listTools({}, { timeout: 30000 })).tools;
      assert.deepEqual(tools.map(t => t.name).sort(), expectedTools);
      for (const tool of tools) assert.deepEqual(tool._meta?.securitySchemes, [{ type: 'oauth2', scopes: requiredScopes(tool.name) }]);
    },
    mailbox: async () => {
      const r = await fetch(new URL('/ready', resource), { headers, redirect: 'error', signal: AbortSignal.timeout(90000) });
      assert.equal(r.status, 200); const body = await r.json(); assert(body.status === 'ready' && body.imap && body.smtp);
      await callReadTool(client, 'list_folders', {}, 90000);
    },
    close: () => client.close()
  })
});
mkdirSync('verification', { recursive: true });
const output = JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), mode: token ? 'authenticated-diagnostics' : 'public-diagnostics', ...report }, null, 2);
writeFileSync('verification/oauth-diagnostics-latest.json', output + '\n');
writeFileSync(`verification/oauth-diagnostics-${startedAt.replace(/[:.]/g, '-')}.json`, output + '\n');
console.log(output);
process.exitCode = report.status === 'FAIL' ? 1 : 0;
