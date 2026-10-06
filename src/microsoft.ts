import { MailError } from './errors.js';

// Signing in with Microsoft (2.5, docs/DESIGN-PROVIDER-SIGNIN.md). Outlook.com
// has no app passwords: an account is approved with a short code at
// microsoft.com (the device-code sign-in, which needs no address registered in
// advance, so one registration serves every installation), and Universal Mail
// keeps the refresh token where it keeps an app password. Mail is then read
// and sent with short-lived access tokens (IMAP and SMTP, XOAUTH2).
//
// Never logged or repeated: codes, tokens, and Microsoft's own error words
// (which can quote what was sent).

export const MICROSOFT_SCOPES = 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access';
// Personal accounts (Outlook.com, Hotmail, Live): the owner's choice for phase 1.
export const MICROSOFT_AUTHORITY = 'https://login.microsoftonline.com/consumers';

export type MicrosoftSettings = { clientId: string; authority: string; fetch?: typeof fetch };
type Clock = { now(): number };

const TIMEOUT_MS = 15_000;

async function post(settings: MicrosoftSettings, path: string, fields: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await (settings.fetch ?? fetch)(`${settings.authority}${path}`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: settings.clientId, ...fields }).toString()
    });
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, json: json && typeof json === 'object' ? json : {} };
  } catch {
    throw new MailError('TRANSIENT_NETWORK', 'Microsoft\'s sign-in service could not be reached.', 'FAILED', true);
  } finally { clearTimeout(timer); }
}

const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const seconds = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

export type DeviceSignIn = { deviceCode: string; userCode: string; verificationUri: string; expiresAt: number; interval: number };

// MS-01: the code to show, and Microsoft's page to type it into. Only an https
// page of Microsoft's own is ever shown.
export async function startDeviceSignIn(settings: MicrosoftSettings, clock: Clock = Date): Promise<DeviceSignIn> {
  const { status, json } = await post(settings, '/oauth2/v2.0/devicecode', { scope: MICROSOFT_SCOPES });
  const deviceCode = text(json.device_code);
  const userCode = text(json.user_code);
  const verificationUri = text(json.verification_uri);
  const page = verificationUri ? safeUrl(verificationUri) : undefined;
  if (status !== 200 || !deviceCode || !userCode || !page) throw new MailError('MICROSOFT_SIGNIN_FAILED', 'Microsoft gave an unexpected answer when asked for a sign-in code.');
  return { deviceCode, userCode, verificationUri: page, expiresAt: clock.now() + seconds(json.expires_in, 900) * 1000, interval: seconds(json.interval, 5) };
}

function safeUrl(address: string): string | undefined {
  try {
    const url = new URL(address);
    const host = url.hostname.toLowerCase();
    const microsofts = ['microsoft.com', 'microsoftonline.com', 'live.com'];
    return url.protocol === 'https:' && microsofts.some(d => host === d || host.endsWith(`.${d}`)) ? url.toString() : undefined;
  } catch { return undefined; }
}

export type DevicePoll =
  | { status: 'pending' } | { status: 'slow' } | { status: 'declined' } | { status: 'expired' } | { status: 'failed' }
  | { status: 'done'; refreshToken: string; accessToken: string; expiresIn: number };

// MS-02: one look at whether the person has approved yet.
export async function pollDeviceSignIn(settings: MicrosoftSettings, deviceCode: string): Promise<DevicePoll> {
  const { status, json } = await post(settings, '/oauth2/v2.0/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
  if (status === 200) {
    const refreshToken = text(json.refresh_token);
    const accessToken = text(json.access_token);
    // Without a refresh token the account would stop working within the hour.
    return refreshToken && accessToken ? { status: 'done', refreshToken, accessToken, expiresIn: seconds(json.expires_in, 3600) } : { status: 'failed' };
  }
  switch (json.error) {
    case 'authorization_pending': return { status: 'pending' };
    case 'slow_down': return { status: 'slow' };
    case 'authorization_declined': case 'access_denied': return { status: 'declined' };
    case 'expired_token': return { status: 'expired' };
    default: return { status: 'failed' };
  }
}

// MS-03: a refresh token buys an access token (and, usually, a new refresh token).
export async function refreshAccess(settings: MicrosoftSettings, refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const { status, json } = await post(settings, '/oauth2/v2.0/token', { grant_type: 'refresh_token', refresh_token: refreshToken, scope: MICROSOFT_SCOPES });
  const accessToken = text(json.access_token);
  if (status === 200 && accessToken) {
    const next = text(json.refresh_token);
    return { accessToken, ...(next ? { refreshToken: next } : {}), expiresIn: seconds(json.expires_in, 3600) };
  }
  if (status >= 500 || status === 429) throw new MailError('TRANSIENT_NETWORK', 'Microsoft\'s sign-in service is busy; try again shortly.', 'FAILED', true);
  // Revoked, expired, password changed: only a new sign-in mends it.
  throw new MailError('AUTH_FAILED', 'Microsoft no longer accepts this account\'s sign-in. Sign in again on your Universal Mail page.');
}

// How often a new refresh token is saved (MS-04): Microsoft issues one with
// every refresh, and a saved one stays good for 90 days unused; saving each
// would write the secret every hour.
const SAVE_EVERY_MS = 7 * 24 * 3600_000;
// An access token is replaced five minutes before it ends.
const EARLY_MS = 5 * 60_000;

// One account's tokens: an access token kept until near its end, one refresh
// at a time, the newest refresh token used from then on and saved weekly.
export class MicrosoftTokens {
  private refreshToken: string;
  private current?: { token: string; until: number };
  private pending?: Promise<string>;
  private savedAt: number;

  constructor(private readonly settings: MicrosoftSettings, refreshToken: string,
    private readonly options: { clock?: Clock; savedAt?: number; onRotated?(refreshToken: string): void } = {}) {
    this.refreshToken = refreshToken;
    this.savedAt = options.savedAt ?? this.now();
  }

  private now() { return (this.options.clock ?? Date).now(); }

  accessToken(): Promise<string> {
    if (this.current && this.now() < this.current.until - EARLY_MS) return Promise.resolve(this.current.token);
    this.pending ??= this.renew().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  // A connection the server refused: the next one asks Microsoft afresh.
  invalidate() { this.current = undefined; }

  private async renew(): Promise<string> {
    const got = await refreshAccess(this.settings, this.refreshToken);
    this.current = { token: got.accessToken, until: this.now() + got.expiresIn * 1000 };
    if (got.refreshToken && got.refreshToken !== this.refreshToken) {
      this.refreshToken = got.refreshToken;
      if (this.options.onRotated && this.now() - this.savedAt >= SAVE_EVERY_MS) {
        this.savedAt = this.now();
        this.options.onRotated(got.refreshToken);
      }
    }
    return got.accessToken;
  }
}
