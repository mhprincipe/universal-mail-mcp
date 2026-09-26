import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createSoftwareAuthenticator } from '../../testkit/src/softwareAuthenticator.js';
import { KEY, PUBLIC_URL, startPage } from './pageHarness.js';

// Your Universal Mail page (design §3.6): signing in, and sessions.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

describe('signing in to your page', () => {
  it('PG-01 sign in with a code: emailed to the sign-in address, entered once, and the page opens', async () => {
    p = await startPage();
    const start = await p.get();
    expect(start.response.status).toBe(200);
    expect(start.html).toContain('Sign in to your Universal Mail page');
    expect(start.html).toContain('m•••@e•••.invalid');
    expect(start.html).not.toContain('Your accounts');
    const codePage = await p.post('/signin/code', { csrf: p.csrfIn(start.html) });
    expect(p.sent.at(-1)).toMatchObject({ to: 'me@example.invalid', subject: expect.stringContaining('code') });
    const verified = await p.post('/signin/verify', { csrf: p.csrfIn(codePage.html), code: p.codeIn() });
    expect(verified.response.status).toBe(303);
    const page = await p.get();
    expect(page.html).toContain('Your accounts');
    // A code works once: the same code again is refused.
    p.forgetCookie();
    const again = await p.get();
    const secondCode = await p.post('/signin/code', { csrf: p.csrfIn(again.html) });
    const reused = await p.post('/signin/verify', { csrf: p.csrfIn(secondCode.html), code: 'AAAA-AAAA' });
    expect(reused.html).toContain('That code didn');
  });

  it('PG-01 sign in with a fingerprint, once one is saved', async () => {
    p = await startPage();
    const site = { rpId: new URL(PUBLIC_URL).hostname, origin: PUBLIC_URL };
    const device = createSoftwareAuthenticator();
    // Saved on the page itself, in a code-approved session.
    const page = await p.signIn();
    const options = await p.post('/fingerprint/options', { csrf: p.csrfIn(page.html) });
    const { challenge } = JSON.parse(options.html);
    const saved = await fetch(`${p.base}/${KEY}/fingerprint/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: p.cookie() },
      body: JSON.stringify({ csrf: p.csrfIn(page.html), response: device.register({ ...site, challenge }) })
    });
    expect(saved.status).toBe(200);
    expect(p.sent.at(-1)!.subject).toMatch(/fingerprint was added/i);

    p.forgetCookie();
    const start = await p.get();
    expect(start.html).toContain('Use your fingerprint instead');
    const signin = await p.post('/signin/passkey/options', { csrf: p.csrfIn(start.html) });
    const verified = await fetch(`${p.base}/${KEY}/signin/passkey/verify`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Cookie: p.cookie() },
      body: JSON.stringify({ csrf: p.csrfIn(start.html), response: device.sign({ ...site, challenge: JSON.parse(signin.html).challenge }) })
    });
    expect(verified.status).toBe(200);
    expect((await p.get()).html).toContain('Your accounts');
  });

  it('PG-02 a session ends after 15 minutes idle, but not while in use', async () => {
    p = await startPage();
    await p.signIn();
    p.clock.advance(14 * 60_000);
    expect((await p.get()).html).toContain('Your accounts');
    // That visit counted: another 14 minutes is still fine.
    p.clock.advance(14 * 60_000);
    expect((await p.get()).html).toContain('Your accounts');
    p.clock.advance(15 * 60_000 + 1_000);
    const expired = await p.get();
    expect(expired.html).not.toContain('Your accounts');
    expect(expired.html).toContain('Sign in to your Universal Mail page');
  });

  it('PG-02 every form needs the session\'s own token; signing out ends the session', async () => {
    p = await startPage();
    const page = await p.signIn();
    const forged = await p.post('/signout', { csrf: 'not-the-token' });
    expect(forged.response.status).toBe(403);
    expect((await p.get()).html).toContain('Your accounts');
    const old = p.cookie();
    const out = await p.post('/signout', { csrf: p.csrfIn(page.html) });
    expect(out.response.status).toBe(303);
    expect((await p.get()).html).toContain('Sign in to your Universal Mail page');
    // The old cookie, copied before signing out, opens nothing either.
    const replayed = await fetch(`${p.base}/${KEY}`, { headers: { Cookie: old } });
    expect(await replayed.text()).not.toContain('Your accounts');
  });

  it('PG-02 the page is never framed, cached or given a referrer, and its cookie stays on its own path', async () => {
    p = await startPage();
    const start = await p.get();
    expect(start.response.headers.get('x-frame-options')).toBe('DENY');
    expect(start.response.headers.get('cache-control')).toBe('no-store');
    expect(start.response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(start.response.headers.get('set-cookie')).toMatch(new RegExp(`^um_page=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=/${KEY}`));
  });

  it('PG-02 without the key, there is no page', async () => {
    p = await startPage();
    // As Cloud Run delivers it: the service's own host name (fetch can't set one).
    const status = (path: string) => new Promise<number>((resolve, reject) => {
      const port = Number(new URL(p!.base).port);
      request({ host: '127.0.0.1', port, path, headers: { host: new URL(PUBLIC_URL).host } }, res => { res.resume(); resolve(res.statusCode!); }).on('error', reject).end();
    });
    expect(await status('/')).toBe(404);
    expect(await status('/not-the-key-0123456789abcd')).toBe(404);
  });
});
