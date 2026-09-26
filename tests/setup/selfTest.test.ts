import { generateKeyPairSync, randomBytes, type JsonWebKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_SECRET } from '../../src/setup/flow.js';
import { createSetupLog } from '../../src/setup/log.js';
import { createSelfTest } from '../../src/setup/selfTest.js';
import { VERSION } from '../../src/version.js';
import { createFakeGoogle } from '../../testkit/src/fakeGoogle.js';
import { issuer, startSignin, type Signin } from '../signin/harness.js';

// SET-75 (added): step 8's client. It signs a check token with the key saved in
// universal-mail-credentials, asks the server to check itself, and logs the
// report whole (it is redacted by construction). The server here is the real
// one; its only account has nothing listening, so that stage fails.
let signin: Signin | undefined;
let home: string | undefined;
afterEach(async () => { await signin?.close(); signin = undefined; if (home) rmSync(home, { recursive: true, force: true }); home = undefined; vi.restoreAllMocks(); });

const setupKey = (): JsonWebKey => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });

async function world(options: { savedKey?: JsonWebKey; version?: string; fetchImpl?: typeof fetch } = {}) {
  const serverKey = setupKey();
  signin = await startSignin({ SIGNIN_SIGNING_KEY: JSON.stringify(serverKey), SIGNIN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), IMAP_PORT: '1', SMTP_PORT: '1', IMAP_TLS: 'none', SMTP_TLS: 'starttls' });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const fake = createFakeGoogle();
  const saved = options.savedKey ?? serverKey;
  await fake.google.putSecret('p', CREDENTIALS_SECRET, JSON.stringify({ passwords: {}, signingKey: saved, encryptionKey: 'x' }));
  home = mkdtempSync(join(tmpdir(), 'selftest-'));
  const log = createSetupLog(home, Date);
  log.secret(saved.d!);
  const base = signin.base;
  // The server's public address, reached on this machine.
  const local: typeof fetch = (url, init) => fetch(String(url).replace(issuer, base), init);
  const slept: number[] = [];
  const selfTest = createSelfTest({ google: fake.google, log, version: options.version ?? VERSION, clock: { now: Date.now, sleep: async ms => { slept.push(ms); } }, fetchImpl: options.fetchImpl ?? local });
  const entries = () => readFileSync(join(home!, '.universal-mail', 'setup-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { selfTest, target: { url: issuer, key: signin.key, project: 'p' }, entries, text: () => readFileSync(join(home!, '.universal-mail', 'setup-log.jsonl'), 'utf8'), saved, slept };
}

describe('the self-test client', () => {
  it('SET-75 the server checks itself; the answer counts the stages and names the first failure in its own words (added)', async () => {
    const w = await world();
    expect(await w.selfTest(w.target)).toEqual({
      passed: 2, total: 6, failing: 'Your provider\'s mail servers couldn\'t be reached.',
      // Which stage failed, and with which code, for Check and fix to repair.
      stages: [
        { stage: 'server', status: 'PASS' }, { stage: 'signin', status: 'PASS' },
        { stage: 'account:main', status: 'FAIL', code: 'MAIL-UNREACHABLE' },
        { stage: 'tools:main', status: 'NOT_RUN' }, { stage: 'live:main', status: 'NOT_RUN' }, { stage: 'sent:main', status: 'NOT_RUN' }
      ]
    });
    const logged = w.entries().find(e => e.type === 'selfTest-report');
    expect(logged.report).toMatchObject({ report: 'universal-mail-check', result: 'FAIL' });
    expect(logged.report.stages.map((s: { stage: string }) => s.stage)).toEqual(['server', 'signin', 'account:main', 'tools:main', 'live:main', 'sent:main']);
    // Neither the key nor the token it signed is written down.
    expect(w.text()).not.toContain(w.saved.d!);
    expect(w.text()).not.toMatch(/eyJ[\w-]+\.eyJ/);
  });

  it('SET-75 a server running another version is reported as that', async () => {
    const w = await world({ version: '9.9.9' });
    expect(await w.selfTest(w.target)).toMatchObject({ passed: 0, total: 6, failing: 'The running server isn\'t the version setup installed.' });
  });

  it('SET-75 saved keys that don\'t match the server\'s: refused, and said so; the log has the status', async () => {
    const w = await world({ savedKey: setupKey() });
    expect(await w.selfTest(w.target)).toEqual({ passed: 0, total: 0, failing: 'The server didn\'t accept setup\'s check, so its saved keys may not match.' });
    expect(w.entries()).toContainEqual(expect.objectContaining({ type: 'selfTest', attempt: 1, status: 401 }));
  });

  it('SET-75 a server that doesn\'t answer is tried three times, a few seconds apart, then reported', async () => {
    const down: typeof fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); };
    const w = await world({ fetchImpl: down });
    expect(await w.selfTest(w.target)).toEqual({ passed: 0, total: 0, failing: 'The server didn\'t answer its check.' });
    expect(w.entries().filter(e => e.type === 'selfTest').map(e => `${e.attempt}:${e.error}`)).toEqual(['1:ECONNREFUSED', '2:ECONNREFUSED', '3:ECONNREFUSED']);
    expect(w.slept).toEqual([5_000, 5_000]);
  });

  it('SET-75 a server busy starting (5xx) is tried again, and its later answer is used', async () => {
    let calls = 0;
    const w = await world();
    const local: typeof fetch = (url, init) => fetch(String(url).replace(issuer, signin!.base), init);
    const flaky: typeof fetch = async (url, init) => ++calls === 1 ? new Response('starting', { status: 503 }) : local(url, init);
    const retrying = createSelfTest({ google: (await (async () => { const f = createFakeGoogle(); await f.google.putSecret('p', CREDENTIALS_SECRET, JSON.stringify({ signingKey: w.saved })); return f; })()).google, log: createSetupLog(home!, Date), version: VERSION, clock: { now: Date.now, sleep: async () => undefined }, fetchImpl: flaky });
    expect((await retrying(w.target)).total).toBe(6);
    expect(calls).toBe(2);
  });

  it('SET-75 an answer lost after the server used the token: the retry signs a fresh one', async () => {
    let calls = 0;
    const w = await world();
    const local: typeof fetch = (url, init) => fetch(String(url).replace(issuer, signin!.base), init);
    // The first request reaches the server (which uses up its token); its answer never arrives.
    const lossy: typeof fetch = async (url, init) => { const answer = await local(url, init); if (++calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); return answer; };
    const retrying = createSelfTest({ google: (await (async () => { const f = createFakeGoogle(); await f.google.putSecret('p', CREDENTIALS_SECRET, JSON.stringify({ signingKey: w.saved })); return f; })()).google, log: createSetupLog(home!, Date), version: VERSION, clock: { now: Date.now, sleep: async () => undefined }, fetchImpl: lossy });
    expect(await retrying(w.target)).toMatchObject({ passed: 2, total: 6 });
  });

  it('SET-75 no check at that address (an older server, or the wrong one): said so, not retried', async () => {
    const w = await world();
    expect(await w.selfTest({ ...w.target, key: 'not-this-servers-key-000' })).toEqual({ passed: 0, total: 0, failing: 'The server has no check at its address. It may not be this version.' });
    expect(w.entries().filter(e => e.type === 'selfTest')).toHaveLength(1);
  });

  it('SET-75 no saved keys at all: reported, and no request is made', async () => {
    let asked = false;
    const w = await world({ fetchImpl: async () => { asked = true; return new Response('{}'); } });
    const empty = createSelfTest({ google: createFakeGoogle().google, log: createSetupLog(home!, Date), version: VERSION, clock: { now: Date.now, sleep: async () => undefined }, fetchImpl: async () => { asked = true; return new Response('{}'); } });
    expect(await empty(w.target)).toEqual({ passed: 0, total: 0, failing: 'Setup couldn\'t read the server\'s saved keys.' });
    // Only the public half saved (damaged credentials): the same answer, not a crash.
    const { d: _d, ...publicHalf } = w.saved;
    const halfGoogle = createFakeGoogle();
    await halfGoogle.google.putSecret('p', CREDENTIALS_SECRET, JSON.stringify({ signingKey: publicHalf }));
    const half = createSelfTest({ google: halfGoogle.google, log: createSetupLog(home!, Date), version: VERSION, clock: { now: Date.now, sleep: async () => undefined }, fetchImpl: async () => { asked = true; return new Response('{}'); } });
    expect(await half(w.target)).toEqual({ passed: 0, total: 0, failing: 'Setup couldn\'t read the server\'s saved keys.' });
    expect(asked).toBe(false);
  });
});
