import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { GRACE_DAYS, TRIAL_DAYS, subscriptionState, verifyLicense, type License } from '../../src/subscription/state.js';

// SUB-01, SUB-02 (design §13.2): what the subscription is right now, from
// the install date, the license and the clock; and what counts as a license.
const DAY = 24 * 60 * 60_000;
const INSTALLED = '2026-09-28T10:00:00.000Z';
const t0 = Date.parse(INSTALLED);
const SERVICE = 'https://license.example.invalid';
const INSTALL = 'install-abc';

async function publisher() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  const keys = { keys: [{ ...jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] as JWK[] };
  const sign = async (claims: { exp: number; aud?: string; iss?: string; plan?: string; portal?: string; sub?: string }) =>
    new SignJWT({ plan: claims.plan ?? 'monthly', ...(claims.portal ? { portal: claims.portal } : {}) })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'um-license+jwt' })
      .setIssuer(claims.iss ?? SERVICE).setSubject(claims.sub ?? 'UM-AAAA-BBBB-CCCC').setAudience(claims.aud ?? INSTALL)
      .setIssuedAt(Math.floor(t0 / 1000)).setExpirationTime(Math.floor(claims.exp / 1000)).sign(privateKey);
  const license = async (claims: Parameters<typeof sign>[0]): Promise<License> => ({ code: claims.sub ?? 'UM-AAAA-BBBB-CCCC', token: await sign(claims), keys });
  return { keys, sign, license, privateKey };
}

describe('the subscription state', () => {
  it('SUB-01 a fresh install is a trial with the days left; then grace; then read-only', () => {
    expect(subscriptionState({ installedAt: INSTALLED, now: t0 })).toEqual({ state: 'trial', daysLeft: TRIAL_DAYS });
    expect(subscriptionState({ installedAt: INSTALLED, now: t0 + 23 * DAY })).toEqual({ state: 'trial', daysLeft: 7 });
    expect(subscriptionState({ installedAt: INSTALLED, now: t0 + 29 * DAY + DAY / 2 })).toEqual({ state: 'trial', daysLeft: 1 });
    expect(subscriptionState({ installedAt: INSTALLED, now: t0 + TRIAL_DAYS * DAY })).toEqual({ state: 'grace', after: 'trial', daysLeft: GRACE_DAYS });
    expect(subscriptionState({ installedAt: INSTALLED, now: t0 + (TRIAL_DAYS + GRACE_DAYS) * DAY - 1 })).toEqual({ state: 'grace', after: 'trial', daysLeft: 1 });
    expect(subscriptionState({ installedAt: INSTALLED, now: t0 + (TRIAL_DAYS + GRACE_DAYS) * DAY })).toEqual({ state: 'read-only', after: 'trial' });
  });

  it('SUB-01 a verified license: active until paid through, then grace, then read-only; it outranks the trial', () => {
    const paidThrough = t0 + 60 * DAY;
    const verified = { paidThrough, plan: 'monthly', portal: 'https://pay.example.invalid/manage' };
    expect(subscriptionState({ installedAt: INSTALLED, verified, now: t0 + 50 * DAY })).toEqual({ state: 'active', paidThrough: new Date(paidThrough).toISOString(), plan: 'monthly', portal: verified.portal, daysLeft: 10 });
    expect(subscriptionState({ installedAt: INSTALLED, verified, now: t0 + 60 * DAY })).toEqual({ state: 'grace', after: 'subscription', daysLeft: GRACE_DAYS });
    expect(subscriptionState({ installedAt: INSTALLED, verified, now: t0 + 74 * DAY })).toEqual({ state: 'read-only', after: 'subscription' });
    // Paid, though the trial would still be running: active.
    expect(subscriptionState({ installedAt: INSTALLED, verified, now: t0 + 5 * DAY }).state).toBe('active');
  });

  it('SUB-01 no install date, or no service configured, is unlimited: nothing is ever refused', () => {
    expect(subscriptionState({ now: t0 + 400 * DAY })).toEqual({ state: 'unlimited' });
    expect(subscriptionState({ installedAt: 'not a date', now: t0 })).toEqual({ state: 'unlimited' });
    expect(subscriptionState({ installedAt: INSTALLED, unlimited: true, now: t0 + 400 * DAY })).toEqual({ state: 'unlimited' });
  });

  it('SUB-02 the service\'s signed token, for this install, is a license: its paid-through date, plan and portal', async () => {
    const p = await publisher();
    const license = await p.license({ exp: t0 + 31 * DAY, portal: 'https://pay.example.invalid/manage' });
    expect(await verifyLicense(license, { install: INSTALL, service: SERVICE, now: t0 })).toEqual({
      paidThrough: Math.floor((t0 + 31 * DAY) / 1000) * 1000, plan: 'monthly', portal: 'https://pay.example.invalid/manage'
    });
    // A year past its date is still a license (grace and read-only come from the state, not from here).
    expect(await verifyLicense(license, { install: INSTALL, service: SERVICE, now: t0 + 400 * DAY })).toMatchObject({ plan: 'monthly' });
  });

  it('SUB-02 tampered, another key, another install, another issuer, another kind of token: not a license, and the reason logged without the token', async () => {
    const p = await publisher();
    const other = await publisher();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const good = await p.license({ exp: t0 + 31 * DAY });
    const cases: Array<[string, License]> = [
      ['tampered', { ...good, token: good.token.slice(0, -4) + 'AAAA' }],
      ['another key', { ...good, token: (await other.license({ exp: t0 + 31 * DAY })).token }],
      ['another install', await p.license({ exp: t0 + 31 * DAY, aud: 'someone-else' })],
      ['another issuer', await p.license({ exp: t0 + 31 * DAY, iss: 'https://evil.example.invalid' })],
      ['another code than the one pasted', { ...good, code: 'UM-ZZZZ-ZZZZ-ZZZZ' }],
      ['not a token', { ...good, token: 'nope' }],
      ['no keys', { ...good, keys: { keys: [] } }]
    ];
    for (const [name, license] of cases) {
      expect(await verifyLicense(license, { install: INSTALL, service: SERVICE, now: t0 }), name).toBeUndefined();
    }
    const logged = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toHaveLength(cases.length);
    for (const entry of logged) {
      expect(entry).toMatchObject({ event: 'license_rejected' });
      expect(typeof entry.reason).toBe('string');
      expect(JSON.stringify(entry)).not.toContain(good.token.slice(0, 20));
    }
    log.mockRestore();
  });
});
