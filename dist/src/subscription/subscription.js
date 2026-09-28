import { randomBytes } from 'node:crypto';
import { decodeJwt } from 'jose';
import { GRACE_DAYS, subscriptionState, verifyLicense } from './state.js';
// The subscription on the installed server (design §13.2): the state right
// now, activation from your page, daily renewal, the emails, and the one
// sentence the mail router refuses organizing and sending with.
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const TRIAL_ENDING_DAYS = 7;
const CODE_SHAPE = /^UM-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;
export const longDate = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export function createSubscription(deps) {
    const { store, clock, pageUrl } = deps;
    const service = deps.serviceUrl?.replace(/\/$/, '');
    const fetchImpl = deps.fetchImpl ?? fetch;
    let verified;
    let remindersChecked = -Infinity;
    const noted = () => store.noted();
    const installId = () => {
        const id = noted().installId;
        if (typeof id === 'string' && id)
            return id;
        const fresh = randomBytes(16).toString('base64url');
        store.note({ installId: fresh });
        return fresh;
    };
    const verify = async (license) => {
        if (!license || !service)
            return undefined;
        return verifyLicense(license, { install: installId(), service, now: clock.now() });
    };
    const current = () => subscriptionState({ installedAt: noted().installedAt, verified, unlimited: !service, now: clock.now() });
    const call = async (path, body) => {
        try {
            const response = await fetchImpl(`${service}${path}`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error'
            });
            let parsed = {};
            try {
                parsed = await response.json();
            }
            catch { /* an empty or odd body */ }
            return { kind: 'answered', status: response.status, body: (parsed && typeof parsed === 'object' ? parsed : {}) };
        }
        catch (error) {
            console.log(JSON.stringify({ event: 'license_service_unreachable', path, error: error?.name ?? typeof error }));
            return { kind: 'unreachable' };
        }
    };
    // A service answer that is a license for this install becomes the license.
    // Without a code (bought from the page, bound by install), the token names it.
    const take = async (body, code) => {
        if (typeof body.token !== 'string' || !body.keys || typeof body.keys !== 'object')
            return false;
        let named = code;
        if (!named) {
            try {
                named = decodeJwt(body.token).sub;
            }
            catch {
                return false;
            }
        }
        if (!named)
            return false;
        const license = { code: named, token: body.token, keys: body.keys, renewedAt: new Date(clock.now()).toISOString() };
        const checked = await verify(license);
        if (!checked)
            return false;
        verified = checked;
        const { 'not-renewed': _a, 'read-only:subscription': _b, ...notices } = noted().subscriptionNotices ?? {};
        store.note({ license, subscriptionNotices: notices });
        return true;
    };
    const notices = {
        'trial-ending': (state) => [`Your Universal Mail trial ends in ${state.daysLeft} days`,
            `Your free trial of Universal Mail ends on ${longDate(clock.now() + state.daysLeft * DAY)}. After that, everything keeps working for ${GRACE_DAYS} more days; then organizing and sending pause until you subscribe. Reading always works.\n\nTo keep it: ${service}/buy\nThen paste the code from your receipt on your Universal Mail page: ${pageUrl}`],
        'trial-ended': (state) => ['Your Universal Mail trial has ended',
            `Everything keeps working for ${state.daysLeft} more days. After that, organizing and sending pause until you subscribe. Reading always works.\n\nTo keep it: ${service}/buy\nThen paste the code from your receipt on your Universal Mail page: ${pageUrl}`],
        'not-renewed': (state) => ['Your Universal Mail subscription couldn\'t be renewed',
            `Everything keeps working for ${state.daysLeft} more days. After that, organizing and sending pause until it's renewed. Reading always works.\n\nCheck your payment details: ${verified?.portal ?? `${service}/buy`}\nYour Universal Mail page: ${pageUrl}`],
        'read-only': () => ['Universal Mail is now read-only',
            `Reading and search still work. Organizing and sending are paused until you subscribe.\n\nTo subscribe: ${service}/buy\nThen paste the code from your receipt on your Universal Mail page: ${pageUrl}`]
    };
    const notice = async (key, subjectAndText) => {
        const sent = noted().subscriptionNotices ?? {};
        if (sent[key])
            return;
        store.note({ subscriptionNotices: { ...sent, [key]: new Date(clock.now()).toISOString() } });
        await deps.notify(...subjectAndText);
    };
    const reminders = async () => {
        const state = current();
        if (state.state === 'trial' && state.daysLeft <= TRIAL_ENDING_DAYS)
            await notice('trial-ending', notices['trial-ending'](state));
        else if (state.state === 'grace')
            await notice(state.after === 'trial' ? 'trial-ended' : 'not-renewed', state.after === 'trial' ? notices['trial-ended'](state) : notices['not-renewed'](state));
        else if (state.state === 'read-only')
            await notice(`read-only:${state.after}`, notices['read-only']());
    };
    // Daily. With a license: a fresh token. Without one: whether a purchase from
    // the page has bound this install (found by SUB-14: nothing to paste, then).
    const renew = async () => {
        const { license, subscriptionAskedAt } = noted();
        if (!service)
            return;
        if (clock.now() - Date.parse(license?.renewedAt ?? subscriptionAskedAt ?? '') < DAY)
            return;
        const answer = await call('/renew', { ...(license ? { code: license.code } : {}), install: installId() });
        if (answer.kind === 'unreachable')
            return;
        if (answer.status === 200 && await take(answer.body, license?.code))
            return;
        if (!license) {
            store.note({ subscriptionAskedAt: new Date(clock.now()).toISOString() });
            return;
        }
        // Refused (not paid, cancelled, unknown): the license stays, and the
        // person hears now, while what's paid for (and then grace) still runs.
        store.note({ license: { ...license, renewedAt: new Date(clock.now()).toISOString() } });
        const state = current();
        if (state.state === 'active')
            await notice('not-renewed', notices['not-renewed']({ daysLeft: state.daysLeft + GRACE_DAYS }));
        else if (state.state === 'grace' && state.after === 'subscription')
            await notice('not-renewed', notices['not-renewed'](state));
    };
    const ready = (async () => { verified = await verify(noted().license); })();
    return {
        ready,
        current,
        // The checkout, with this install along, so a purchase binds itself (no code to paste).
        buyUrl: () => service ? `${service}/buy?install=${encodeURIComponent(installId())}` : undefined,
        readOnlySentence() {
            const state = current();
            if (state.state !== 'read-only')
                return undefined;
            return state.after === 'trial'
                ? `Your Universal Mail trial has ended, so organizing and sending are paused. Reading still works. Subscribe on your Universal Mail page: ${pageUrl}`
                : `Your Universal Mail subscription has ended, so organizing and sending are paused. Reading still works. Renew on your Universal Mail page: ${pageUrl}`;
        },
        async activate(input) {
            const code = input.trim().toUpperCase();
            if (!service)
                return { ok: false, text: 'This server has no subscription service to talk to.' };
            if (!CODE_SHAPE.test(code))
                return { ok: false, text: 'That doesn\'t look like a license code. It looks like UM-XXXX-XXXX-XXXX, on your receipt.' };
            const answer = await call('/activate', { code, install: installId() });
            if (answer.kind === 'unreachable')
                return { ok: false, text: 'Couldn\'t reach the subscription service. Try again in a few minutes.' };
            if (answer.status === 404)
                return { ok: false, text: 'That code wasn\'t recognised. Check it against your receipt.' };
            if (answer.status === 409)
                return { ok: false, text: 'That code is already in use on too many servers. Remove it from one of them, or buy another.' };
            if (answer.status === 402)
                return { ok: false, text: `That subscription isn't paid up. Renew it first${typeof answer.body.portal === 'string' ? `: ${answer.body.portal}` : '.'}` };
            if (answer.status !== 200 || !(await take(answer.body, code)))
                return { ok: false, text: 'The subscription service gave an answer that couldn\'t be verified. Try again in a few minutes.' };
            return { ok: true, state: current() };
        },
        async duty() {
            if (!service)
                return;
            await ready;
            const now = clock.now();
            if (now - remindersChecked >= HOUR) {
                remindersChecked = now;
                await renew();
                await reminders();
            }
        }
    };
}
//# sourceMappingURL=subscription.js.map