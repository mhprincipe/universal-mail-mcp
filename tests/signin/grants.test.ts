import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { success } from '../../src/errors.js';
import { generateSigninKeys } from '../../src/signin/authorization.js';
import type { Action } from '../../src/signin/grants.js';
import { createSigninApp } from '../../src/signin/server.js';
import { MailService } from '../../src/yahoo/mailService.js';
import { createFakeClock } from '../../testkit/src/fakeClock.js';

const issuer = 'https://mail.example';
const key = 'grants-test-key-0123456789';
const apps: Record<string, { callback: string; name: string }> = {
  'https://claude.ai/oauth/mcp-oauth-client-metadata': { callback: 'https://claude.ai/api/mcp/auth_callback', name: 'Claude' },
  'https://chatgpt.com/oauth/client.json': { callback: 'https://chatgpt.com/connector_platform_oauth_redirect', name: 'ChatGPT' }
};
const [claude, chatgpt] = Object.keys(apps) as [string, string];
const account = (name: string) => ({ name, email: `${name}@example.invalid`, sentCopyMode: 'append', imap: { host: '127.0.0.1', port: 993, tls: 'implicit' }, smtp: { host: '127.0.0.1', port: 587 } });

let server: Server;
let base: string;
let signin: ReturnType<typeof createSigninApp>['signin'];
const clients: Client[] = [];

beforeEach(async () => {
  // The mail itself is faked: these tests are about who may reach it.
  vi.spyOn(MailService.prototype, 'listFolders').mockResolvedValue(success([{ path: 'INBOX', selectable: true }]));
  vi.spyOn(MailService.prototype, 'searchEmail').mockImplementation(async function (this: MailService) {
    return success([{ mailbox: 'INBOX', uid: 1, from: [], to: [], read: false, flagged: false, untrustedContent: true as const }]);
  });
  vi.spyOn(MailService.prototype, 'moveEmail').mockResolvedValue(success({ moved: true }) as never);
  vi.spyOn(MailService.prototype, 'sendEmail').mockResolvedValue(success({ sent: true }) as never);
  const app = createSigninApp({
    AUTH_MODE: 'builtin', SIGNIN_ISSUER: issuer, SIGNIN_KEY: key, SIGNIN_ADDRESS: 'owner@example.invalid',
    MAIL_ACCOUNTS: JSON.stringify(['personal', 'work', 'family'].map(account)),
    MAIL_PASSWORDS: JSON.stringify({ personal: 'password-1', work: 'password-2', family: 'password-3' })
  }, {
    clock: createFakeClock(new Date()), keys: await generateSigninKeys(),
    documents: {
      resolve: async () => ['160.79.104.10'],
      get: async (url: URL) => ({ status: 200, body: JSON.stringify({ client_id: url.href, client_name: apps[url.href]!.name, redirect_uris: [apps[url.href]!.callback] }) })
    }
  });
  signin = app.signin;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  vi.restoreAllMocks();
});

// Connect an app the way the approval page will: begin, approve with a grant, exchange the code.
async function connect(appId: string, accounts: Record<string, Action[]>) {
  const verifier = randomBytes(32).toString('base64url');
  const begun = await signin.auth.begin({
    response_type: 'code', client_id: appId, redirect_uri: apps[appId]!.callback,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
  });
  if (!begun.ok) throw new Error(`refused: ${begun.error}`);
  const code = new URL(await signin.auth.approve(begun.request, accounts)).searchParams.get('code')!;
  const tokens = await signin.auth.token({ grant_type: 'authorization_code', code, redirect_uri: apps[appId]!.callback, client_id: appId, code_verifier: verifier });
  return tokens.body.access_token as string;
}

async function mcp(token: string) {
  const client = new Client({ name: 'grants-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/${key}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(client);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as any,
    accountHelp: async () => {
      const tools = (await client.listTools()).tools;
      return (tools.find(t => t.name === 'list_folders')!.inputSchema as any).properties.account.description as string;
    }
  };
}
const status = async (token: string) => (await fetch(`${base}/${key}/mcp`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
})).status;

