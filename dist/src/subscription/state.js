import { createLocalJWKSet, jwtVerify } from 'jose';
// The subscription (design §13.2): what it is right now, from the install
// date, the license and the clock; and what counts as a license.
export const TRIAL_DAYS = 30;
export const GRACE_DAYS = 14;
export const LICENSE_TOKEN_TYPE = 'um-license+jwt';
const DAY = 24 * 60 * 60_000;
// Days until `until`, counting a started day as one: the day it ends, zero.
const daysUntil = (until, now) => Math.ceil((until - now) / DAY);
export function subscriptionState(input) {
    const installedAt = Date.parse(input.installedAt ?? '');
    // A build without a license service, or no install date: never gated.
    if (input.unlimited || !Number.isFinite(installedAt))
        return { state: 'unlimited' };
    const { now } = input;
    if (input.verified) {
        const { paidThrough, plan, portal } = input.verified;
        if (now < paidThrough)
            return { state: 'active', paidThrough: new Date(paidThrough).toISOString(), plan, ...(portal ? { portal } : {}), daysLeft: daysUntil(paidThrough, now) };
        const graceEnds = paidThrough + GRACE_DAYS * DAY;
        if (now < graceEnds)
            return { state: 'grace', after: 'subscription', daysLeft: daysUntil(graceEnds, now) };
        return { state: 'read-only', after: 'subscription' };
    }
    const trialEnds = installedAt + TRIAL_DAYS * DAY;
    if (now < trialEnds)
        return { state: 'trial', daysLeft: daysUntil(trialEnds, now) };
    const graceEnds = trialEnds + GRACE_DAYS * DAY;
    if (now < graceEnds)
        return { state: 'grace', after: 'trial', daysLeft: daysUntil(graceEnds, now) };
    return { state: 'read-only', after: 'trial' };
}
// A license is the service's signed token for this install. Anything else is
// no license: the reason is logged (jose's code), never the token.
export async function verifyLicense(license, options) {
    try {
        const { payload } = await jwtVerify(license.token, createLocalJWKSet(license.keys), {
            issuer: options.service, audience: options.install, typ: LICENSE_TOKEN_TYPE, algorithms: ['ES256'],
            // Expiry is the paid-through date: the state decides what an old one means.
            currentDate: new Date(0), clockTolerance: Number.MAX_SAFE_INTEGER
        });
        if (typeof payload.exp !== 'number' || typeof payload.plan !== 'string' || payload.sub !== license.code)
            throw Object.assign(new Error('claims'), { code: 'ERR_LICENSE_CLAIMS' });
        return { paidThrough: payload.exp * 1000, plan: payload.plan, ...(typeof payload.portal === 'string' ? { portal: payload.portal } : {}) };
    }
    catch (error) {
        const code = error?.code;
        console.log(JSON.stringify({ event: 'license_rejected', reason: typeof code === 'string' ? code : error?.name ?? 'unknown' }));
        return undefined;
    }
}
//# sourceMappingURL=state.js.map