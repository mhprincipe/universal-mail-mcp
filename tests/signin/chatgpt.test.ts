import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizationServer, generateSigninKeys, type AuthorizationServer } from '../../src/signin/authorization.js';
import { createFakeClock, type FakeClock } from '../../testkit/src/fakeClock.js';

// ChatGPT as it really is (its document fetched 2026-09-29): it names
// private_key_jwt and publishes its keys, so it may prove itself at the token
// step with a signed assertion instead of (or besides) sending client_id.
// An assertion is never taken on trust: it's checked against the keys its
// own document names, on its own origin, once.
const issuer = 'https://mail.example';
const resource = `${issuer}/key-for-tests-0123456789/mcp`;
const chatgpt = 'https://chatgpt.com/oauth/client.json';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const jwksUri = 'https://chatgpt.com/oauth/jwks.json';
const ASSERTION = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

let clock: FakeClock;
let auth: AuthorizationServer;
let chatgptKey: CryptoKey;
let served: Record<string, unknown>;
let fetched: string[];

beforeEach(async () => {
  clock = createFakeClock(new Date('2026-09-29T12:00:00Z'));
  const pair = await generateKeyPair('RS256', { extractable: true });
  chatgptKey = pair.privateKey;
  served = {
    [chatgpt]: {
      client_id: chatgpt, client_uri: 'https://chatgpt.com/', redirect_uris: [callback], token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], client_name: 'ChatGPT', logo_uri: 'https://persistent.oaistatic.com/x.png',
      token_endpoint_auth_signing_alg: 'RS256', jwks_uri: jwksUri
    },
    [jwksUri]: { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] }
  };
  fetched = [];
  auth = createAuthorizationServer({
    issuer, resource, trustedOrigins: ['https://claude.ai', 'https://chatgpt.com'], keys: await generateSigninKeys(), clock,
    documents: {
      resolve: vi.fn(async () => ['104.18.32.47']),
      get: vi.fn(async (url: URL) => {
        fetched.push(url.href);
        return url.href in served ? { status: 200, body: JSON.stringify(served[url.href]) } : { status: 404, body: '' };
      })
    }
  });
});

const now = () => Math.floor(clock.now() / 1000);
const assertion = (claims: { iss?: string; sub?: string; aud?: string; exp?: number; jti?: string } = {}, key: CryptoKey = chatgptKey) =>
  new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(claims.iss ?? chatgpt).setSubject(claims.sub ?? chatgpt).setAudience(claims.aud ?? `${issuer}/token`)
    .setIssuedAt(now()).setExpirationTime(claims.exp ?? now() + 300).setJti(claims.jti ?? randomUUID())
    .sign(key);

async function code() {
  const begun = await auth.begin({ response_type: 'code', client_id: chatgpt, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource, scope: 'mail.read' });
  if (!begun.ok) throw new Error(`begin refused: ${JSON.stringify(begun)}`);
  expect(begun.request.clientName).toBe('ChatGPT');
  return new URL(await auth.approve(begun.request, { personal: ['read'] })).searchParams.get('code')!;
}
const exchange = async (form: Record<string, string>) =>
  auth.token({ grant_type: 'authorization_code', code: await code(), redirect_uri: callback, code_verifier: verifier, resource, ...form });