describe('grants', () => {
  it('SIG-30 a request is allowed only for accounts and actions in the app\'s current grant', async () => {
    const app = await mcp(await connect(claude, { personal: ['read'], work: ['read', 'organize'] }));
    expect(await app.call('list_folders', { account: 'personal' })).toMatchObject({ ok: true });
    expect(await app.call('list_folders', { account: 'family' })).toMatchObject({
      code: 'MAIL-ACCOUNT-UNKNOWN', message: "There's no account called 'family'. Your accounts are: personal, work."
    });
    expect(await app.call('move_email', { account: 'personal', mailbox: 'INBOX', uid: 1, destination: 'Archive' })).toMatchObject({
      code: 'MAIL-NOT-PERMITTED', message: "This app isn't allowed to organize mail in personal. You can change that on your Universal Mail page."
    });
    expect(await app.call('move_email', { account: 'work', mailbox: 'INBOX', uid: 1, destination: 'Archive' })).toMatchObject({ ok: true });
    expect(await app.call('send_email', { account: 'work', to: ['x@example.invalid'], subject: 's', text: 't' })).toMatchObject({ code: 'MAIL-NOT-PERMITTED' });
    const found = await app.call('search_email', { mailbox: 'INBOX' });
    expect(found.data.map((row: { account: string }) => row.account).sort()).toEqual(['personal', 'work']);
  });

  it('SIG-31 changing a grant takes effect on the next request, without reconnecting', async () => {
    const app = await mcp(await connect(claude, { personal: ['read'] }));
    const move = { account: 'personal', mailbox: 'INBOX', uid: 1, destination: 'Archive' };
    expect(await app.call('move_email', move)).toMatchObject({ code: 'MAIL-NOT-PERMITTED' });
    signin.grants.update(claude, { personal: ['read', 'organize'] });
    expect(await app.call('move_email', move)).toMatchObject({ ok: true });
    signin.grants.update(claude, { personal: ['read'] });
    expect(await app.call('move_email', move)).toMatchObject({ code: 'MAIL-NOT-PERMITTED' });
  });

  it('SIG-32 disconnecting takes effect on the next request, and a later reconnection does not revive old tokens', async () => {
    const old = await connect(claude, { personal: ['read'] });
    expect(await status(old)).toBe(200);
    signin.grants.disconnect(claude);
    expect(await status(old)).toBe(401);
    const fresh = await connect(claude, { personal: ['read'] });
    expect(await status(fresh)).toBe(200);
    expect(await status(old)).toBe(401);
  });

  it('SIG-33 one app\'s token can\'t use another app\'s grant', async () => {
    const claudeApp = await mcp(await connect(claude, { personal: ['read'] }));
    const chatgptApp = await mcp(await connect(chatgpt, { family: ['read'] }));
    expect(await claudeApp.call('list_folders', { account: 'family' })).toMatchObject({ code: 'MAIL-ACCOUNT-UNKNOWN' });
    expect(await chatgptApp.call('list_folders', { account: 'family' })).toMatchObject({ ok: true });
    expect(await chatgptApp.call('list_folders', { account: 'personal' })).toMatchObject({ code: 'MAIL-ACCOUNT-UNKNOWN' });
  });

  it('SIG-34 the tool list names only the accounts the app was granted', async () => {
    const app = await mcp(await connect(claude, { personal: ['read'], work: ['read'] }));
    const help = await app.accountHelp();
    expect(help).toContain('personal');
    expect(help).toContain('work');
    expect(help).not.toContain('family');
  });

  it('SIG-31 permissions can only be changed for an app that is connected', async () => {
    expect(() => signin.grants.update(claude, { personal: ['read'] })).toThrow(/No connection/);
    expect(signin.grants.get(claude)).toBeUndefined();
  });

  it('SIG-35 an account added to a grant appears without a new token', async () => {
    const app = await mcp(await connect(claude, { personal: ['read'] }));
    expect(await app.accountHelp()).not.toContain('family');
    signin.grants.update(claude, { personal: ['read'], family: ['read'] });
    expect(await app.accountHelp()).toContain('family');
    expect(await app.call('list_folders', { account: 'family' })).toMatchObject({ ok: true });
  });
});
