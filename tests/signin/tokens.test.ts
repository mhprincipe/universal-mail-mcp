import { createHash, randomBytes } from 'node:crypto';
import { decodeProtectedHeader, decodeJwt } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizationServer, generateSigninKeys, type AuthorizationServer } from '../../src/signin/authorization.js';
import { createFakeClock, type FakeClock } from '../../testkit/src/fakeClock.js';

const issuer = 'https://mail.example';
const resource = `${issuer}/key-for-tests-0123456789/mcp`;
const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const callback = 'https://claude.ai/api/mcp/auth_callback';
const chatgpt = 'https://chatgpt.com/oauth/client.json';
const chatgptCallback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const docs: Record<string, object> = {
  [claude]: { client_id: claude, client_name: 'Claude', redirect_uris: [callback] },
  [chatgpt]: { client_id: chatgpt, client_name: 'ChatGPT', redirect_uris: [chatgptCallback] }
};
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const DAY = 24 * 60 * 60 * 1000;

let clock: FakeClock;
let auth: AuthorizationServer;
beforeEach(async () => {
  clock = createFakeClock(new Date('2026-09-24T12:00:00Z'));
  auth = createAuthorizationServer({
    issuer, resource, trustedOrigins: ['https://claude.ai', 'https://chatgpt.com'], keys: await generateSigninKeys(), clock,
    documents: {
      resolve: vi.fn(async () => ['160.79.104.10']),
      get: vi.fn(async (url: URL) => ({ status: 200, body: JSON.stringify(docs[url.href]) }))
    }
  });
});

const params = (overrides: Record<string, string | undefined> = {}) => ({
  response_type: 'code', client_id: claude, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', ...overrides
});
// Begin, then approve as the owner would on the approval page.
async function codeFor(overrides: Record<string, string | undefined> = {}) {
  const begun = await auth.begin(params(overrides));
  if (!begun.ok) throw new Error(`begin refused: ${JSON.stringify(begun)}`);
  const redirect = new URL(await auth.approve(begun.request, { personal: ['read'] }));
  return redirect.searchParams.get('code')!;
}
const exchange = (code: string, overrides: Record<string, string> = {}) =>
  auth.token({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: claude, code_verifier: verifier, ...overrides });

