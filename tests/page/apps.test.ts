import { request } from 'node:http';
import { SignJWT, importJWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY, PUBLIC_URL, startPage } from './pageHarness.js';

// Your page: connected apps (design §3.6).
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const chatgpt = 'https://chatgpt.com/oauth/client.json';

// An MCP request as Claude makes it: its access token, to the service's own host.
async function mcpRequest(page: NonNullable<typeof p>, appId: string, connection: number): Promise<number> {
  const key = await importJWK(page.records.credentials.signingKey as never, 'ES256');
  const now = Math.floor(page.clock.now() / 1000);
  const token = await new SignJWT({ client_id: appId, grant_version: connection }).setProtectedHeader({ alg: 'ES256' })
    .setIssuer(PUBLIC_URL).setAudience(`${PUBLIC_URL}/${KEY}/mcp`).setIssuedAt(now).setExpirationTime(now + 600).setJti(`j-${now}`).sign(key);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(new URL(page.base).port), method: 'POST', path: `/${KEY}/mcp`,
      headers: { host: new URL(PUBLIC_URL).host, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
    res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject);
    req.end(body);
  });
}

describe('connected apps on your page', () => {
  it('PG-06 permissions change per app and per account; you are told', async () => {
    p = await startPage();
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    p.app.signin!.grants.connect(chatgpt, 'ChatGPT', { work: ['read'] });
    await p.signIn();
    await p.act('/apps/permissions', { app: claude, 'me:read': 'on', 'me:organize': 'on', 'work:read': 'on' });
    expect(p.app.signin!.grants.get(claude)!.accounts).toEqual({ me: ['read', 'organize'], work: ['read'] });
    // The other app is untouched.
    expect(p.app.signin!.grants.get(chatgpt)!.accounts).toEqual({ work: ['read'] });
    expect(p.sent.at(-1)!.subject).toBe('Claude\'s permissions changed');
  });

  it('PG-06 giving Send needs your fingerprint; nothing at all is refused (disconnect instead)', async () => {
    p = await startPage();
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.signIn();
    const send = await p.act('/apps/permissions', { app: claude, 'me:read': 'on', 'me:send': 'on' });
    expect(send.html).toContain('Giving Send needs your fingerprint');
    expect(p.app.signin!.grants.get(claude)!.accounts).toEqual({ me: ['read'] });
    const none = await p.act('/apps/permissions', { app: claude });
    expect(none.html).toContain('Choose at least one account, or disconnect the app instead');
    expect(p.app.signin!.grants.get(claude)!.accounts).toEqual({ me: ['read'] });
  });

  it('PG-07 an app can be disconnected: its next request is refused, and you are told', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    expect(await mcpRequest(p, claude, grant.connection)).toBe(200);
    await p.signIn();
    const page = await p.act('/apps/disconnect', { app: claude });
    expect(page.html).toContain('Claude was disconnected');
    expect(page.html).toContain('No apps are connected yet');
    expect(await mcpRequest(p, claude, grant.connection)).toBe(401);
    expect(p.sent.at(-1)!.subject).toBe('Claude was disconnected from your email');
  });

  it('PG-17 "last used" per app comes from its requests', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.signIn();
    expect((await p.get()).html).toContain('not used yet');
    expect(await mcpRequest(p, claude, grant.connection)).toBe(200);
    p.clock.advance(5 * 60_000);
    expect((await p.get()).html).toContain('last used 5 minutes ago');
  });
});
