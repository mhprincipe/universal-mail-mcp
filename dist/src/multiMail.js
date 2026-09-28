import { createAccounts } from './accounts.js';
import { MailError, classify, success } from './errors.js';
import { MailService } from './yahoo/mailService.js';
// One service — and so one connection gateway and one folder cache — per
// account. A shared cache would hand one account another account's folders.
export function createAccountServices(accounts) {
    return new Map(accounts.map(({ name, config, reliableHeaderSearch }) => [name, new MailService(config, { unreliableHeaderSearch: !reliableHeaderSearch })]));
}
const verbs = { read: 'read mail in', organize: 'organize mail in', send: 'send mail from' };
// Every call to an account's service: a refused password is reported, then
// the error goes on exactly as it was.
function watched(name, service, hooks) {
    if (!hooks.onAuthFailure)
        return service;
    return new Proxy(service, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== 'function')
                return value;
            return (...args) => {
                const result = value.apply(target, args);
                if (!(result instanceof Promise))
                    return result;
                return result.catch(async (error) => {
                    if (classify(error).code === 'AUTH_FAILED')
                        await Promise.resolve(hooks.onAuthFailure(name)).catch(() => undefined);
                    throw error;
                });
            };
        }
    });
}
export function createMailRouter(accounts, hooks = {}) {
    const sendingOff = new Set(accounts.filter(a => a.sending === false).map(a => a.name));
    const services = new Map([...createAccountServices(accounts)].map(([name, service]) => [name, watched(name, service, hooks)]));
    const directory = createAccounts(accounts.map(a => ({ name: a.name, address: a.config.YAHOO_EMAIL })));
    const multi = createMultiMail(services);
    const access = (grant) => {
        // An account the grant doesn't mention doesn't exist, as far as this caller knows.
        const names = accounts.map(a => a.name).filter(name => grant[name]?.length);
        const readable = names.filter(name => grant[name].includes('read'));
        const service = (account, action) => {
            const name = directory.resolve(account, names).name;
            if (!grant[name].includes(action)) {
                throw new MailError('MAIL-NOT-PERMITTED', `This app isn't allowed to ${verbs[action]} ${name}. You can change that on your Universal Mail page.`);
            }
            // A lapsed subscription: reading goes on; the paid work is paused (asked
            // each time, so renewing takes effect at once).
            if (action !== 'read') {
                const paused = hooks.readOnly?.();
                if (paused)
                    throw new MailError('SUBSCRIPTION-READ-ONLY', paused);
            }
            // Turned off on your page: whatever an app was granted.
            if (action === 'send' && sendingOff.has(name)) {
                throw new MailError('MAIL-SENDING-OFF', `Sending is turned off for ${name}. It can be turned on on your Universal Mail page.`);
            }
            return services.get(name);
        };
        return {
            names,
            service,
            search: (input, account) => {
                if (account !== undefined)
                    return service(account, 'read').searchEmail(input);
                if (readable.length === 1)
                    return services.get(readable[0]).searchEmail(input);
                return multi.search(input, readable);
            }
        };
    };
    // Without sign-in grants (bearer and v1 modes), the caller may do everything.
    const everything = Object.fromEntries(accounts.map(a => [a.name, ['read', 'organize', 'send']]));
    return { ...access(everything), forGrant: access };
}
export function createMultiMail(services) {
    return {
        // Every reachable account is searched independently, so one broken
        // account costs a warning, never the whole search.
        async search(input, reachable) {
            const settled = await Promise.allSettled(reachable.map(async (account) => {
                const result = await services.get(account).searchEmail(input);
                return (result.data ?? []).map(summary => ({ ...summary, account }));
            }));
            const found = [];
            const warnings = [];
            settled.forEach((outcome, index) => {
                if (outcome.status === 'fulfilled')
                    found.push(...outcome.value);
                else
                    warnings.push(`Couldn't search ${reachable[index]}: ${classify(outcome.reason).message}`);
            });
            // Newest first across every account; messages without a date go last.
            found.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
            return success(found, 'Success', 'OK', warnings);
        },
        // Accounts are separate mail servers; a move across them would be a copy
        // then a delete, which breaks the no-guessing rules. Refuse it outright,
        // rather than let the destination account be dropped and the message land
        // in a same-named folder of the source account.
        async move(request) {
            if (request.destinationAccount !== undefined && request.destinationAccount !== request.account) {
                throw new MailError('MAIL-CROSS-ACCOUNT', `Mail can't be moved between accounts. Moves stay within ${request.account}; nothing was changed.`);
            }
            return services.get(request.account).moveEmail(request.mailbox, request.uid, request.destination);
        }
    };
}
//# sourceMappingURL=multiMail.js.map