import { MailError } from './errors.js';
export function createAccounts(accounts) {
    const byName = new Map(accounts.map(account => [account.name, account]));
    const unknown = (name, names) => {
        const valid = [...names].sort();
        // Found live: "There's no account called 'gmail'" read as "adding it failed",
        // when this app just hadn't been given it. Only this app's accounts are named.
        return new MailError('MAIL-ACCOUNT-UNKNOWN', `No account called '${name}' is available to this app. It can use: ${valid.join(', ')}. If you've just added an account, give this app permission for it on your Universal Mail page.`, 'FAILED', false, { valid });
    };
    const get = (name) => {
        const account = byName.get(name);
        if (!account)
            throw unknown(name, [...byName.keys()]);
        return account;
    };
    return {
        get,
        // A single-account caller never has to name its account. A named account
        // must be one the caller can reach, and the error lists only those — an
        // app granted one account never learns the others exist.
        resolve(requested, reachable) {
            if (requested !== undefined) {
                if (!reachable.includes(requested))
                    throw unknown(requested, reachable);
                return get(requested);
            }
            if (reachable.length === 1)
                return get(reachable[0]);
            const choices = [...reachable].sort();
            throw new MailError('MAIL-ACCOUNT-REQUIRED', `Say which account to use: ${choices.join(', ')}.`, 'FAILED', false, { choices });
        }
    };
}
//# sourceMappingURL=accounts.js.map