describe('ChatGPT signs in', () => {
  it('SIG-83 as a public client (client_id, PKCE), like Claude: its real document, extra fields and all, is accepted (added: ChatGPT)', async () => {
    const answer = await exchange({ client_id: chatgpt });
    expect(answer.status).toBe(200);
    expect((await auth.verifyAccess(answer.body.access_token)).appId).toBe(chatgpt);
    const refreshed = await auth.token({ grant_type: 'refresh_token', refresh_token: answer.body.refresh_token, client_id: chatgpt });
    expect(refreshed.status).toBe(200);
    // No assertion, no key fetch.
    expect(fetched).not.toContain(jwksUri);
  });

  it('SIG-83 with a signed assertion (private_key_jwt), with or without client_id, for the code and for refresh', async () => {
    const withId = await exchange({ client_id: chatgpt, client_assertion_type: ASSERTION, client_assertion: await assertion() });
    expect(withId.status).toBe(200);
    const withoutId = await exchange({ client_assertion_type: ASSERTION, client_assertion: await assertion() });
    expect(withoutId.status).toBe(200);
    expect((await auth.verifyAccess(withoutId.body.access_token)).appId).toBe(chatgpt);
    const refreshed = await auth.token({ grant_type: 'refresh_token', refresh_token: withoutId.body.refresh_token, client_assertion_type: ASSERTION, client_assertion: await assertion() });
    expect(refreshed.status).toBe(200);
    // The audience may also be the issuer itself.
    expect((await exchange({ client_assertion_type: ASSERTION, client_assertion: await assertion({ aud: issuer }) })).status).toBe(200);
  });

  it('SIG-84 an assertion that doesn\'t prove it is refused as invalid_client: never ignored', async () => {
    const other = (await generateKeyPair('RS256', { extractable: true })).privateKey;
    const bad: Array<[string, Record<string, string>]> = [
      ['signed with another key', { client_assertion_type: ASSERTION, client_assertion: await assertion({}, other) }],
      ['another issuer', { client_assertion_type: ASSERTION, client_assertion: await assertion({ iss: 'https://claude.ai/oauth/mcp-oauth-client-metadata' }) }],
      ['subject isn\'t the app', { client_assertion_type: ASSERTION, client_assertion: await assertion({ sub: 'someone' }) }],
      ['for another server', { client_assertion_type: ASSERTION, client_assertion: await assertion({ aud: 'https://elsewhere.example/token' }) }],
      ['expired', { client_assertion_type: ASSERTION, client_assertion: await assertion({ exp: now() - 5 }) }],
      ['good for hours', { client_assertion_type: ASSERTION, client_assertion: await assertion({ exp: now() + 3 * 3600 }) }],
      ['a different client_id beside it', { client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', client_assertion_type: ASSERTION, client_assertion: await assertion() }],
      ['an unknown assertion type', { client_assertion_type: 'urn:example:other', client_assertion: await assertion() }],
      ['an assertion type with no assertion', { client_id: chatgpt, client_assertion_type: ASSERTION }],
      ['not a JWT', { client_assertion_type: ASSERTION, client_assertion: 'not-a-jwt' }],
      ['no one-time id', { client_assertion_type: ASSERTION, client_assertion: await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(chatgpt).setSubject(chatgpt).setAudience(`${issuer}/token`).setIssuedAt(now()).setExpirationTime(now() + 300).sign(chatgptKey) }]
    ];
    for (const [why, form] of bad) {
      const answer = await exchange(form);
      expect(answer, why).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    }
    // A client_id that isn't the assertion's is refused before anything is fetched for it.
    fetched = [];
    await exchange({ client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', client_assertion_type: ASSERTION, client_assertion: await assertion() });
    expect(fetched).not.toContain('https://claude.ai/oauth/mcp-oauth-client-metadata');
  });

  it('SIG-84 each assertion works once, and the keys must come from the app\'s own origin', async () => {
    const once = await assertion();
    expect((await exchange({ client_assertion_type: ASSERTION, client_assertion: once })).status).toBe(200);
    expect(await exchange({ client_assertion_type: ASSERTION, client_assertion: once })).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    // A document naming keys elsewhere, or none, can't be used to prove anything.
    (served[chatgpt] as Record<string, unknown>).jwks_uri = 'https://attacker.example/jwks.json';
    expect(await exchange({ client_assertion_type: ASSERTION, client_assertion: await assertion() })).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    expect(fetched).not.toContain('https://attacker.example/jwks.json');
    // Not even another trusted app's origin, though its keys would verify.
    (served[chatgpt] as Record<string, unknown>).jwks_uri = 'https://claude.ai/jwks.json';
    served['https://claude.ai/jwks.json'] = served[jwksUri];
    expect(await exchange({ client_assertion_type: ASSERTION, client_assertion: await assertion() })).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    expect(fetched).not.toContain('https://claude.ai/jwks.json');
    delete (served[chatgpt] as Record<string, unknown>).jwks_uri;
    expect(await exchange({ client_assertion_type: ASSERTION, client_assertion: await assertion() })).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
    // Its keys unreachable: refused, not waved through.
    (served[chatgpt] as Record<string, unknown>).jwks_uri = jwksUri;
    delete served[jwksUri];
    expect(await exchange({ client_assertion_type: ASSERTION, client_assertion: await assertion() })).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
  });
});
