import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { request, type Server } from 'node:http';
import { SignJWT, importJWK } from 'jose';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createFakeClock } from '../../testkit/src/fakeClock.js';

// Your Universal Mail page on the installed server, with every outside
// dependency faked: the saved records, Google's secret store, system emails,
// the mail checks, time and the release feed. A browser of one cookie.
export const PUBLIC_URL = 'https://universal-mail-4f2a-uc.a.run.app';
export const KEY = 'page-key-0123456789abcdefghij';
export const SERVICE_URL = 'https://license.example.invalid';
export type Sent = { account: string; to: string; subject: string; text: string };

export function records(overrides: { state?: Record<string, unknown>; passwords?: Record<string, string> } = {}) {
  const state = {
    version: 1, key: KEY, signInAddress: 'me@example.invalid', installedAt: '2026-09-25T10:00:00.000Z',
    accounts: [
      { name: 'me', email: 'me@example.invalid', provider: 'other', imap: { host: '127.0.0.1', port: 1, tls: 'none' }, smtp: { host: '127.0.0.1', port: 1, tls: 'starttls' }, sentCopyMode: 'yahoo', safeMove: true },
      { name: 'work', email: 'work@example.invalid', provider: 'other', imap: { host: '127.0.0.1', port: 2, tls: 'none' }, smtp: { host: '127.0.0.1', port: 2, tls: 'starttls' }, sentCopyMode: 'append', safeMove: true }
    ],
    grants: {}, fingerprints: [], trialReminder: false,
    ...overrides.state
  };
  const credentials = {
    passwords: overrides.passwords ?? { me: 'me-app-password', work: 'work-app-password' },
    signingKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
    encryptionKey: randomBytes(32).toString('base64url')
  };
  return { state, credentials };
}

// The license service (design §13.3), faked: what it answers to each call.
export type ServiceAnswer = { status: number; body?: unknown };
export type ServiceCall = { path: string; body: Record<string, unknown> };

