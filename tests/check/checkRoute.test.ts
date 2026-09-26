import { generateKeyPairSync, randomBytes, type JsonWebKey } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintCheckToken } from '../../src/setup/checkToken.js';
import { VERSION } from '../../src/version.js';
import { issuer, startSignin, type Signin } from '../signin/harness.js';
import { ReportSchema } from './reportSchema.js';

// DIA-08 (added): the server's check route. Only setup's check token opens it;
// it answers with the report. Here the only account is on this machine with
// nothing listening, so its stage fails as unreachable; passing stages against
// real servers are in checkRoute.protocol.test.ts.
let signin: Signin | undefined;
let logSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(async () => { await signin?.close(); signin = undefined; logSpy?.mockRestore(); });

async function start() {
  const jwk: JsonWebKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  signin = await startSignin({ SIGNIN_SIGNING_KEY: JSON.stringify(jwk), SIGNIN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), IMAP_PORT: '1', SMTP_PORT: '1', IMAP_TLS: 'none', SMTP_TLS: 'starttls' });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const token = () => mintCheckToken(jwk, { issuer, audience: `${issuer}/${signin!.key}/check`, now: Date.now() });
  const check = (options: { token?: string; expectedVersion?: string; path?: string } = {}) => fetch(`${signin!.base}${options.path ?? `/${signin!.key}/check`}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    body: JSON.stringify({ expectedVersion: options.expectedVersion ?? VERSION })
  });
  const logged = (): Array<Record<string, unknown>> => logSpy!.mock.calls.map(([line]: unknown[]) => { try { return JSON.parse(String(line)); } catch { return { raw: String(line) }; } });
  return { jwk, token, check, logged };
}

describe('the check route', () => {
  it('DIA-08 setup\'s token opens it: the report, never cached; an unreachable account stops what depends on it (added)', async () => {
    const s = await start();
    const response = await s.check({ token: s.token() });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const report = await response.json();
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report).toMatchObject({ report: 'universal-mail-check', version: VERSION, result: 'FAIL', facts: { accounts: 1 } });
    expect(report.stages.map((st: { stage: string; status: string; code?: string }) => `${st.stage}=${st.status}${st.code ? `:${st.code}` : ''}`)).toEqual([
      'server=PASS', 'signin=PASS', 'account:main=FAIL:MAIL-UNREACHABLE', 'tools:main=NOT_RUN', 'live:main=NOT_RUN', 'sent:main=NOT_RUN'
    ]);
    // The request log names the route by its template, and the failure is logged for the owner to diagnose.
    expect(s.logged()).toContainEqual(expect.objectContaining({ event: 'request', method: 'POST', route: '/{key}/check', status: 200 }));
    expect(s.logged()).toContainEqual(expect.objectContaining({ event: 'check_stage_failed', stage: 'account:main', code: 'MAIL-UNREACHABLE' }));
  });

  it('DIA-08 setup expecting another version: "server" fails and nothing else runs', async () => {
    const s = await start();
    const report = await (await s.check({ token: s.token(), expectedVersion: '9.9.9' })).json();
    expect(report.stages.map((st: { status: string }) => st.status)).toEqual(['FAIL', 'NOT_RUN', 'NOT_RUN', 'NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
    expect(report.stages[0].code).toBe('SERVER-VERSION-MISMATCH');
  });

  it('DIA-08 no token, a used one, or one from another key: 401, nothing run, the reason logged without the token', async () => {
    const s = await start();
    const used = s.token();
    expect((await s.check({ token: used })).status).toBe(200);
    const other = mintCheckToken(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), { issuer, audience: `${issuer}/${signin!.key}/check`, now: Date.now() });
    for (const [token, reason] of [[undefined, 'token_missing'], [used, 'token_reused'], [other, 'token_invalid']] as const) {
      logSpy!.mockClear();
      const response = await s.check({ token });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
      expect(s.logged()).toContainEqual({ event: 'check_refused', reason });
      expect(s.logged().some(e => 'stage' in e)).toBe(false);
      expect(JSON.stringify(s.logged())).not.toContain(used);
    }
  });

  it('DIA-08 without the key in the address, there is no check route', async () => {
    const s = await start();
    expect((await s.check({ token: s.token(), path: '/check' })).status).toBe(404);
  });
});
