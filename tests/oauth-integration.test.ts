import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { MailService } from '../src/yahoo/mailService.js';
import { requiredScopes } from '../src/oauth.js';
import { success } from '../src/errors.js';
import { diagnoseOAuth } from '../scripts/oauth-diagnostics.js';
import { createTokenVerifier, loadOAuthConfig } from '../src/oauth.js';
import { expectedTools, callReadTool } from '../scripts/verification-client.js';

const env = { AUTH_MODE: 'oauth', OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URI: 'https://identity.example/keys', OAUTH_RESOURCE: 'https://mail.example/mcp', OAUTH_OWNER_SUB: 'owner', OAUTH_CLIENT_IDS: 'chatgpt,claude', YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'legacy-secret-at-least-24-characters' };
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'first' };
const realFetch = globalThis.fetch;
const servers: Server[] = [];
const clients: Client[] = [];
async function signed(scope = 'mail.read', azp = 'chatgpt', overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: env.OAUTH_ISSUER, aud: env.OAUTH_RESOURCE, sub: 'owner', azp, scope, iat: now, exp: now + 300, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'first' }).sign(keys.privateKey);
}
async function start(settings = env) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === env.OAUTH_JWKS_URI) return Response.json({ keys: [jwk] });
    if (!String(input).startsWith('http://127.0.0.1:')) throw new Error('UNEXPECTED_EXTERNAL_IO');
    return realFetch(input, init);
  });
  const server = createApp(settings).listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function connect(base: string, token: string) {
  const client = new Client({ name: 'signed-token-fixture', version: '1' }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function post(base: string, token: string, body: unknown) {
  return fetch(base + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); })));
  vi.restoreAllMocks();
});
it('setup mode publishes discovery without any owner, client, or Yahoo credentials and denies all protected requests', async () => {
  const base = await start({ ...env, AUTH_MODE: 'oauth-setup', OAUTH_OWNER_SUB: '', OAUTH_CLIENT_IDS: '', YAHOO_EMAIL: '', YAHOO_APP_PASSWORD: '' });
  expect((await fetch(base + '/.well-known/oauth-protected-resource/mcp')).status).toBe(200);
  for (const path of ['/ready', '/mcp']) for (const token of [await signed(), env.MCP_ACCESS_SECRET, '']) {
    const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(401); expect(r.headers.get('www-authenticate')).toContain('resource_metadata');
  }
});
it.each(['chatgpt', 'claude'])('accepts real signed tokens through the MCP client for %s and advertises all tool scopes', async azp => {
  const folders = vi.spyOn(MailService.prototype, 'listFolders').mockResolvedValue(success([]));
  const client = await connect(await start(), await signed('mail.read', azp));
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(16);
  for (const tool of tools) expect(tool._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: requiredScopes(tool.name) }]);
  expect((await client.callTool({ name: 'list_folders', arguments: {} })).isError).not.toBe(true);
  expect(folders).toHaveBeenCalledOnce();
});
it('keeps concurrent read and write identities separate and allows a signed writer through MCP', async () => {
  const write = vi.spyOn(MailService.prototype, 'createFolder').mockResolvedValue(success({ path: 'Fixture', created: true }));
  const base = await start();
  const reader = await signed(); const writer = await signed('mail.read mail.write', 'claude');
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => post(base, i % 2 ? reader : writer, { jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'create_folder', arguments: { path: 'Fixture' } } })));
  for (let i = 0; i < responses.length; i++) { expect(responses[i]!.status).toBe(i % 2 ? 403 : 200); await responses[i]!.body?.cancel(); }
  expect(write).toHaveBeenCalledTimes(6);
});
it('rejects old secrets, wrong owners, missing scopes and malformed calls without dispatch', async () => {
  const write = vi.spyOn(MailService.prototype, 'createFolder');
  const base = await start();
  for (const token of [env.MCP_ACCESS_SECRET, await signed('mail.read', 'chatgpt', { sub: 'other' })]) expect((await post(base, token, { method: 'tools/list' })).status).toBe(401);
  expect((await post(base, await signed(''), { method: 'tools/list' })).status).toBe(403);
  for (const body of [[], [{ method: 'tools/call' }], { method: 'tools/call', params: null }, { method: 'tools/call', params: { name: 'unknown' } }]) expect((await post(base, await signed(), body)).status).toBe(400);
  expect(write).not.toHaveBeenCalled();
});
it('runs staged diagnostics against the real HTTP app, verifier and MCP SDK with a signed token', async () => {
  const folders = vi.spyOn(MailService.prototype, 'listFolders').mockResolvedValue(success([]));
  const base = await start();
  const client = new Client({ name: 'diagnostic-integration', version: '1' }); clients.push(client);
  const token = await signed();
  const result = await diagnoseOAuth({ resource: env.OAUTH_RESOURCE, issuer: env.OAUTH_ISSUER, owner: 'owner', clients: 'chatgpt', token, oidc: true, mailbox: true }, {
    request: async (url, init) => {
      if (url === env.OAUTH_ISSUER + '.well-known/openid-configuration') return Response.json({ issuer: env.OAUTH_ISSUER, jwks_uri: env.OAUTH_JWKS_URI, authorization_endpoint: env.OAUTH_ISSUER + 'authorize', token_endpoint: env.OAUTH_ISSUER + 'token', userinfo_endpoint: env.OAUTH_ISSUER + 'userinfo', code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });
      if (url === env.OAUTH_ISSUER + 'userinfo') return Response.json({ sub: 'owner' });
      if (url === env.OAUTH_JWKS_URI) return Response.json({ keys: [jwk] });
      return fetch(url.replace('https://mail.example', base), init);
    },
    verify: createTokenVerifier(loadOAuthConfig(env)!),
    session: () => ({
      initialize: () => client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })),
      tools: async () => { expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(expectedTools); },
      mailbox: async () => { await callReadTool(client, 'list_folders', {}); },
      close: () => client.close()
    })
  });
  expect(result.stages.filter(s => !['chatgpt', 'claude'].includes(s.name)).every(s => s.status === 'PASS')).toBe(true);
  expect(result.status).toBe('INCOMPLETE'); // Provider/browser and real Yahoo were fixture substitutes.
  expect(folders).toHaveBeenCalledOnce();
});
