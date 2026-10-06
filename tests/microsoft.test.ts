import { describe, expect, it, vi } from 'vitest';
import { MICROSOFT_SCOPES, MicrosoftTokens, pollDeviceSignIn, refreshAccess, startDeviceSignIn } from '../src/microsoft.js';
import { createCanary } from '../testkit/src/canary.js';

// Microsoft sign-in (2.5, design: DESIGN-PROVIDER-SIGNIN.md): Outlook.com has
// no app passwords, so an account signs in with a code at microsoft.com
// (device code), and Universal Mail keeps the refresh token as it keeps an app
// password. Here, against a stand-in for Microsoft's two endpoints.
type Call = { url: string; body: Record<string, string> };
function microsoft(answers: Array<{ status?: number; json: Record<string, unknown> } | Error>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  const settings = { clientId: 'client-123', authority: 'https://login.example/consumers', fetch: fetchImpl as unknown as typeof fetch };
  return { settings, calls };
}

describe('signing in with a code', () => {
  it('MS-01 a sign-in starts with Microsoft\'s device-code endpoint: the app\'s id, mail scopes and offline access, nothing else (added: 2.5)', async () => {
    const m = microsoft([{ json: { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5, message: 'ignored' } }]);
    const started = await startDeviceSignIn(m.settings, { now: () => 1_000 });
    expect(m.calls).toEqual([{ url: 'https://login.example/consumers/oauth2/v2.0/devicecode', body: { client_id: 'client-123', scope: MICROSOFT_SCOPES } }]);
    expect(MICROSOFT_SCOPES).toBe('https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access');
    expect(started).toEqual({ deviceCode: 'dev-1', userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: 901_000, interval: 5 });
  });

  it('MS-01 a link that isn\'t Microsoft\'s https page is never shown', async () => {
    const m = microsoft([{ json: { device_code: 'dev-1', user_code: 'ABCD', verification_uri: 'http://evil.example/login', expires_in: 900, interval: 5 } }]);
    await expect(startDeviceSignIn(m.settings, { now: () => 0 })).rejects.toThrow(/unexpected/i);
  });

  it('MS-02 waiting: pending and slow down; then done with the refresh token; or declined, or expired', async () => {
    const m = microsoft([
      { status: 400, json: { error: 'authorization_pending' } },
      { status: 400, json: { error: 'slow_down' } },
      { json: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' } },
      { status: 400, json: { error: 'authorization_declined' } },
      { status: 400, json: { error: 'expired_token' } },
      { status: 400, json: { error: 'bad_verification_code' } }
    ]);
    expect(await pollDeviceSignIn(m.settings, 'dev-1')).toEqual({ status: 'pending' });
    expect(await pollDeviceSignIn(m.settings, 'dev-1')).toEqual({ status: 'slow' });
    expect(await pollDeviceSignIn(m.settings, 'dev-1')).toEqual({ status: 'done', refreshToken: 'refresh-1', accessToken: 'access-1', expiresIn: 3600 });
    expect(await pollDeviceSignIn(m.settings, 'dev-1')).toEqual({ status: 'declined' });
    expect(await pollDeviceSignIn(m.settings, 'dev-1')).toEqual({ status: 'expired' });
    expect(await pollDeviceSignIn(m.settings, 'dev-1')).toEqual({ status: 'failed' });
    expect(m.calls[0]).toEqual({ url: 'https://login.example/consumers/oauth2/v2.0/token', body: { client_id: 'client-123', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dev-1' } });
  });

  it('MS-02 an approval without a refresh token (offline access refused) is a failure, never half an account', async () => {
    const m = microsoft([{ json: { access_token: 'access-1', expires_in: 3600 } }]);
    expect(await pollDeviceSignIn(m.settings, 'dev-1')).toEqual({ status: 'failed' });
  });
});

describe('keeping the sign-in', () => {
  it('MS-03 a refresh token buys an access token; a refused one is AUTH_FAILED (sign in again); an outage is transient', async () => {
    const m = microsoft([
      { json: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 } },
      { status: 400, json: { error: 'invalid_grant', error_description: 'AADSTS70000: secret words' } },
      { status: 503, json: {} },
      new TypeError('fetch failed')
    ]);
    expect(await refreshAccess(m.settings, 'refresh-1')).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 3600 });
    expect(m.calls[0]!.body).toEqual({ client_id: 'client-123', grant_type: 'refresh_token', refresh_token: 'refresh-1', scope: MICROSOFT_SCOPES });
    await expect(refreshAccess(m.settings, 'refresh-1')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(refreshAccess(m.settings, 'refresh-1')).rejects.toMatchObject({ code: 'TRANSIENT_NETWORK' });
    await expect(refreshAccess(m.settings, 'refresh-1')).rejects.toMatchObject({ code: 'TRANSIENT_NETWORK' });
  });

  it('MS-03 an access token is reused until five minutes before it ends; two callers at once share one refresh', async () => {
    const m = microsoft([
      { json: { access_token: 'access-a', expires_in: 3600 } },
      { json: { access_token: 'access-b', expires_in: 3600 } }
    ]);
    let now = 0;
    const tokens = new MicrosoftTokens(m.settings, 'refresh-1', { clock: { now: () => now } });
    expect(await Promise.all([tokens.accessToken(), tokens.accessToken()])).toEqual(['access-a', 'access-a']);
    now = 3600_000 - 300_001;
    expect(await tokens.accessToken()).toEqual('access-a');
    now = 3600_000 - 299_000;
    expect(await tokens.accessToken()).toEqual('access-b');
    expect(m.calls).toHaveLength(2);
  });

  it('MS-03 an access token the mail server refused is forgotten: the next asks Microsoft afresh', async () => {
    const m = microsoft([
      { json: { access_token: 'access-a', expires_in: 3600 } },
      { json: { access_token: 'access-b', expires_in: 3600 } }
    ]);
    const tokens = new MicrosoftTokens(m.settings, 'refresh-1', { clock: { now: () => 0 } });
    expect(await tokens.accessToken()).toBe('access-a');
    tokens.invalidate();
    expect(await tokens.accessToken()).toBe('access-b');
  });

  it('MS-04 Microsoft hands out a new refresh token each time: it\'s used from then on, and saved at most once a week', async () => {
    const m = microsoft([
      { json: { access_token: 'a1', refresh_token: 'r2', expires_in: 60 } },
      { json: { access_token: 'a2', refresh_token: 'r3', expires_in: 60 } },
      { json: { access_token: 'a3', refresh_token: 'r4', expires_in: 60 } }
    ]);
    let now = 10 * 24 * 3600_000;
    const saved: string[] = [];
    const tokens = new MicrosoftTokens(m.settings, 'r1', { clock: { now: () => now }, savedAt: 0, onRotated: token => { saved.push(token); } });
    await tokens.accessToken();
    expect(saved).toEqual(['r2']);
    now += 3600_000;
    await tokens.accessToken();
    expect(m.calls[1]!.body.refresh_token).toBe('r2');
    expect(saved).toEqual(['r2']);
    now += 7 * 24 * 3600_000;
    await tokens.accessToken();
    expect(saved).toEqual(['r2', 'r4']);
  });

  it('MS-04 a refused refresh token is never retried in a loop: the next call asks once more, then fails the same way', async () => {
    const m = microsoft([
      { status: 400, json: { error: 'invalid_grant' } },
      { status: 400, json: { error: 'invalid_grant' } }
    ]);
    const tokens = new MicrosoftTokens(m.settings, 'r1', { clock: { now: () => 0 } });
    await expect(tokens.accessToken()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(tokens.accessToken()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(m.calls).toHaveLength(2);
  });

  it('MS-05 no token, code or Microsoft\'s own error words ever appear in an error\'s message', async () => {
    const secret = createCanary('refresh-token');
    const m = microsoft([{ status: 400, json: { error: 'invalid_grant', error_description: `bad token ${secret}` } }]);
    const error = await refreshAccess(m.settings, secret).then(() => undefined, (e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error!.message) + JSON.stringify(error)).not.toContain(secret);
  });
});
