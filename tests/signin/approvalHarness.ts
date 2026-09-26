import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { generateSigninKeys } from '../../src/signin/authorization.js';
import { createSigninApp } from '../../src/signin/server.js';
import { createFakeClock } from '../../testkit/src/fakeClock.js';

export const issuer = 'https://mail.example';
export const key = 'approval-test-key-0123456789';
export const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const callback = 'https://claude.ai/api/mcp/auth_callback';
const account = (name: string) => ({ name, email: `${name}@example.invalid`, sentCopyMode: 'append', imap: { host: '127.0.0.1', port: 993, tls: 'implicit' }, smtp: { host: '127.0.0.1', port: 587 } });

export type Sent = { account: string; to: string; subject: string; text: string };

// The sign-in app with every outside dependency faked: DNS, the identity
// document, keys, time, and the system emails (captured, not sent).
export async function startApproval(clientName = 'Claude') {
  const sent: Sent[] = [];
  const discarded: string[] = [];
  // Accounts whose sending is broken, for the dead-end tests.
  const broken = new Set<string>();
  const clock = createFakeClock(new Date());
  const app = createSigninApp({
    AUTH_MODE: 'builtin', SIGNIN_ISSUER: issuer, SIGNIN_KEY: key, SIGNIN_ADDRESS: 'personal@example.invalid',
    MAIL_ACCOUNTS: JSON.stringify(['personal', 'work'].map(account)),
    MAIL_PASSWORDS: JSON.stringify({ personal: 'password-1', work: 'password-2' })
  }, {
    clock, keys: await generateSigninKeys(),
    documents: {
      resolve: async () => ['160.79.104.10'],
      get: async (url: URL) => ({ status: 200, body: JSON.stringify({ client_id: url.href, client_name: clientName, redirect_uris: [callback] }) })
    },
    system: {
      send: vi.fn(async (account: string, to: string, subject: string, text: string) => {
        if (broken.has(account)) throw new Error('sending failed');
        sent.push({ account, to, subject, text });
        return `<${randomBytes(6).toString('hex')}@system.universal-mail.invalid>`;
      }),
      discard: vi.fn(async (_account: string, messageId: string) => { discarded.push(messageId); })
    }
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorizeUrl = (extra: Record<string, string> = {}) => `${base}/authorize?${new URLSearchParams({
    response_type: 'code', client_id: claude, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', ...extra
  })}`;

  // A browser, minus the browser: a cookie jar of one, and forms read from the page.
  let cookie = '';
  const remember = (response: Response) => {
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
  const open = async (extra: Record<string, string> = {}) => {
    const response = remember(await fetch(authorizeUrl(extra), { redirect: 'manual' }));
    return { response, html: await response.text() };
  };
  const post = async (path: string, fields: Record<string, string>, options: { withCookie?: boolean } = {}) => {
    const response = remember(await fetch(`${base}${path}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(options.withCookie === false || !cookie ? {} : { Cookie: cookie }) },
      body: new URLSearchParams(fields)
    }));
    return { response, html: await response.text() };
  };
  const csrfIn = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const codeIn = () => /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(sent.filter(s => /code/i.test(s.subject)).at(-1)?.text ?? '')?.[1] ?? '';

  // The whole approval, as the owner clicks through it; returns the final redirect.
  const approve = async (grant: Record<string, string>) => {
    let page = await open();
    page = await post('/authorize/code', { csrf: csrfIn(page.html) });
    page = await post('/authorize/verify', { csrf: csrfIn(page.html), code: codeIn() });
    return post('/authorize/approve', { csrf: csrfIn(page.html), ...grant });
  };

  return {
    base, app, sent, discarded, broken, clock, verifier, cookie: () => cookie, open, post, csrfIn, codeIn, approve,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}
