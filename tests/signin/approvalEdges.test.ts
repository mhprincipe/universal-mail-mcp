import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSigninKeys, loadSigninKeys } from '../../src/signin/authorization.js';
import { createCanary } from '../../testkit/src/canary.js';
import { callback, claude, issuer, key, startApproval } from './approvalHarness.js';
import { exportJWK } from 'jose';

let a: Awaited<ReturnType<typeof startApproval>> | undefined;
afterEach(async () => { await a?.close(); a = undefined; });

// To the code page, with a code on its way.
async function toCodePage() {
  let page = await a!.open();
  page = await a!.post('/authorize/code', { csrf: a!.csrfIn(page.html) });
  return page;
}

describe('approval dead ends (SIG-77, added): each has a plain answer, and approves nothing', () => {
  it('a wrong code is explained; five end it', async () => {
    a = await startApproval();
    let page = await toCodePage();
    const wrong = a.codeIn().startsWith('2') ? `3${a.codeIn().slice(1)}` : `2${a.codeIn().slice(1)}`;
    page = await a.post('/authorize/verify', { csrf: a.csrfIn(page.html), code: wrong });
    expect(page.html).toContain("That code didn&#39;t match");
    for (let i = 0; i < 4; i++) page = await a.post('/authorize/verify', { csrf: a.csrfIn(page.html), code: wrong });
    expect(page.html).toContain('That code has ended');
    expect(a.app.signin.grants.get(claude)).toBeUndefined();
  });

  it('"Don\'t connect" returns to the app with access_denied, its state and our issuer', async () => {
    a = await startApproval();
    const page = await a.open();
    const denied = await a.post('/authorize/deny', { csrf: a.csrfIn(page.html) });
    expect(denied.response.status).toBe(302);
    const back = new URL(denied.response.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(callback);
    expect(Object.fromEntries(back.searchParams)).toEqual({ error: 'access_denied', state: 'st-1', iss: issuer });
    expect(a.sent).toEqual([]);
  });

  it('approving nothing, or Send without a fingerprint, is refused with the reason', async () => {
    a = await startApproval();
    let page = await toCodePage();
    page = await a.post('/authorize/verify', { csrf: a.csrfIn(page.html), code: a.codeIn() });
    const nothing = await a.post('/authorize/approve', { csrf: a.csrfIn(page.html) });
    expect(nothing.html).toContain('Choose at least one account.');
    // The Send box is disabled on the page; posting it anyway changes nothing.
    const forced = await a.post('/authorize/approve', { csrf: a.csrfIn(nothing.html), 'personal:read': 'on', 'personal:send': 'on' });
    expect(forced.response.status).toBe(200);
    expect(forced.html).toContain('Sending needs your fingerprint.');
    expect(a.app.signin.grants.get(claude)).toBeUndefined();
  });

  it('a page left open over 15 minutes has expired', async () => {
    a = await startApproval();
    const page = await a.open();
    a.clock.advance(15 * 60_000 + 1_000);
    const late = await a.post('/authorize/code', { csrf: a.csrfIn(page.html) });
    expect(late.response.status).toBe(403);
    expect(late.html).toContain('This page expired');
    expect(a.sent).toEqual([]);
  });

  it('too many codes, or a code that can\'t be emailed, is said plainly', async () => {
    a = await startApproval();
    for (let i = 0; i < 3; i++) await toCodePage();
    const page = await a.open();
    const limited = await a.post('/authorize/code', { csrf: a.csrfIn(page.html) });
    expect(limited.response.status).toBe(429);
    expect(limited.html).toContain('Too many codes');
    await a.close();

    a = await startApproval();
    a.broken.add('personal');
    a.broken.add('work');
    const again = await a.open();
    const unsent = await a.post('/authorize/code', { csrf: a.csrfIn(again.html) });
    expect(unsent.response.status).toBe(503);
    expect(unsent.html).toContain("couldn&#39;t be emailed");
  });
});

describe('keys', () => {
  it('SIG-28 the keys load from the credentials secret; bad keys fail plainly, without echoing them (added)', async () => {
    const generated = await generateSigninKeys();
    const jwk = await exportJWK(generated.signing.privateKey);
    const loaded = await loadSigninKeys({
      SIGNIN_SIGNING_KEY: JSON.stringify(jwk), SIGNIN_ENCRYPTION_KEY: Buffer.from(generated.encryption).toString('base64url')
    });
    expect(await exportJWK(loaded.signing.publicKey)).toEqual(await exportJWK(generated.signing.publicKey));
    expect(Buffer.from(loaded.encryption)).toEqual(Buffer.from(generated.encryption));

    const secret = createCanary('signing-key');
    await expect(loadSigninKeys({ SIGNIN_SIGNING_KEY: secret, SIGNIN_ENCRYPTION_KEY: 'x' })).rejects.toThrow(/^SIGNIN_SIGNING_KEY isn't a valid key\.$/);
    await expect(loadSigninKeys({ SIGNIN_SIGNING_KEY: JSON.stringify(jwk), SIGNIN_ENCRYPTION_KEY: secret })).rejects.toThrow(/^SIGNIN_ENCRYPTION_KEY must be 32 bytes/);
  });

  it('SIG-29 /jwks publishes the public key only, and it verifies our tokens; /revoke answers 200 (added)', async () => {
    a = await startApproval();
    const approved = await a.approve({ 'personal:read': 'on' });
    const code = new URL(approved.response.headers.get('location')!).searchParams.get('code')!;
    const tokens = await (await fetch(`${a.base}/token`, { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: callback, client_id: claude, code_verifier: a.verifier
    }) })).json();
    const jwks = await (await fetch(`${a.base}/jwks`)).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0].d).toBeUndefined();
    const { payload } = await jwtVerify(tokens.access_token, createLocalJWKSet(jwks), { issuer, audience: `${issuer}/${key}/mcp` });
    expect(payload.client_id).toBe(claude);

    const revoked = await fetch(`${a.base}/revoke`, { method: 'POST', body: new URLSearchParams({ token: tokens.refresh_token }) });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get('cache-control')).toBe('no-store');
  });
});
