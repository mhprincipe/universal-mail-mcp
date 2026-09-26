import { afterEach, describe, expect, it } from 'vitest';
import { createSoftwareAuthenticator } from '../../testkit/src/softwareAuthenticator.js';
import { claude, issuer, startApproval } from './approvalHarness.js';

let a: Awaited<ReturnType<typeof startApproval>> | undefined;
afterEach(async () => { await a?.close(); a = undefined; });

describe('fingerprints on the approval page', () => {
  it('SIG-65 a fingerprint on the approval page unlocks Send, without an emailed code (added)', async () => {
    a = await startApproval();
    const site = { rpId: new URL(issuer).hostname, origin: issuer };
    // A fingerprint saved earlier, as your Universal Mail page will do it: in a code-approved session.
    const device = createSoftwareAuthenticator();
    const owner = a.app.signin.owner;
    const setup = owner.start();
    await owner.requestCode(setup, 'setup');
    owner.enterCode(setup, a.codeIn());
    const registration = await owner.beginRegistration(setup);
    if (!registration.ok) throw new Error(registration.reason);
    expect(await owner.finishRegistration(setup, device.register({ ...site, challenge: registration.options.challenge }))).toEqual({ ok: true });
    const emailsBefore = a.sent.length;

    // Now the approval page, fingerprint only.
    const page = await a.open();
    const csrf = a.csrfIn(page.html);
    expect(page.html).toContain('/authorize/passkey.js');
    const options = await a.post('/authorize/passkey/options', { csrf });
    expect(options.response.headers.get('content-type')).toContain('application/json');
    const { challenge } = JSON.parse(options.html);
    const verified = await fetch(`${a.base}/authorize/passkey/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: (await cookieOf(a)) },
      body: JSON.stringify({ csrf, response: device.sign({ ...site, challenge }) })
    });
    const permissions = await verified.text();
    expect(verified.status).toBe(200);
    const send = /<input[^>]*name="personal:send"[^>]*>/.exec(permissions)?.[0] ?? '';
    expect(send).not.toContain('disabled');
    expect(send).not.toContain('checked');

    const approved = await a.post('/authorize/approve', { csrf: a.csrfIn(permissions), 'personal:read': 'on', 'personal:send': 'on' });
    expect(approved.response.status).toBe(302);
    expect(a.app.signin.grants.get(claude)?.accounts).toEqual({ personal: ['read', 'send'] });
    // No code was emailed for this approval: only the "connected" notice.
    expect(a.sent.slice(emailsBefore).map(s => s.subject)).toEqual([expect.stringMatching(/connected/)]);
  });
});

describe('fingerprint refusals on the approval page', () => {
  it('SIG-65 no saved fingerprint: nothing to offer; a forged one: refused and logged', async () => {
    a = await startApproval();
    const page = await a.open();
    expect(page.html).not.toContain('/authorize/passkey.js');
    const none = await a.post('/authorize/passkey/options', { csrf: a.csrfIn(page.html) });
    expect(none.response.status).toBe(400);
    expect(JSON.parse(none.html)).toEqual({ error: 'no_fingerprint' });

    // Save one, then answer with a signature made for another site.
    const device = createSoftwareAuthenticator();
    const site = { rpId: new URL(issuer).hostname, origin: issuer };
    const owner = a.app.signin.owner;
    const setup = owner.start();
    await owner.requestCode(setup, 'setup');
    owner.enterCode(setup, a.codeIn());
    const registration = await owner.beginRegistration(setup);
    if (!registration.ok) throw new Error(registration.reason);
    await owner.finishRegistration(setup, device.register({ ...site, challenge: registration.options.challenge }));
    const fresh = await a.open();
    const csrf = a.csrfIn(fresh.html);
    const { challenge } = JSON.parse((await a.post('/authorize/passkey/options', { csrf })).html);
    const forged = await fetch(`${a.base}/authorize/passkey/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a.cookie() },
      body: JSON.stringify({ csrf, response: device.sign({ rpId: 'attacker.example', origin: 'https://attacker.example', challenge }) })
    });
    expect(forged.status).toBe(403);
    expect(a.app.signin.refusals()[claude]).toEqual({ fingerprint_invalid: 1 });
    expect(a.app.signin.grants.get(claude)).toBeUndefined();
  });
});

// The harness keeps its cookie internally; a POST through it records the latest.
async function cookieOf(approval: Awaited<ReturnType<typeof startApproval>>) {
  return approval.cookie();
}
