import { z } from 'zod/v4';
import { loadConfig } from './config.js';
// The account list, as kept in universal-mail-state. Passwords are not here:
// they live only in universal-mail-credentials, and arrive separately.
const endpoint = { host: z.string().min(1), port: z.number().int().positive() };
const accountList = z.array(z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'use lowercase letters, digits and hyphens'),
    email: z.string(),
    imap: z.object({ ...endpoint, tls: z.enum(['implicit', 'starttls', 'none']) }),
    smtp: z.object({ ...endpoint, tls: z.enum(['implicit', 'starttls', 'none']).optional() }),
    sentCopyMode: z.enum(['unverified', 'yahoo', 'append']).default('unverified'),
    reliableHeaderSearch: z.boolean().default(false),
    sending: z.boolean().default(true)
}));
const passwordList = z.record(z.string(), z.string());
// Parses without ever repeating the input: a JSON error can quote it, and the
// password list is secret.
function parseJson(setting, text) {
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`${setting} isn't valid JSON.`);
    }
}
// Issue paths and messages only, never the values that failed.
function describe(error) {
    if (error instanceof z.ZodError)
        return error.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
    return 'invalid settings';
}
export function loadAccounts(env) {
    // v1's single-account settings still work, as one account called "main".
    if (env.MAIL_ACCOUNTS === undefined)
        return [{ name: 'main', config: loadConfig(env), reliableHeaderSearch: false }];
    const listed = accountList.safeParse(parseJson('MAIL_ACCOUNTS', env.MAIL_ACCOUNTS));
    if (!listed.success)
        throw new Error(`MAIL_ACCOUNTS: ${describe(listed.error)}`);
    const passwords = passwordList.safeParse(parseJson('MAIL_PASSWORDS', env.MAIL_PASSWORDS ?? '{}'));
    if (!passwords.success)
        throw new Error("MAIL_PASSWORDS isn't valid: expected account names mapped to passwords.");
    if (!listed.data.length)
        throw new Error('No email accounts are set up.');
    const seen = new Set();
    return listed.data.map(account => {
        if (seen.has(account.name))
            throw new Error(`The account name '${account.name}' is used twice.`);
        seen.add(account.name);
        const password = passwords.data[account.name];
        if (!password)
            throw new Error(`Account '${account.name}' has no password saved.`);
        try {
            // Each account passes exactly the checks a single account does.
            const config = loadConfig({
                ...env,
                YAHOO_EMAIL: account.email, YAHOO_APP_PASSWORD: password,
                IMAP_HOST: account.imap.host, IMAP_PORT: String(account.imap.port), IMAP_TLS: account.imap.tls,
                SMTP_HOST: account.smtp.host, SMTP_PORT: String(account.smtp.port), SMTP_TLS: account.smtp.tls,
                SENT_COPY_MODE: account.sentCopyMode
            });
            return { name: account.name, config, reliableHeaderSearch: account.reliableHeaderSearch, sending: account.sending };
        }
        catch (error) {
            throw new Error(`Account '${account.name}': ${describe(error)}`);
        }
    });
}
//# sourceMappingURL=accountsConfig.js.map