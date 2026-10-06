import { appPassword, sentCopyMode as sentCopyModeFor } from '../providers.js';
import { problemText } from '../setup/messages.js';
import { pollDeviceSignIn, startDeviceSignIn } from '../microsoft.js';
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The mail engine needs at least this many (config.ts); app passwords are longer.
const MIN_PASSWORD = 8;
const TOO_SHORT = { kind: 'error', text: 'App passwords are at least 8 characters. Copy the whole one your provider made.' };
export function accountActions(tools, deps) {
    const { store, mailCheck, status } = deps;
    const refusal = (reason, values) => problemText(reason === 'rejected' ? 'MAIL-APP-PASSWORD' : reason === 'insecure' ? 'MAIL-INSECURE' : 'MAIL-UNREACHABLE', values);
    // A name for a new account: the one asked for, if free and well formed;
    // else one from the address.
    const nameFor = (email, requested, fallback) => {
        const taken = new Set(store.accounts().map(a => a.name));
        const name = requested.trim().toLowerCase();
        if (name)
            return !NAME.test(name) || taken.has(name) ? { error: taken.has(name) ? 'That name is taken. Choose another.' : 'Names use lowercase letters, digits and hyphens.' } : { name };
        const local = email.split('@')[0].replace(/[^a-z0-9-]/g, '').slice(0, 32) || fallback;
        let made = local;
        for (let n = 2; taken.has(made); n++)
            made = `${local}-${n}`;
        return { name: made };
    };
    tools.post('/accounts/add', async (req, res, session) => {
        const email = String(req.body.email ?? '').trim().toLowerCase();
        const password = appPassword(String(req.body.password ?? ''));
        if (password.length < MIN_PASSWORD)
            return tools.back(res, session, TOO_SHORT);
        const detected = email.includes('@') ? await mailCheck.detect(email) : undefined;
        if (!detected)
            return tools.back(res, session, undefined, { problem: problemText('MAIL-PROVIDER-UNKNOWN', { address: email }) });
        const provider = detected.provider;
        // No app passwords at Microsoft (MS-12): it signs in another way.
        if (provider.signIn === 'microsoft') {
            return tools.back(res, session, { kind: 'error', text: `Outlook.com accounts sign in with Microsoft, not an app password.${deps.microsoft ? ' Use Add an Outlook.com account below.' : ' Microsoft sign-in is not set up on this server yet.'}` });
        }
        const chosen = nameFor(email, String(req.body.name ?? ''), provider.id);
        if ('error' in chosen)
            return tools.back(res, session, { kind: 'error', text: chosen.error });
        const name = chosen.name;
        const checked = await mailCheck.check(email, password);
        if (!checked.ok) {
            return tools.back(res, session, undefined, { problem: refusal(checked.reason, {
                    provider: provider.name, address: email, page: provider.appPassword.page.replace(/^https:\/\//, ''), button: provider.appPassword.button
                }) });
        }
        // Setup's sending test: one email to the account itself, to learn who files the Sent copy.
        const sentCopyMode = await mailCheck.sendTest(email, password).then(({ copies }) => sentCopyModeFor(copies, provider.id), () => 'unverified');
        store.putAccount({
            name, email, provider: provider.id, imap: provider.imap, smtp: provider.smtp,
            sentCopyMode, safeMove: checked.safeMove, sending: true
        }, password);
        status.set(name, 'working');
        await deps.notify('An email account was added to Universal Mail', `${email} was added as "${name}". Apps can use it only once you give them permission on your Universal Mail page.`);
        tools.back(res, session, { kind: 'ok', text: `${name} was added.` });
    });
    tools.post('/accounts/password', async (req, res, session) => {
        const account = store.accounts().find(a => a.name === String(req.body.name ?? ''));
        if (!account)
            return tools.back(res, session, { kind: 'error', text: 'That account isn\'t here any more.' });
        if (account.auth === 'microsoft')
            return tools.back(res, session, { kind: 'error', text: `${account.name} signs in with Microsoft: use Sign in again.` });
        const password = appPassword(String(req.body.password ?? ''));
        if (password.length < MIN_PASSWORD)
            return tools.back(res, session, TOO_SHORT);
        const provider = (await mailCheck.detect(account.email))?.provider;
        const checked = await mailCheck.check(account.email, password);
        if (!checked.ok) {
            return tools.back(res, session, undefined, { problem: refusal(checked.reason, {
                    provider: provider?.name ?? 'Your provider', address: account.email,
                    page: provider?.appPassword.page.replace(/^https:\/\//, '') ?? '', button: provider?.appPassword.button ?? ''
                }) });
        }
        store.putAccount(account, password);
        status.set(account.name, 'working');
        await deps.notify(`The app password for ${account.name} was changed`, `The app password Universal Mail uses for ${account.email} was changed on your Universal Mail page.`);
        tools.back(res, session, { kind: 'ok', text: `The new password for ${account.name} works.` });
    });
    tools.post('/accounts/remove', async (req, res, session) => {
        const name = String(req.body.name ?? '');
        const account = store.accounts().find(a => a.name === name);
        if (!account)
            return tools.back(res, session, { kind: 'error', text: 'That account isn\'t here any more.' });
        if (String(req.body.confirm ?? '').trim() !== name)
            return tools.back(res, session, { kind: 'error', text: `Type the account name, ${name}, to remove it.` });
        if (store.accounts().length === 1)
            return tools.back(res, session, { kind: 'error', text: 'Universal Mail needs at least one account, so this one stays.' });
        // No app keeps a permission for an account that's gone.
        for (const grant of deps.grants.snapshot().apps) {
            if (grant.accounts[name]) {
                const { [name]: _gone, ...kept } = grant.accounts;
                deps.grants.update(grant.appId, kept);
            }
        }
        store.removeAccount(name);
        status.delete(name);
        await deps.notify('An email account was removed from Universal Mail', `${account.email} ("${name}") was removed. No app can use it, and its password was deleted.`);
        tools.back(res, session, { kind: 'ok', text: `${name} was removed.` });
    });
    // A new name for an account (PG-19, the owner's request): everything it had
    // carries over, the password, its settings and every app's permissions, and
    // apps use the new name from their next request, without reconnecting.
    tools.post('/accounts/rename', async (req, res, session) => {
        const name = String(req.body.name ?? '');
        const account = store.accounts().find(a => a.name === name);
        if (!account)
            return tools.back(res, session, { kind: 'error', text: 'That account isn\'t here any more.' });
        const to = String(req.body.to ?? '').trim().toLowerCase();
        if (to === name)
            return tools.back(res, session, { kind: 'ok', text: `${name} keeps its name.` });
        const taken = new Set(store.accounts().map(a => a.name));
        if (!NAME.test(to) || taken.has(to)) {
            return tools.back(res, session, { kind: 'error', text: taken.has(to) ? 'That name is taken. Choose another.' : 'Names use lowercase letters, digits and hyphens.' });
        }
        store.renameAccount(name, to);
        for (const grant of deps.grants.snapshot().apps) {
            if (grant.accounts[name]) {
                const { [name]: permissions, ...others } = grant.accounts;
                deps.grants.update(grant.appId, { ...others, [to]: permissions });
            }
        }
        const was = status.get(name);
        status.delete(name);
        if (was)
            status.set(to, was);
        await deps.notify('An email account was renamed', `${account.email}: "${name}" is now "${to}". Apps that were allowed to use it still are, under the new name.`);
        tools.back(res, session, { kind: 'ok', text: `${name} is now called ${to}.` });
    });
    // ── Signing in with Microsoft (2.5, MS-13..15) ──
    const pending = new WeakMap();
    const shown = (p) => ({ signIn: { userCode: p.userCode, verificationUri: p.verificationUri, email: p.email } });
    const clock = deps.clock ?? Date;
    tools.post('/accounts/microsoft/start', async (req, res, session) => {
        if (!deps.microsoft)
            return tools.back(res, session, { kind: 'error', text: 'Microsoft sign-in is not set up on this server yet.' });
        const email = String(req.body.email ?? '').trim().toLowerCase();
        const again = req.body.again ? String(req.body.again) : undefined;
        const existing = again ? store.accounts().find(a => a.name === again && a.auth === 'microsoft') : undefined;
        if (again && !existing)
            return tools.back(res, session, { kind: 'error', text: 'That account is not here any more.' });
        const detected = email.includes('@') ? await mailCheck.detect(email) : undefined;
        if (detected?.provider.signIn !== 'microsoft')
            return tools.back(res, session, { kind: 'error', text: `${email} is not an Outlook.com, Hotmail, Live or MSN address.` });
        const chosen = existing ? { name: existing.name } : nameFor(email, String(req.body.name ?? ''), 'outlook');
        if ('error' in chosen)
            return tools.back(res, session, { kind: 'error', text: chosen.error });
        const started = await startDeviceSignIn(deps.microsoft, clock).catch(() => undefined);
        if (!started)
            return tools.back(res, session, { kind: 'error', text: 'Microsoft did not answer. Try again in a few minutes.' });
        const p = { email, name: chosen.name, ...(again ? { again } : {}), deviceCode: started.deviceCode, userCode: started.userCode, verificationUri: started.verificationUri, expiresAt: started.expiresAt };
        pending.set(session, p);
        tools.back(res, session, undefined, shown(p));
    });
    tools.post('/accounts/microsoft/finish', async (_req, res, session) => {
        const p = pending.get(session);
        if (!p || !deps.microsoft)
            return tools.back(res, session, { kind: 'error', text: 'No Microsoft sign-in is under way. Start again.' });
        if (clock.now() > p.expiresAt) {
            pending.delete(session);
            return tools.back(res, session, { kind: 'error', text: 'The code ran out. Start again.' });
        }
        const polled = await pollDeviceSignIn(deps.microsoft, p.deviceCode).catch(() => ({ status: 'pending' }));
        if (polled.status === 'pending' || polled.status === 'slow') {
            return tools.back(res, session, { kind: 'error', text: 'Microsoft says it is not approved yet. Enter the code at Microsoft, approve Universal Mail, then press Finish.' }, shown(p));
        }
        pending.delete(session);
        if (polled.status === 'declined')
            return tools.back(res, session, { kind: 'error', text: 'The sign-in was not approved at Microsoft. Start again if you meant to.' });
        if (polled.status === 'expired')
            return tools.back(res, session, { kind: 'error', text: 'The code ran out. Start again.' });
        if (polled.status !== 'done')
            return tools.back(res, session, { kind: 'error', text: 'Microsoft did not finish the sign-in. Start again.' });
        const token = { accessToken: polled.accessToken };
        const detected = await mailCheck.detect(p.email);
        const checked = await mailCheck.check(p.email, token);
        if (!detected || !checked.ok) {
            const why = !checked.ok && checked.reason === 'unreachable' ? ' Outlook did not answer; try again shortly.' : ' Check that this Outlook.com account allows IMAP (Outlook.com settings, Forwarding and IMAP), then start again.';
            return tools.back(res, session, { kind: 'error', text: `Microsoft approved it, but Universal Mail could not read or send mail as ${p.email}.${why}` });
        }
        const now = clock.now();
        if (p.again) {
            const account = store.accounts().find(a => a.name === p.again);
            if (!account)
                return tools.back(res, session, { kind: 'error', text: 'That account is not here any more.' });
            store.putAccount({ ...account, tokenSavedAt: now }, polled.refreshToken);
            status.set(account.name, 'working');
            await deps.notify(`${account.name} was signed in again`, `Universal Mail was approved again at Microsoft for ${account.email}.`);
            return tools.back(res, session, { kind: 'ok', text: `${account.name} is signed in again.` });
        }
        const sentCopyMode = await mailCheck.sendTest(p.email, token).then(({ copies }) => sentCopyModeFor(copies, 'outlook'), () => 'unverified');
        store.putAccount({
            name: p.name, email: p.email, provider: detected.provider.id, imap: detected.provider.imap, smtp: detected.provider.smtp,
            sentCopyMode, safeMove: checked.safeMove, sending: true, auth: 'microsoft', tokenSavedAt: now
        }, polled.refreshToken);
        status.set(p.name, 'working');
        await deps.notify('An email account was added to Universal Mail', `${p.email} was added as "${p.name}", approved at Microsoft. Apps can use it only once you give them permission on your Universal Mail page.`);
        tools.back(res, session, { kind: 'ok', text: `${p.name} was added.` });
    });
    // Send limits (LIM-02): whole numbers, no more an hour than a day.
    tools.post('/accounts/limits', async (req, res, session) => {
        const account = store.accounts().find(a => a.name === String(req.body.name ?? ''));
        if (!account)
            return tools.back(res, session, { kind: 'error', text: 'That account isn\'t here any more.' });
        const whole = (value) => /^\d{1,5}$/.test(String(value ?? '').trim()) ? Number(String(value).trim()) : NaN;
        const perHour = whole(req.body.perHour);
        const perDay = whole(req.body.perDay);
        if (!(perHour >= 1 && perHour <= 1000 && perDay >= 1 && perDay <= 10_000 && perHour <= perDay)) {
            return tools.back(res, session, { kind: 'error', text: 'Limits are whole numbers: 1 to 1,000 an hour and 1 to 10,000 a day, and no more an hour than a day.' });
        }
        store.putAccount({ ...account, sendLimits: { perHour, perDay } });
        await deps.notify(`Sending limits changed for ${account.name}`, `${account.email} can now send up to ${perHour} messages an hour and ${perDay} a day.`);
        tools.back(res, session, { kind: 'ok', text: `${account.name} can now send up to ${perHour} an hour and ${perDay} a day.` });
    });
    tools.post('/accounts/sending', async (req, res, session) => {
        const account = store.accounts().find(a => a.name === String(req.body.name ?? ''));
        if (!account)
            return tools.back(res, session, { kind: 'error', text: 'That account isn\'t here any more.' });
        const on = req.body.on === 'on';
        store.putAccount({ ...account, sending: on });
        if (on)
            await deps.notify(`Sending was turned on for ${account.name}`, `Apps you allowed to send can now send email from ${account.email}.`);
        tools.back(res, session, { kind: 'ok', text: `Sending is ${on ? 'on' : 'off'} for ${account.name}.` });
    });
}
//# sourceMappingURL=accounts.js.map