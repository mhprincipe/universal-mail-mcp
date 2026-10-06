import { z } from 'zod/v4';
// The installed server (design §6.3): Cloud Run hands it the two records setup
// saved, one JSON text each, as UNIVERSAL_MAIL_STATE (no passwords, no keys)
// and UNIVERSAL_MAIL_CREDENTIALS (passwords and keys), plus PUBLIC_URL once
// Google has given it an address. Nothing here ever repeats a value.
export const STATE_SECRET_NAME = 'universal-mail-state';
export const CREDENTIALS_SECRET_NAME = 'universal-mail-credentials';
const endpoint = z.object({ host: z.string().min(1), port: z.number().int().positive(), tls: z.enum(['implicit', 'starttls', 'none']) });
const storedFingerprint = z.object({ id: z.string().min(1), publicKey: z.string().min(1), counter: z.number().int().min(0), transports: z.array(z.string()) });
const grant = z.object({
    appId: z.string().min(1), appName: z.string().optional(), connection: z.number().int().positive(),
    accounts: z.record(z.string(), z.array(z.enum(['read', 'organize', 'send'])))
});
const stateSchema = z.object({
    version: z.literal(1),
    key: z.string().regex(/^[A-Za-z0-9_-]{20,}$/),
    signInAddress: z.string().email(),
    accounts: z.array(z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), email: z.string().email(), provider: z.string().optional(),
        imap: endpoint, smtp: endpoint,
        sentCopyMode: z.enum(['unverified', 'yahoo', 'append']), safeMove: z.boolean().optional(),
        reliableHeaderSearch: z.boolean().optional(),
        // Turned off on your page: nothing can send from it (design §3.6).
        sending: z.boolean().optional(),
        // Changed on your page (LIM-02); unset: the defaults.
        sendLimits: z.object({ perHour: z.number().int().min(1).max(1000), perDay: z.number().int().min(1).max(10_000) }).optional(),
        // Signed in with Microsoft (2.5): its password is a refresh token, saved at tokenSavedAt.
        auth: z.enum(['password', 'microsoft']).optional(),
        tokenSavedAt: z.number().int().min(0).optional()
    })).min(1),
    // Setup writes {} before any app has connected.
    grants: z.object({ apps: z.array(grant).optional(), connections: z.record(z.string(), z.number().int().min(0)).optional() }),
    fingerprints: z.array(storedFingerprint),
    trialReminder: z.boolean().optional()
}).loose();
const credentialsSchema = z.object({
    // As the mail engine requires (config.ts): caught here, at start, not on every request.
    passwords: z.record(z.string(), z.string().min(8)),
    signingKey: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string(), d: z.string() }).loose(),
    encryptionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
