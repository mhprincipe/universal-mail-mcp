import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mintCheckToken } from '../../src/setup/checkToken.js';
import { VERSION } from '../../src/version.js';
import { KEY, PUBLIC_URL, startPage } from './pageHarness.js';

// DIA-10 (added: found on the first live install, 2026-09-27). Setup's step 8
// sends its check token to /{key}/check; your page's "Check that everything
// works" button posts to the same address. On the installed server the page's
// route came first, found no browser session and answered 403, three times:
// setup said "The server didn't answer its check". DIA-08 tested the check
// route on a server without the page; this is the installed server, whole.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

// Setup's request, as selfTest.ts makes it, to the service's own host name.
function setupCheck(base: string, token: string | undefined) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(new URL(base).port), method: 'POST', path: `/${KEY}/check`,
      headers: { host: new URL(PUBLIC_URL).host, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, body: text })); });
    req.on('error', reject);
    req.end(JSON.stringify({ expectedVersion: VERSION }));
  });
}

describe('setup\'s check, on the installed server', () => {
  it('DIA-10 setup\'s token reaches the check, not your page\'s button: the report comes back (added: found live)', async () => {
    p = await startPage();
    const token = mintCheckToken(p.records.credentials.signingKey as never, { issuer: PUBLIC_URL, audience: `${PUBLIC_URL}/${KEY}/check`, now: p.clock.now() });
    const answer = await setupCheck(p.base, token);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ report: 'universal-mail-check', version: VERSION });
  }, 60_000);

  it('DIA-10 without a token it is still refused, and your page\'s button still needs you signed in', async () => {
    p = await startPage();
    // No token: a browser's request, so your page answers it, and no report is given.
    const bare = await setupCheck(p.base, undefined);
    expect(bare.status).toBe(403);
    expect(bare.body).not.toContain('universal-mail-check');
    // A token that isn't setup's: refused by the check itself.
    expect((await setupCheck(p.base, 'not-a-real-token')).status).toBe(401);
    // The page's own Check: a form post without a session is refused as before.
    expect((await p.post('/check', { csrf: 'none' })).response.status).toBe(403);
  });
});
