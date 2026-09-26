import { afterEach, expect, it, vi } from 'vitest';
import { request, type Server } from 'node:http';
import { createApp } from '../src/app.js';
import * as oauth from '../src/oauth.js';
import { MailService } from '../src/yahoo/mailService.js';
const env = { AUTH_MODE: 'oauth', OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URI: 'https://identity.example/keys', OAUTH_RESOURCE: 'https://mail.example/mcp', OAUTH_OWNER_SUB: 'owner', OAUTH_CLIENT_IDS: 'chatgpt,claude', YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password' };
const servers: Server[] = [];
async function start(scopes = ['mail.read']) {
  vi.spyOn(oauth, 'createTokenVerifier').mockReturnValue(async token => {
    if (token !== 'signed-fixture') throw new Error('private provider error');
    return { scopes };
  });
  const server = createApp(env).listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); });
it('publishes public discovery and a pinned challenge without mailbox information', async () => {
  const base = await start();
  const discovery = await fetch(base + '/.well-known/oauth-protected-resource/mcp');
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toMatchObject({ resource: env.OAUTH_RESOURCE, authorization_servers: [env.OAUTH_ISSUER] });
  const denied = await fetch(base + '/mcp');
  expect(denied.status).toBe(401);
  expect(denied.headers.get('www-authenticate')).toContain('https://mail.example/.well-known/oauth-protected-resource/mcp');
  expect(await denied.text()).not.toContain('provider');
});
it('allows readiness with read scope and no static secret', async () => {
  const check = vi.spyOn(MailService.prototype, 'verifyConnectivity').mockResolvedValue({ imap: true, smtp: true, folders: 1 });
  const response = await fetch(await start() + '/ready', { headers: { Authorization: 'Bearer signed-fixture' } });
  expect(response.status).toBe(200); expect(check).toHaveBeenCalledOnce();
});
it.each(['trash_email', 'create_draft', 'send_email', 'reply_email'])('rejects %s without its scope before mail access', async name => {
  const response = await fetch(await start() + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer signed-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) });
  expect(response.status).toBe(403);
  expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
});
it('rejects batched calls so a write cannot hide behind a read', async () => {
  const response = await fetch(await start() + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer signed-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_email' } }]) });
  expect(response.status).toBe(400);
});
function statusWith(url: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method, headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
}
it('keeps credential-free discovery reachable for browser-origin clients', async () => {
  // RFC 9728 metadata carries no credentials; DNS-rebinding protection belongs on
  // the mailbox endpoints, not on the document that tells a client where to log in.
  const base = await start();
  expect(await statusWith(base + '/.well-known/oauth-protected-resource/mcp', { Origin: 'https://chatgpt.com' })).toBe(200);
  expect(await statusWith(base + '/.well-known/oauth-protected-resource', { Origin: 'https://claude.ai' })).toBe(200);
});
it('still rejects a foreign Origin on the protected endpoints', async () => {
  const base = await start();
  expect(await statusWith(base + '/mcp', { Origin: 'https://attacker.invalid', Authorization: 'Bearer signed-fixture' }, 'POST')).toBe(403);
  expect(await statusWith(base + '/ready', { Origin: 'https://attacker.invalid', Authorization: 'Bearer signed-fixture' })).toBe(403);
});
it('advertises offline_access so a client requests a refresh token', async () => {
  // Access tokens are capped at 900 seconds, so a connector without a refresh
  // token stops working 15 minutes after consent.
  const metadata = await (await fetch(await start() + '/.well-known/oauth-protected-resource/mcp')).json();
  expect(metadata.scopes_supported).toContain('offline_access');
});