// Paths and zod's own words, which never quote the value that failed.
const describe = (error) => error.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
function parse(env, setting, schema) {
    const text = env[setting];
    if (text === undefined || text === '')
        return { ok: false, problem: `${setting} is missing` };
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        return { ok: false, problem: `${setting} isn't valid JSON` };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: `${setting}: ${describe(parsed.error)}` };
}
export const toStored = (f) => ({ id: f.id, publicKey: Buffer.from(f.publicKey).toString('base64url'), counter: f.counter, transports: [...(f.transports ?? [])] });
const fromStored = (f) => ({ id: f.id, publicKey: new Uint8Array(Buffer.from(f.publicKey, 'base64url')), counter: f.counter, transports: f.transports });
export function readInstalled(env) {
    const invalid = (setting, problem) => ({ status: 'invalid', setting, problem });
    const state = parse(env, 'UNIVERSAL_MAIL_STATE', stateSchema);
    if (!state.ok)
        return invalid('UNIVERSAL_MAIL_STATE', state.problem);
    const credentials = parse(env, 'UNIVERSAL_MAIL_CREDENTIALS', credentialsSchema);
    if (!credentials.ok)
        return invalid('UNIVERSAL_MAIL_CREDENTIALS', credentials.problem);
    let publicUrl;
    if (env.PUBLIC_URL) {
        try {
            publicUrl = new URL(env.PUBLIC_URL);
        }
        catch {
            return invalid('PUBLIC_URL', 'PUBLIC_URL isn\'t an address');
        }
        if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
            return invalid('PUBLIC_URL', 'PUBLIC_URL must be an https:// address with no path');
        }
    }
    const missing = state.value.accounts.find(a => !credentials.value.passwords[a.name]);
    if (missing)
        return invalid('UNIVERSAL_MAIL_CREDENTIALS', `UNIVERSAL_MAIL_CREDENTIALS has no password for ${missing.name}`);
    if (!publicUrl)
        return { status: 'starting' };
    const s = state.value;
    const c = credentials.value;
    return {
        status: 'ready', state: s, credentials: c, fingerprints: s.fingerprints.map(fromStored),
        env: {
            ...env,
            AUTH_MODE: 'builtin',
            SIGNIN_ISSUER: publicUrl.origin,
            SIGNIN_KEY: s.key,
            SIGNIN_ADDRESS: s.signInAddress,
            SIGNIN_SIGNING_KEY: JSON.stringify(c.signingKey),
            SIGNIN_ENCRYPTION_KEY: c.encryptionKey,
            // Requests arrive with the service's own host name.
            ALLOWED_HOSTS: publicUrl.hostname,
            ...mailSettings(s.accounts, c.passwords)
        }
    };
}
// The accounts as the mail engine reads them (accountsConfig.ts).
export function mailSettings(accounts, passwords) {
    return {
        MAIL_ACCOUNTS: JSON.stringify(accounts.map(a => ({
            name: a.name, email: a.email, imap: a.imap, smtp: a.smtp, sentCopyMode: a.sentCopyMode, sending: a.sending ?? true, ...(a.sendLimits ? { sendLimits: a.sendLimits } : {}),
            ...(a.reliableHeaderSearch === undefined ? {} : { reliableHeaderSearch: a.reliableHeaderSearch }),
            ...(a.auth ? { auth: a.auth } : {}), ...(a.tokenSavedAt !== undefined ? { tokenSavedAt: a.tokenSavedAt } : {})
        }))),
        MAIL_PASSWORDS: JSON.stringify(Object.fromEntries(accounts.map(a => [a.name, passwords[a.name]])))
    };
}
export function createInstallStore(installed, save) {
    let state = installed.state;
    let credentials = installed.credentials;
    let queue = Promise.resolve();
    const listeners = [];
    const enqueue = (what, json) => {
        queue = queue.then(() => save[what](json)).catch((error) => {
            const status = error?.status;
            console.log(JSON.stringify({ event: 'state_save_failed', what, ...(typeof status === 'number' ? { status } : { error: error?.name ?? typeof error }) }));
        });
    };
    const saveState = () => enqueue('state', JSON.stringify(state));
    const saveCredentials = () => enqueue('credentials', JSON.stringify(credentials));
    const accountsChanged = () => { for (const listener of listeners)
        listener(); };
    return {
        grants: installed.state.grants,
        fingerprints: installed.fingerprints,
        change(part) {
            state = {
                ...state,
                ...(part.grants ? { grants: part.grants } : {}),
                ...(part.fingerprints ? { fingerprints: part.fingerprints.map(toStored) } : {})
            };
            saveState();
        },
        settled: () => queue,
        signInAddress: () => state.signInAddress,
        accounts: () => state.accounts,
        mailSettings: () => mailSettings(state.accounts, credentials.passwords),
        putAccount(account, password) {
            const exists = state.accounts.some(a => a.name === account.name);
            state = { ...state, accounts: exists ? state.accounts.map(a => a.name === account.name ? account : a) : [...state.accounts, account] };
            // The new password first: the state never names an account without one.
            if (password !== undefined) {
                credentials = { ...credentials, passwords: { ...credentials.passwords, [account.name]: password } };
                saveCredentials();
            }
            saveState();
            accountsChanged();
        },
        removeAccount(name) {
            state = { ...state, accounts: state.accounts.filter(a => a.name !== name) };
            saveState();
            const { [name]: _removed, ...kept } = credentials.passwords;
            credentials = { ...credentials, passwords: kept };
            saveCredentials();
            accountsChanged();
        },
        renameAccount(from, to) {
            // The password under its new name first, then the state, then the old
            // name's password goes: at every step the state names no account
            // without one.
            credentials = { ...credentials, passwords: { ...credentials.passwords, [to]: credentials.passwords[from] } };
            saveCredentials();
            state = { ...state, accounts: state.accounts.map(a => a.name === from ? { ...a, name: to } : a) };
            saveState();
            const { [from]: _old, ...kept } = credentials.passwords;
            credentials = { ...credentials, passwords: kept };
            saveCredentials();
            accountsChanged();
        },
        onAccountsChange: listener => { listeners.push(listener); },
        saveToken(name, refreshToken, at) {
            if (!state.accounts.some(a => a.name === name))
                return;
            credentials = { ...credentials, passwords: { ...credentials.passwords, [name]: refreshToken } };
            saveCredentials();
            state = { ...state, accounts: state.accounts.map(a => a.name === name ? { ...a, tokenSavedAt: at } : a) };
            saveState();
        },
        note(part) { state = { ...state, ...part }; saveState(); },
        noted: () => state
    };
}
//# sourceMappingURL=installed.js.map