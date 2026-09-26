import { describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { loadOAuthConfig, createTokenVerifier, requiredScopes } from '../src/oauth.js';

const env = { AUTH_MODE: 'oauth', OAUTH_ISSUER: 'https://identity.example/', OAUTH_JWKS_URI: 'https://identity.example/.well-known/jwks.json', OAUTH_RESOURCE: 'https://mail.example/mcp', OAUTH_OWNER_SUB: 'owner-123', OAUTH_CLIENT_IDS: 'chatgpt-test,claude-test' };
const keys = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
const config = loadOAuthConfig(env)!;
const verify = createTokenVerifier(config, createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }));
async function token(overrides: Record<string, unknown> = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: env.OAUTH_ISSUER, aud: env.OAUTH_RESOURCE, sub: env.OAUTH_OWNER_SUB, azp: 'chatgpt-test', scope: 'mail.read', iat: now, exp: now + 300, ...overrides }).setProtectedHeader({ alg: 'RS256' }).sign(key);
}
describe('OAuth trust boundary', () => {
  it.each(['chatgpt-test', 'claude-test'])('accepts the owner through %s', async azp => {
    expect((await verify(await token({ azp }))).scopes).toEqual(['mail.read']);
  });
  it.each([
    { iss: 'https://attacker.example/' }, { aud: 'some-other-api' }, { sub: 'other-user' }, { azp: 'other-client' },
    { exp: 1 }, { nbf: 9999999999 }, { iat: 9999999999 }, { exp: 9999999999 }, { scope: ['mail.read'] }, { iat: undefined }, { exp: undefined }
  ])('rejects invalid claims %j', async claims => { await expect(verify(await token(claims))).rejects.toThrow(); });
  it('accepts a CIMD URL as azp when explicitly allowlisted, and only then', async () => {
    // Auth0 puts a CIMD client's external URL in azp, not the internal tpc_ id
    // it shows in the dashboard. Both identify one client; neither is a wildcard.
    const cimd = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const withUrl = loadOAuthConfig({ ...env, OAUTH_CLIENT_IDS: `tpc_internalId,${cimd}` })!;
    const verifyUrl = createTokenVerifier(withUrl, createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }));
    expect((await verifyUrl(await token({ azp: cimd }))).scopes).toEqual(['mail.read']);
    expect((await verifyUrl(await token({ azp: 'tpc_internalId' }))).scopes).toEqual(['mail.read']);
    await expect(verifyUrl(await token({ azp: 'https://attacker.example/client.json' }))).rejects.toMatchObject({ reason: 'azp_not_allowed' });
  });
  it('names the failing check so a rejection is diagnosable without logging the token', async () => {
    // Six distinct causes previously returned one indistinguishable 401.
    await expect(verify(await token({ sub: 'other-user' }))).rejects.toMatchObject({ reason: 'sub_mismatch' });
    await expect(verify(await token({ azp: 'other-client' }))).rejects.toMatchObject({ reason: 'azp_not_allowed' });
    await expect(verify(await token({ azp: undefined }))).rejects.toMatchObject({ reason: expect.stringContaining('azp') });
    await expect(verify(await token({ scope: undefined }))).rejects.toMatchObject({ reason: expect.stringContaining('scope') });
    await expect(verify(await token({ exp: Math.floor(Date.now() / 1000) + 4000 }))).rejects.toMatchObject({ reason: 'lifetime_too_long' });
    await expect(verify(await token({ iss: 'https://attacker.example/' }))).rejects.toMatchObject({ reason: expect.stringContaining('jwt') });
  });
  it('never puts token or claim values in the rejection reason', async () => {
    const failure = await verify(await token({ azp: 'secret-client-identifier' })).catch(e => e);
    expect(failure.reason).toBe('azp_not_allowed');
    expect(JSON.stringify(failure.reason)).not.toContain('secret-client-identifier');
  });
  it('rejects another signing key and opaque legacy secrets', async () => {
    await expect(verify(await token({}, other.privateKey))).rejects.toThrow();
    await expect(verify('old-static-bearer-secret')).rejects.toThrow();
  });
  it('fails closed on incomplete or insecure configuration', () => {
    expect(loadOAuthConfig({})).toBeUndefined();
    expect(() => loadOAuthConfig({ AUTH_MODE: 'typo' })).toThrow();
    expect(() => loadOAuthConfig({ AUTH_MODE: 'oauth' })).toThrow();
    expect(() => loadOAuthConfig({ ...env, OAUTH_JWKS_URI: 'http://identity.example/keys' })).toThrow();
  });
  it('assigns separate write and send permissions and denies unknown tools', () => {
    expect(requiredScopes('get_email')).toEqual(['mail.read']);
    expect(requiredScopes('trash_email')).toEqual(['mail.read', 'mail.write']);
    expect(requiredScopes('send_email')).toEqual(['mail.read', 'mail.send']);
    expect(() => requiredScopes('unknown_tool')).toThrow();
  });
});