export async function startPage(options: {
  state?: Record<string, unknown>; passwords?: Record<string, string>; accepted?: Record<string, string>; feed?: unknown; env?: NodeJS.ProcessEnv; start?: Date;
  service?: (path: string, body: Record<string, unknown>) => ServiceAnswer | Promise<ServiceAnswer>;
} = {}) {
  const r = records(options);
  const clock = createFakeClock(options.start ?? new Date('2026-09-25T12:00:00Z'));
  const feedAsked: string[] = [];
  const serviceCalls: ServiceCall[] = [];
  const serviceUrl = options.service ? SERVICE_URL : undefined;
  const sent: Sent[] = [];
  const broken = new Set<string>();
  const saves: { state: string[]; credentials: string[] } = { state: [], credentials: [] };
  // What each provider accepts now: an address's current app password.
  const accepted: Record<string, string> = options.accepted ?? { 'me@example.invalid': 'me-app-password', 'work@example.invalid': 'work-app-password' };
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const app = createApp({
    UNIVERSAL_MAIL_STATE: JSON.stringify(r.state), UNIVERSAL_MAIL_CREDENTIALS: JSON.stringify(r.credentials), PUBLIC_URL,
    ...(serviceUrl ? { LICENSE_SERVICE_URL: serviceUrl } : {}), ...options.env
  }, {
    clock,
    saveState: async json => { saves.state.push(json); },
    saveCredentials: async json => { saves.credentials.push(json); },
    system: {
      send: async (account, to, subject, text) => {
        if (broken.has(account)) throw new Error('sending failed');
        sent.push({ account, to, subject, text });
        return `<${randomBytes(6).toString('hex')}@system.universal-mail.invalid>`;
      },
      discard: async () => undefined
    },
    // Special addresses for the unusual cases: @unknown.invalid (no provider
    // found), down@ (unreachable), insecure@ (no encryption), nosend@ (the
    // sending test fails), appends@ (the provider files no Sent copy).
    mailCheck: {
      detect: async address => address.endsWith('@unknown.invalid') ? undefined : ({ provider: { id: 'other', name: 'Example Mail', appPassword: { page: 'https://example.invalid/app-passwords', button: 'New app password', prerequisites: [] },
        imap: { host: '127.0.0.1', port: 3, tls: 'implicit' }, smtp: { host: '127.0.0.1', port: 3, tls: 'starttls' } } }),
      check: async (address, password) => address.startsWith('down@') ? { ok: false, reason: 'unreachable' }
        : address.startsWith('insecure@') ? { ok: false, reason: 'insecure' }
        : accepted[address] === password ? { ok: true, folders: 7, safeMove: true } : { ok: false, reason: 'rejected' },
      sendTest: async address => {
        if (address.startsWith('nosend@')) throw new Error('the test email was not sent: unreachable');
        return { copies: address.startsWith('appends@') ? 0 : 1 };
      }
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      if (serviceUrl && address.startsWith(serviceUrl)) {
        const call = { path: address.slice(serviceUrl.length), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} };
        serviceCalls.push(call);
        const answer = await options.service!(call.path, call.body);
        return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
      }
      feedAsked.push(address);
      if (options.feed === undefined) throw new Error('no feed in this test');
      return new Response(JSON.stringify(options.feed));
    }) as typeof fetch
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let cookie = '';
  // Every page this browser was shown, for the canary scan (PG-10).
  const pages: string[] = [];
  const remember = (response: Response) => {
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
  const get = async (path = '') => {
    const response = remember(await fetch(`${base}/${KEY}${path}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} }));
    const html = await response.text();
    pages.push(html);
    return { response, html };
  };
  const post = async (path: string, fields: Record<string, string>) => {
    const response = remember(await fetch(`${base}/${KEY}${path}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
      body: new URLSearchParams(fields)
    }));
    const html = await response.text();
    pages.push(html);
    return { response, html };
  };
  const csrfIn = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const codeIn = () => /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(sent.filter(s => /code/i.test(s.subject)).at(-1)?.text ?? '')?.[1] ?? '';
  // Signs in with an emailed code; returns the page as it then shows.
  const signIn = async () => {
    const start = await get();
    const codePage = await post('/signin/code', { csrf: csrfIn(start.html) });
    await post('/signin/verify', { csrf: csrfIn(codePage.html), code: codeIn() });
    return get();
  };
  // Follows a form's answer the way a browser does: a redirect back to the page.
  const act = async (path: string, fields: Record<string, string>) => {
    const page = await get();
    const answer = await post(path, { csrf: csrfIn(page.html), ...fields });
    return answer.response.status === 303 ? get() : answer;
  };
  const logged = () => logSpy.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return { raw: String(line) }; } });
  // An MCP request as an AI app makes it: its access token (signed with the
  // install's own key), to the service's own host name.
  const mcp = async (appId: string, connection: number, method: string, params: Record<string, unknown> = {}) => {
    const key = await importJWK(r.credentials.signingKey as never, 'ES256');
    const now = Math.floor(clock.now() / 1000);
    const token = await new SignJWT({ client_id: appId, grant_version: connection }).setProtectedHeader({ alg: 'ES256' })
      .setIssuer(PUBLIC_URL).setAudience(`${PUBLIC_URL}/${KEY}/mcp`).setIssuedAt(now).setExpirationTime(now + 600).setJti(`j-${Math.random()}`).sign(key);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(new URL(base).port), method: 'POST', path: `/${KEY}/mcp`,
        headers: { host: new URL(PUBLIC_URL).host, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } },
      res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: text })); });
      req.on('error', reject);
      req.end(body);
    });
  };

  return {
    app, base, clock, sent, broken, saves, accepted, records: r, get, post, csrfIn, codeIn, signIn, act, logged, pages, mcp, feedAsked, serviceCalls,
    cookie: () => cookie, forgetCookie: () => { cookie = ''; },
    close: () => new Promise<void>(resolve => { logSpy.mockRestore(); server.close(() => resolve()); server.closeAllConnections(); })
  };
}
