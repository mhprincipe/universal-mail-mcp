import type { WebAuthnCredential } from '@simplewebauthn/server';
import { z } from 'zod/v4';
import type { SavedSignin } from './signin/server.js';

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
    sending: z.boolean().optional()
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

export type InstalledState = z.infer<typeof stateSchema>;
export type InstalledCredentials = z.infer<typeof credentialsSchema>;
export type InstalledAccount = InstalledState['accounts'][number];
type StoredFingerprint = z.infer<typeof storedFingerprint>;

export type Installed =
  | { status: 'ready'; env: NodeJS.ProcessEnv; state: InstalledState; credentials: InstalledCredentials; fingerprints: WebAuthnCredential[] }
  | { status: 'starting' }
  | { status: 'invalid'; setting: string; problem: string };

// Paths and zod's own words, which never quote the value that failed.
const describe = (error: z.ZodError) => error.issues.map(i => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

function parse<T>(env: NodeJS.ProcessEnv, setting: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; problem: string } {
  const text = env[setting];
  if (text === undefined || text === '') return { ok: false, problem: `${setting} is missing` };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, problem: `${setting} isn't valid JSON` }; }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: `${setting}: ${describe(parsed.error)}` };
}

export const toStored = (f: WebAuthnCredential): StoredFingerprint =>
  ({ id: f.id, publicKey: Buffer.from(f.publicKey).toString('base64url'), counter: f.counter, transports: [...(f.transports ?? [])] });
const fromStored = (f: StoredFingerprint): WebAuthnCredential =>
  ({ id: f.id, publicKey: new Uint8Array(Buffer.from(f.publicKey, 'base64url')), counter: f.counter, transports: f.transports as WebAuthnCredential['transports'] });

export function readInstalled(env: NodeJS.ProcessEnv): Installed {
  const invalid = (setting: string, problem: string): Installed => ({ status: 'invalid', setting, problem });
  const state = parse(env, 'UNIVERSAL_MAIL_STATE', stateSchema);
  if (!state.ok) return invalid('UNIVERSAL_MAIL_STATE', state.problem);
  const credentials = parse(env, 'UNIVERSAL_MAIL_CREDENTIALS', credentialsSchema);
  if (!credentials.ok) return invalid('UNIVERSAL_MAIL_CREDENTIALS', credentials.problem);

  let publicUrl: URL | undefined;
  if (env.PUBLIC_URL) {
    try { publicUrl = new URL(env.PUBLIC_URL); } catch { return invalid('PUBLIC_URL', 'PUBLIC_URL isn\'t an address'); }
    if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
      return invalid('PUBLIC_URL', 'PUBLIC_URL must be an https:// address with no path');
    }
  }
  const missing = state.value.accounts.find(a => !credentials.value.passwords[a.name]);
  if (missing) return invalid('UNIVERSAL_MAIL_CREDENTIALS', `UNIVERSAL_MAIL_CREDENTIALS has no password for ${missing.name}`);
  if (!publicUrl) return { status: 'starting' };

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
export function mailSettings(accounts: InstalledAccount[], passwords: Record<string, string>) {
  return {
    MAIL_ACCOUNTS: JSON.stringify(accounts.map(a => ({
      name: a.name, email: a.email, imap: a.imap, smtp: a.smtp, sentCopyMode: a.sentCopyMode, sending: a.sending ?? true,
      ...(a.reliableHeaderSearch === undefined ? {} : { reliableHeaderSearch: a.reliableHeaderSearch })
    }))),
    MAIL_PASSWORDS: JSON.stringify(Object.fromEntries(accounts.map(a => [a.name, passwords[a.name]])))
  };
}

// Everything the running server can change, kept current in both records:
// connections and fingerprints (state), and accounts (state) with their
// passwords (credentials). Each change saves a whole new version, one save at
// a time, in order. A failed save is logged (its status, never its words);
// the next change saves everything again.
export type InstallStore = SavedSignin & {
  signInAddress(): string;
  accounts(): InstalledAccount[];
  mailSettings(): { MAIL_ACCOUNTS: string; MAIL_PASSWORDS: string };
  // Accounts: each takes effect at once (the server rebuilds its mail access).
  putAccount(account: InstalledAccount, password?: string): void;
  removeAccount(name: string): void;
  onAccountsChange(listener: () => void): void;
  // Anything else kept in the state (reminders sent, and so on).
  note(part: Record<string, unknown>): void;
  noted(): Record<string, unknown>;
};

export function createInstallStore(installed: Extract<Installed, { status: 'ready' }>, save: { state: (json: string) => Promise<void>; credentials: (json: string) => Promise<void> }): InstallStore {
  let state: InstalledState = installed.state;
  let credentials: InstalledCredentials = installed.credentials;
  let queue = Promise.resolve();
  const listeners: Array<() => void> = [];
  const enqueue = (what: 'state' | 'credentials', json: string) => {
    queue = queue.then(() => save[what](json)).catch((error: unknown) => {
      const status = (error as { status?: unknown })?.status;
      console.log(JSON.stringify({ event: 'state_save_failed', what, ...(typeof status === 'number' ? { status } : { error: (error as Error)?.name ?? typeof error }) }));
    });
  };
  const saveState = () => enqueue('state', JSON.stringify(state));
  const saveCredentials = () => enqueue('credentials', JSON.stringify(credentials));
  const accountsChanged = () => { for (const listener of listeners) listener(); };
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
      if (password !== undefined) { credentials = { ...credentials, passwords: { ...credentials.passwords, [account.name]: password } }; saveCredentials(); }
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
    onAccountsChange: listener => { listeners.push(listener); },
    note(part) { state = { ...state, ...part }; saveState(); },
    noted: () => state as Record<string, unknown>
  };
}
