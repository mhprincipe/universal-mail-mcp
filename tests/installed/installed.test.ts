import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { readInstalled } from '../../src/installed.js';
import { createCanary } from '../../testkit/src/canary.js';
import { createSoftwareAuthenticator } from '../../testkit/src/softwareAuthenticator.js';

// INS (added): the installed server takes everything from the two records
// setup saved, which Cloud Run hands it as environment variables, one JSON
// text each. Connections and fingerprints are saved back as new versions of
// the state, so a restart forgets nothing.
const PUBLIC_URL = 'https://universal-mail-4f2a-uc.a.run.app';
const HOST = 'universal-mail-4f2a-uc.a.run.app';
const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

function records(overrides: { state?: object; credentials?: object; passwords?: Record<string, string> } = {}) {
  const state = {
    version: 1, key: 'installed-key-0123456789abcdef', signInAddress: 'me@example.invalid',
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
    encryptionKey: randomBytes(32).toString('base64url'),
    ...overrides.credentials
  };
  return { state, credentials, env: { UNIVERSAL_MAIL_STATE: JSON.stringify(state), UNIVERSAL_MAIL_CREDENTIALS: JSON.stringify(credentials), PUBLIC_URL } as NodeJS.ProcessEnv };
}

let servers: Server[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(async () => {
  for (const s of servers) await new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); });
  servers = [];
  logSpy?.mockRestore();
});
const quiet = () => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined); };
const logged = (): Array<Record<string, unknown>> => logSpy!.mock.calls.map(([line]: unknown[]) => { try { return JSON.parse(String(line)); } catch { return { raw: String(line) }; } });

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}
// A request as Cloud Run delivers it: to this machine, with the service's own host name.
function ask(port: number, method: string, path: string, host = HOST, body?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host, accept: 'application/json, text/event-stream', ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('the installed server', () => {
  it('INS-01 the two saved records become the server\'s settings (added)', () => {
    const r = records();
    const installed = readInstalled(r.env);
    if (installed.status !== 'ready') throw new Error(installed.status);
    expect(installed.env).toMatchObject({
      AUTH_MODE: 'builtin', SIGNIN_ISSUER: PUBLIC_URL, SIGNIN_KEY: r.state.key, SIGNIN_ADDRESS: 'me@example.invalid',
      SIGNIN_ENCRYPTION_KEY: r.credentials.encryptionKey, ALLOWED_HOSTS: HOST
    });
    expect(JSON.parse(installed.env.SIGNIN_SIGNING_KEY!)).toEqual(r.credentials.signingKey);
    expect(JSON.parse(installed.env.MAIL_ACCOUNTS!)).toEqual([
      { name: 'me', email: 'me@example.invalid', imap: { host: '127.0.0.1', port: 1, tls: 'none' }, smtp: { host: '127.0.0.1', port: 1, tls: 'starttls' }, sentCopyMode: 'yahoo', sending: true },
      { name: 'work', email: 'work@example.invalid', imap: { host: '127.0.0.1', port: 2, tls: 'none' }, smtp: { host: '127.0.0.1', port: 2, tls: 'starttls' }, sentCopyMode: 'append', sending: true }
    ]);
    expect(JSON.parse(installed.env.MAIL_PASSWORDS!)).toEqual(r.credentials.passwords);
  });

  it('INS-01 it answers at its public address: discovery names it, and requests to its own host are let through', async () => {
    quiet();
    const r = records();
    const port = await listen(createApp(r.env));
    const discovery = JSON.parse((await ask(port, 'GET', '/.well-known/oauth-authorization-server')).body);
    expect(discovery.issuer).toBe(PUBLIC_URL);
    // Its own host: the MCP address asks for sign-in (not "host not allowed").
    const mcp = await ask(port, 'POST', `/${r.state.key}/mcp`, HOST, '{}');
    expect(mcp.status).toBe(401);
    expect(String(mcp.headers['www-authenticate'])).toContain(`${PUBLIC_URL}/.well-known/oauth-protected-resource/${r.state.key}/mcp`);
    // Anyone else's host name is refused before sign-in.
    expect((await ask(port, 'POST', `/${r.state.key}/mcp`, 'evil.example', '{}')).status).toBe(403);
    expect(logged()).toContainEqual({ event: 'settings_loaded', accounts: 2 });
  });

  it('INS-02 the first start, before Google has given it an address: healthy, waiting, and says so', async () => {
    quiet();
    const r = records();
    const { PUBLIC_URL: _url, ...env } = r.env;
    const port = await listen(createApp(env));
    const health = await ask(port, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'starting' });
    for (const path of ['/.well-known/oauth-authorization-server', `/${r.state.key}/mcp`, '/authorize']) {
      const answer = await ask(port, 'GET', path);
      expect(answer.status).toBe(503);
      expect(JSON.parse(answer.body)).toEqual({ error: 'not_ready' });
    }
    expect(logged()).toContainEqual({ event: 'waiting_for_address' });
  });

  it('INS-03 damaged or missing records: the log names the setting and what\'s wrong, never a value; nothing is served', async () => {
    const secret = createCanary('app-password');
    const r = records({ passwords: { me: secret } });
    const cases: Array<[NodeJS.ProcessEnv, string, string]> = [
      [{ ...r.env, UNIVERSAL_MAIL_STATE: `{"key":"${secret}"` }, 'UNIVERSAL_MAIL_STATE', 'isn\'t valid JSON'],
      [{ ...r.env, UNIVERSAL_MAIL_CREDENTIALS: `${secret}` }, 'UNIVERSAL_MAIL_CREDENTIALS', 'isn\'t valid JSON'],
      [{ ...r.env, UNIVERSAL_MAIL_CREDENTIALS: undefined }, 'UNIVERSAL_MAIL_CREDENTIALS', 'is missing'],
      [{ ...r.env, UNIVERSAL_MAIL_STATE: JSON.stringify({ ...r.state, key: 42 }) }, 'UNIVERSAL_MAIL_STATE', 'key'],
      // "work" has no password saved.
      [r.env, 'UNIVERSAL_MAIL_CREDENTIALS', 'no password for work'],
      // A password the mail engine would refuse: caught at start, not on every request.
      [{ ...r.env, UNIVERSAL_MAIL_CREDENTIALS: JSON.stringify({ ...r.credentials, passwords: { me: secret, work: 'short' } }) }, 'UNIVERSAL_MAIL_CREDENTIALS', 'passwords.work'],
      [{ ...r.env, PUBLIC_URL: `http://${secret}.example` }, 'PUBLIC_URL', 'https']
    ];
    for (const [env, setting, problem] of cases) {
      quiet();
      const port = await listen(createApp(env));
      const health = await ask(port, 'GET', '/health');
      expect(health.status).toBe(503);
      expect(JSON.parse(health.body)).toEqual({ status: 'not_configured' });
      expect((await ask(port, 'GET', '/.well-known/oauth-authorization-server')).status).toBe(503);
      const event = logged().find(e => e.event === 'settings_invalid');
      expect(event, setting).toMatchObject({ setting });
      expect(String(event!.problem), setting).toContain(problem);
      expect(JSON.stringify(logged()), setting).not.toContain(secret);
      // Broken JSON is described in fixed words: not even the start of the value.
      if (problem === 'isn\'t valid JSON') expect(event!.problem).toBe(`${setting} isn't valid JSON`);
      logSpy!.mockRestore();
    }
  });

  it('INS-03 damaged records on the very first start (no address yet) are reported, not taken for "waiting"', async () => {
    quiet();
    const r = records();
    const { PUBLIC_URL: _url, ...env } = r.env;
    const port = await listen(createApp({ ...env, UNIVERSAL_MAIL_STATE: '{' }));
    expect(JSON.parse((await ask(port, 'GET', '/health')).body)).toEqual({ status: 'not_configured' });
    expect(logged()).toContainEqual(expect.objectContaining({ event: 'settings_invalid', setting: 'UNIVERSAL_MAIL_STATE' }));
    expect(logged()).not.toContainEqual({ event: 'waiting_for_address' });
  });

  it('INS-04 a connected app survives a restart; a disconnect does too, and a reconnection gets a new number', async () => {
    quiet();
    const saves: string[] = [];
    const first = records();
    const app1 = createApp(first.env, { saveState: async json => { saves.push(json); } });
    app1.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize'] });
    await app1.signin!.saved();
    const afterConnect = JSON.parse(saves.at(-1)!);
    // The rest of the state is exactly as it was: only the connections changed.
    expect({ ...afterConnect, grants: {} }).toEqual(first.state);

    const app2 = createApp({ ...first.env, UNIVERSAL_MAIL_STATE: saves.at(-1)! }, { saveState: async json => { saves.push(json); } });
    expect(app2.signin!.grants.get(claude)).toEqual({ appId: claude, appName: 'Claude', connection: 1, accounts: { me: ['read', 'organize'] } });

    app2.signin!.grants.disconnect(claude);
    await app2.signin!.saved();
    const app3 = createApp({ ...first.env, UNIVERSAL_MAIL_STATE: saves.at(-1)! }, { saveState: async json => { saves.push(json); } });
    expect(app3.signin!.grants.get(claude)).toBeUndefined();
    expect(app3.signin!.grants.connect(claude, 'Claude', { me: ['read'] }).connection).toBe(3);
  });

  it('INS-04 a saved fingerprint survives a restart and still signs the owner in', async () => {
    quiet();
    const saves: string[] = [];
    const sent: string[] = [];
    const system = { send: async (_a: string, _to: string, _s: string, text: string) => { sent.push(text); return '<x@system.universal-mail.invalid>'; }, discard: async () => undefined };
    const first = records();
    const app1 = createApp(first.env, { saveState: async json => { saves.push(json); }, system });
    const site = { rpId: HOST, origin: PUBLIC_URL };
    const device = createSoftwareAuthenticator();
    const owner = app1.signin!.owner;
    const s = owner.start();
    await owner.requestCode(s, 'test');
    owner.enterCode(s, /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(sent.at(-1)!)![1]!);
    const registration = await owner.beginRegistration(s);
    if (!registration.ok) throw new Error(registration.reason);
    expect(await owner.finishRegistration(s, device.register({ ...site, challenge: registration.options.challenge }))).toEqual({ ok: true });
    await app1.signin!.saved();
    const stored = JSON.parse(saves.at(-1)!).fingerprints;
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]).sort()).toEqual(['counter', 'id', 'publicKey', 'transports']);

    const app2 = createApp({ ...first.env, UNIVERSAL_MAIL_STATE: saves.at(-1)! }, { saveState: async () => undefined, system });
    const owner2 = app2.signin!.owner;
    expect(owner2.hasFingerprint()).toBe(true);
    const s2 = owner2.start();
    const auth = await owner2.beginAuthentication(s2);
    if (!auth.ok) throw new Error(auth.reason);
    expect(await owner2.finishAuthentication(s2, device.sign({ ...site, challenge: auth.options.challenge }))).toEqual({ ok: true });
    expect(owner2.level(s2)).toBe('fingerprint');
  });

  it('INS-05 what is saved never holds a password or key, and quick changes are saved in order, the last one complete', async () => {
    quiet();
    const secret = createCanary('app-password');
    const r = records({ passwords: { me: secret, work: 'work-app-password' } });
    const saves: string[] = [];
    let release: () => void = () => undefined;
    // The first save is slow: the second must wait for it, not overtake it.
    // Each is recorded when it completes, as Google would store it.
    const slow = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    const app = createApp(r.env, { saveState: async json => { if (started++ === 0) await slow; saves.push(json); } });
    app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    app.signin!.grants.connect('https://chatgpt.com/oauth/client.json', 'ChatGPT', { work: ['read'] });
    release();
    await app.signin!.saved();
    const last = JSON.parse(saves.at(-1)!);
    expect(last.grants.apps.map((g: { appName: string }) => g.appName)).toEqual(['Claude', 'ChatGPT']);
    for (const json of saves) {
      expect(json).not.toContain(secret);
      expect(json).not.toContain((r.credentials.signingKey as { d: string }).d);
      expect(json).not.toContain(r.credentials.encryptionKey);
    }
  });

  it('INS-05 a failed save is logged and retried with the next change; the running server carries on', async () => {
    quiet();
    const r = records();
    let fail = true;
    const saves: string[] = [];
    const app = createApp(r.env, { saveState: async json => { if (fail) throw Object.assign(new Error(`denied ${json}`), { status: 403 }); saves.push(json); } });
    app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await app.signin!.saved();
    expect(logged()).toContainEqual({ event: 'state_save_failed', what: 'state', status: 403 });
    expect(JSON.stringify(logged())).not.toContain('Claude');
    expect(app.signin!.grants.get(claude)).toBeDefined();
    fail = false;
    app.signin!.grants.update(claude, { me: ['read', 'organize'] });
    await app.signin!.saved();
    expect(JSON.parse(saves.at(-1)!).grants.apps[0].accounts).toEqual({ me: ['read', 'organize'] });
  });
});
