import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createTokenVerifier, loadOAuthConfig } from '../src/oauth.js';

const config = loadOAuthConfig({ AUTH_MODE: 'oauth', OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URI: 'https://identity.example/keys', OAUTH_RESOURCE: 'https://mail.example/mcp', OAUTH_OWNER_SUB: 'owner', OAUTH_CLIENT_IDS: 'client' })!;
const first = await generateKeyPair('RS256');
const second = await generateKeyPair('RS256');
async function token(pair = first, kid = 'first') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: 'owner', azp: 'client', scope: 'mail.read', iss: config.OAUTH_ISSUER, aud: config.OAUTH_RESOURCE, iat: now, exp: now + 300 }).setProtectedHeader({ alg: 'RS256', kid }).sign(pair.privateKey);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('refreshes rotated keys after cooldown and fails closed when expired cache cannot refresh', async () => {
  let now = Date.now(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const fetchKeys = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ keys: [{ ...await exportJWK(first.publicKey), kid: 'first' }] }));
  const verify = createTokenVerifier(config);
  await expect(verify(await token())).resolves.toEqual({ scopes: ['mail.read'] });
  await expect(verify(await token(second, 'second'))).rejects.toThrow();
  expect(fetchKeys).toHaveBeenCalledTimes(1);
  now += 31000; vi.setSystemTime(now);
  fetchKeys.mockResolvedValue(Response.json({ keys: [{ ...await exportJWK(second.publicKey), kid: 'second' }] }));
  await expect(verify(await token(second, 'second'))).resolves.toEqual({ scopes: ['mail.read'] });
  expect(fetchKeys).toHaveBeenCalledTimes(2);
  fetchKeys.mockRejectedValue(new Error('identity provider unavailable'));
  await expect(verify(await token(second, 'second'))).resolves.toEqual({ scopes: ['mail.read'] });
  now += 600001; vi.setSystemTime(now);
  await expect(verify(await token(second, 'second'))).rejects.toThrow();
});
it('rejects malformed key discovery and disallowed token algorithms', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ notKeys: [] }));
  await expect(createTokenVerifier(config)(await token())).rejects.toThrow();
  const hmac = await new SignJWT({ sub: 'owner' }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
  await expect(createTokenVerifier(config)(hmac)).rejects.toThrow();
});
