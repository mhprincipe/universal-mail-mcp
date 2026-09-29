import { appPassword } from '../providers.js';
import { problemText } from '../setup/messages.js';
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The mail engine needs at least this many (config.ts); app passwords are longer.
const MIN_PASSWORD = 8;
const TOO_SHORT = { kind: 'error', text: 'App passwords are at least 8 characters. Copy the whole one your provider made.' };
export function accountActions(tools, deps) {
    const { store, mailCheck, status } = deps;
    const refusal = (reason, values) => problemText(reason === 'rejected' ? 'MAIL-APP-PASSWORD' : reason === 'insecure' ? 'MAIL-INSECURE' : 'MAIL-UNREACHABLE', values);
    tools.post('/accounts/add', async (req, res, session) => {
        const email = String(req.body.email ?? '').trim().toLowerCase();
        const password = appPassword(String(req.body.password ?? ''));
        if (password.length < MIN_PASSWORD)
            return tools.back(res, session, TOO_SHORT);
        const detected = email.includes('@') ? await mailCheck.detect(email) : undefined;
        if (!detected)
            return tools.back(res, session, undefined, { problem: problemText('MAIL-PROVIDER-UNKNOWN', { address: email }) });
        const provider = detected.provider;
        const taken = new Set(store.accounts().map(a => a.name));
        let name = String(req.body.name ?? '').trim().toLowerCase();
        if (name && (!NAME.test(name) || taken.has(name))) {
            return tools.back(res, session, { kind: 'error', text: taken.has(name) ? 'That name is taken. Choose another.' : 'Names use lowercase letters, digits and hyphens.' });
        }
        if (!name) {
            const local = email.split('@')[0].replace(/[^a-z0-9-]/g, '').slice(0, 32) || provider.id;
            name = local;
            for (let n = 2; taken.has(name); n++)
                name = `${local}-${n}`;
        }
        const checked = await mailCheck.check(email, password);
        if (!checked.ok) {
            return tools.back(res, session, undefined, { problem: refusal(checked.reason, {
                    provider: provider.name, address: email, page: provider.appPassword.page.replace(/^https:\/\//, ''), button: provider.appPassword.button
                }) });
        }
        // Setup's sending test: one email to the account itself, to learn who files the Sent copy.
        const sentCopyMode = await mailCheck.sendTest(email, password).then(({ copies }) => copies === 0 ? 'append' : 'yahoo', () => 'unverified');
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