describe('authorization and tokens', () => {
  it('SIG-20 PKCE is required, and plain is refused', async () => {
    for (const bad of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }, { code_challenge_method: undefined }]) {
      const begun = await auth.begin(params(bad));
      expect(begun.ok, JSON.stringify(bad)).toBe(false);
      const redirect = new URL((begun as { redirect: string }).redirect);
      expect(`${redirect.origin}${redirect.pathname}`).toBe(callback);
      expect(Object.fromEntries(redirect.searchParams)).toMatchObject({ error: 'invalid_request', state: 'st-1', iss: issuer });
    }
    const code = await codeFor();
    expect(await exchange(code, { code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-00' })).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect(await auth.token({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: claude })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('SIG-16 at authorize: an address the document does not list is refused, and never redirected to', async () => {
    for (const bad of [{ redirect_uri: 'https://claude.ai/evil' }, { redirect_uri: 'https://evil.example/cb', code_challenge: undefined }]) {
      const begun = await auth.begin(params(bad));
      expect(begun, JSON.stringify(bad)).toEqual({ ok: false, error: 'redirect_mismatch' });
    }
  });

  it('SIG-20 only the code flow with PKCE is offered: other flows are refused', async () => {
    const implicit = await auth.begin(params({ response_type: 'token' }));
    expect(implicit.ok).toBe(false);
    expect(new URL((implicit as { redirect: string }).redirect).searchParams.get('error')).toBe('unsupported_response_type');
    for (const grant_type of ['password', 'client_credentials', undefined]) {
      expect(await auth.token({ grant_type, client_id: claude }), String(grant_type)).toMatchObject({ status: 400, body: { error: 'unsupported_grant_type' } });
    }
    expect(await auth.token({ grant_type: 'refresh_token', client_id: claude })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('SIG-21 a code expires after 60 seconds', async () => {
    const early = await codeFor();
    clock.advance(59_000);
    expect(await exchange(early)).toMatchObject({ status: 200 });
    const late = await codeFor();
    clock.advance(61_000);
    expect(await exchange(late)).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('SIG-22 a code is bound to its app and redirect address; swapping either fails', async () => {
    const code = await codeFor();
    expect(await exchange(code, { client_id: chatgpt })).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect(await exchange(code, { redirect_uri: chatgptCallback })).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect(await exchange(code)).toMatchObject({ status: 200 });
  });

  it('SIG-27 a code works once (added: OAuth requires it, and the plan had no test)', async () => {
    const code = await codeFor();
    expect(await exchange(code)).toMatchObject({ status: 200 });
    expect(await exchange(code)).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('SIG-23 the authorization response includes the issuer (RFC 9207)', async () => {
    const begun = await auth.begin(params());
    if (!begun.ok) throw new Error('refused');
    const redirect = new URL(await auth.approve(begun.request, { personal: ['read'] }));
    expect(`${redirect.origin}${redirect.pathname}`).toBe(callback);
    expect(redirect.searchParams.get('iss')).toBe(issuer);
    expect(redirect.searchParams.get('state')).toBe('st-1');
    expect(redirect.searchParams.get('code')).toBeTruthy();
  });

  it('SIG-24 access tokens are ES256, last 15 minutes, and carry the app ID and grant version', async () => {
    const { body } = await exchange(await codeFor());
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
    expect(decodeProtectedHeader(body.access_token)).toMatchObject({ alg: 'ES256' });
    const claims = decodeJwt(body.access_token);
    expect(claims).toMatchObject({ iss: issuer, aud: resource, client_id: claude, grant_version: 1 });
    expect(claims.exp! - claims.iat!).toBe(900);
    expect(await auth.verifyAccess(body.access_token)).toEqual({ appId: claude, grantVersion: 1 });

    clock.advance(901_000);
    await expect(auth.verifyAccess(body.access_token)).rejects.toMatchObject({ reason: 'token_expired' });
    // A token from another server (other keys) is refused.
    const stranger = createAuthorizationServer({ issuer, resource, trustedOrigins: [], keys: await generateSigninKeys(), clock, documents: { resolve: async () => [], get: async () => ({ status: 404, body: '' }) } });
    clock.advance(-901_000);
    await expect(stranger.verifyAccess(body.access_token)).rejects.toMatchObject({ reason: 'token_invalid' });
    // The same keys, but a token made for another resource (audience) is refused.
    const keys = await generateSigninKeys();
    const serverFor = (res: string) => createAuthorizationServer({ issuer, resource: res, trustedOrigins: ['https://claude.ai'], keys, clock, documents: {
      resolve: async () => ['160.79.104.10'], get: async (url: URL) => ({ status: 200, body: JSON.stringify(docs[url.href]) })
    } });
    const elsewhere = serverFor(`${issuer}/another-key-0123456789/mcp`);
    const begun = await elsewhere.begin(params());
    if (!begun.ok) throw new Error('refused');
    const code = new URL(await elsewhere.approve(begun.request, { personal: ['read'] })).searchParams.get('code')!;
    const foreign = (await elsewhere.token({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: claude, code_verifier: verifier })).body.access_token;
    await expect(serverFor(resource).verifyAccess(foreign)).rejects.toMatchObject({ reason: 'token_invalid' });
  });

  it('SIG-25 refresh works and issues a new refresh token each time', async () => {
    const first = (await exchange(await codeFor())).body;
    clock.advance(1_000);
    const second = await auth.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: claude });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect(await auth.verifyAccess(second.body.access_token)).toEqual({ appId: claude, grantVersion: 1 });
    // A refresh token is bound to its app too.
    expect(await auth.token({ grant_type: 'refresh_token', refresh_token: second.body.refresh_token, client_id: chatgpt }))
      .toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });

  it('SIG-26 access lapses after 30 days unused; any use within 30 days extends it', async () => {
    let refresh = (await exchange(await codeFor())).body.refresh_token as string;
    const unused = refresh;
    for (let i = 0; i < 3; i++) {
      clock.advance(29 * DAY);
      const next = await auth.token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: claude });
      expect(next.status, `use ${i + 1}`).toBe(200);
      refresh = next.body.refresh_token;
    }
    // 87 days on, still connected; the token left unused since day 0 has lapsed.
    expect(await auth.token({ grant_type: 'refresh_token', refresh_token: unused, client_id: claude })).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    clock.advance(31 * DAY);
    expect(await auth.token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: claude })).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
  });
});
