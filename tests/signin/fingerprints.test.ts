import { beforeEach, describe, expect, it } from 'vitest';
import { createSigninCodes } from '../../src/signin/codes.js';
import { createOwnerAuth, type OwnerAuth } from '../../src/signin/owner.js';
import { createFakeClock } from '../../testkit/src/fakeClock.js';
import { createSoftwareAuthenticator } from '../../testkit/src/softwareAuthenticator.js';

const site = { rpId: 'mail.example', origin: 'https://mail.example' };
let owner: OwnerAuth;
let lastCode: string;

beforeEach(() => {
  const clock = createFakeClock(new Date('2026-09-25T09:00:00Z'));
  const codes = createSigninCodes({
    clock, signInAddress: 'owner@example.invalid', senders: ['personal'],
    send: async (_account, _to, code) => { lastCode = code; }
  });
  owner = createOwnerAuth({ ...site, codes });
});

// A session approved by an emailed code.
async function withCode() {
  const session = owner.start();
  expect(await owner.requestCode(session, 'requester')).toEqual({ ok: true });
  expect(owner.enterCode(session, lastCode)).toEqual({ ok: true });
  return session;
}
// Register a passkey in a session, as a browser would.
async function register(session: string, device = createSoftwareAuthenticator()) {
  const options = await owner.beginRegistration(session);
  if (!options.ok) return options;
  return owner.finishRegistration(session, device.register({ ...site, challenge: options.options.challenge }));
}
async function signInWith(session: string, device: ReturnType<typeof createSoftwareAuthenticator>) {
  const options = await owner.beginAuthentication(session);
  if (!options.ok) return options;
  return owner.finishAuthentication(session, device.sign({ ...site, challenge: options.options.challenge }));
}

describe('fingerprints (passkeys)', () => {
  it('SIG-60 a fingerprint can be registered only in a session already approved by a code', async () => {
    const stranger = owner.start();
    expect(await owner.beginRegistration(stranger)).toEqual({ ok: false, reason: 'code_required' });
    const session = await withCode();
    expect(await register(session)).toEqual({ ok: true });
    expect(owner.level(session)).toBe('fingerprint');
  });

  it('SIG-61 granting Send requires a fingerprint', async () => {
    const device = createSoftwareAuthenticator();
    await register(await withCode(), device);
    const codeOnly = await withCode();
    expect(owner.mayGrant(codeOnly, { personal: ['read', 'send'] })).toEqual({ ok: false, reason: 'fingerprint_required' });
    const withFingerprint = owner.start();
    expect(await signInWith(withFingerprint, device)).toEqual({ ok: true });
    expect(owner.mayGrant(withFingerprint, { personal: ['read', 'organize', 'send'] })).toEqual({ ok: true });
  });

  it('SIG-62 adding a second fingerprint requires the first', async () => {
    const first = createSoftwareAuthenticator();
    await register(await withCode(), first);
    // A code alone no longer adds a fingerprint once one exists.
    expect(await register(await withCode())).toEqual({ ok: false, reason: 'fingerprint_required' });
    const session = owner.start();
    await signInWith(session, first);
    const second = createSoftwareAuthenticator();
    expect(await register(session, second)).toEqual({ ok: true });
    expect(await signInWith(owner.start(), second)).toEqual({ ok: true });
  });

  it('SIG-63 with no fingerprint saved, Read and Organize can be granted but Send can\'t', async () => {
    const session = await withCode();
    expect(owner.mayGrant(session, { personal: ['read', 'organize'], work: ['read'] })).toEqual({ ok: true });
    expect(owner.mayGrant(session, { personal: ['send'] })).toEqual({ ok: false, reason: 'fingerprint_required' });
    expect(await owner.beginAuthentication(session)).toEqual({ ok: false, reason: 'no_fingerprint' });
    // And nothing at all without signing in.
    expect(owner.mayGrant(owner.start(), { personal: ['read'] })).toEqual({ ok: false, reason: 'sign_in_required' });
  });

  it('SIG-64 a passkey response for another site, or a replayed challenge, is refused (added)', async () => {
    const device = createSoftwareAuthenticator();
    await register(await withCode(), device);
    const session = owner.start();
    const options = await owner.beginAuthentication(session);
    if (!options.ok) throw new Error('refused');
    const forged = device.sign({ rpId: 'attacker.example', origin: 'https://attacker.example', challenge: options.options.challenge });
    expect(await owner.finishAuthentication(session, forged)).toEqual({ ok: false, reason: 'fingerprint_invalid' });
    expect(owner.level(session)).toBe('none');
    // A good response for an old challenge: each challenge is used at most once.
    const good = device.sign({ ...site, challenge: options.options.challenge });
    expect(await owner.finishAuthentication(session, good)).toEqual({ ok: false, reason: 'fingerprint_invalid' });
  });
});
