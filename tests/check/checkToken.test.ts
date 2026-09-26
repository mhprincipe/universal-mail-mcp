import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SignJWT, importJWK, type CryptoKey } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizationServer, type SigninKeys } from '../../src/signin/authorization.js';
import { mintCheckToken } from '../../src/setup/checkToken.js';
import { VERSION } from '../../src/version.js';
import { createFakeClock, type FakeClock } from '../../testkit/src/fakeClock.js';

// DIA-07 (added): setup asks the server to check itself with a token only it
// can make: signed with the key setup generated, for five minutes, once. It
// is minted with Node's built-ins (setup has no other code) and verified with jose.
const issuer = 'https://mail.example';
const resource = `${issuer}/key-for-tests-0123456789/mcp`;
const checkAudience = `${issuer}/key-for-tests-0123456789/check`;

// The signing key exactly as setup keeps it in universal-mail-credentials.
function setupKey(): JsonWebKey {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
}
async function keysFrom(jwk: JsonWebKey): Promise<SigninKeys> {
  const { d: _d, ...pub } = jwk;
  return {
    signing: { privateKey: await importJWK(jwk as never, 'ES256') as CryptoKey, publicKey: await importJWK(pub as never, 'ES256') as CryptoKey },
    encryption: new Uint8Array(32)
  };
}

let clock: FakeClock;
let jwk: JsonWebKey;
let auth: ReturnType<typeof createAuthorizationServer>;
beforeEach(async () => {
  clock = createFakeClock(new Date('2026-09-25T12:00:00Z'));
  jwk = setupKey();
  auth = createAuthorizationServer({
    issuer, resource, trustedOrigins: [], keys: await keysFrom(jwk), clock,
    documents: { resolve: vi.fn(), get: vi.fn() }
  });
});
const mint = (overrides: Partial<Parameters<typeof mintCheckToken>[1]> = {}, key = jwk) =>
  mintCheckToken(key, { issuer, audience: checkAudience, now: clock.now(), ...overrides });

describe('the check token', () => {
  it('DIA-07 a token setup mints with Node\'s built-ins is accepted by the server, once (added)', async () => {
    const token = mint();
    await expect(auth.verifyCheck(token)).resolves.toBeUndefined();
    await expect(auth.verifyCheck(token)).rejects.toMatchObject({ reason: 'token_reused' });
    // A fresh one works.
    await expect(auth.verifyCheck(mint())).resolves.toBeUndefined();
  });

  it('DIA-07 refused: expired, too long-lived, for another address, from another key, or not a check token', async () => {
    const expired = mint();
    clock.advance(5 * 60 * 1000 + 1000);
    await expect(auth.verifyCheck(expired)).rejects.toMatchObject({ reason: 'token_expired' });

    await expect(auth.verifyCheck(mint({ lifetimeSeconds: 3600 }))).rejects.toMatchObject({ reason: 'token_invalid' });
    // Dated tomorrow: its five minutes would start a day from now.
    await expect(auth.verifyCheck(mint({ now: clock.now() + 24 * 3600 * 1000 }))).rejects.toMatchObject({ reason: 'token_invalid' });
    await expect(auth.verifyCheck(mint({ audience: resource }))).rejects.toMatchObject({ reason: 'token_invalid' });
    await expect(auth.verifyCheck(mint({}, setupKey()))).rejects.toMatchObject({ reason: 'token_invalid' });

    // Right key, right audience, but not marked as a check token.
    // Dated by the test clock, so only its missing type can be wrong.
    const at = Math.floor(clock.now() / 1000);
    const untyped = await new SignJWT({}).setProtectedHeader({ alg: 'ES256' }).setIssuer(issuer).setAudience(checkAudience)
      .setIssuedAt(at).setExpirationTime(at + 120).setJti('j-1').sign((await keysFrom(jwk)).signing.privateKey);
    await expect(auth.verifyCheck(untyped)).rejects.toMatchObject({ reason: 'token_invalid' });
    await expect(auth.verifyCheck('not.a.token')).rejects.toMatchObject({ reason: 'token_invalid' });
  });

  it('DIA-07 a check token never opens the mail tools', async () => {
    await expect(auth.verifyAccess(mint())).rejects.toMatchObject({ reason: 'token_invalid' });
    await expect(auth.verifyAccess(mint({ audience: resource }))).rejects.toMatchObject({ reason: 'token_invalid' });
  });

  it('DIA-07 sign-in\'s own round trip: it issues an access token and verifies it; damaged keys fail it', async () => {
    await expect(auth.roundTrip()).resolves.toBe(true);
    // The private key from one pair, the public key from another.
    const other = await keysFrom(setupKey());
    const damaged = createAuthorizationServer({
      issuer, resource, trustedOrigins: [], clock, documents: { resolve: vi.fn(), get: vi.fn() },
      keys: { ...(await keysFrom(jwk)), signing: { privateKey: (await keysFrom(jwk)).signing.privateKey, publicKey: other.signing.publicKey } }
    });
    await expect(damaged.roundTrip()).resolves.toBe(false);
  });

  it('DIA-07 the server knows its own version, the one in package.json', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  });
});
