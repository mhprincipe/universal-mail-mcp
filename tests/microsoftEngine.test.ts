import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config.js';
import { loadAccounts } from '../src/accountsConfig.js';
import { ImapGateway } from '../src/mail/imap.js';
import { MailService } from '../src/mail/mailService.js';
import { createAccountServices } from '../src/multiMail.js';
import { createInstallStore, mailSettings, readInstalled } from '../src/installed.js';

// A Microsoft account in the engine (2.5): IMAP and SMTP sign in with an
// access token (XOAUTH2) from the account's refresh token, never a password.
afterEach(() => { vi.restoreAllMocks(); });

const base = { MAIL_ADDRESS: 'me@msmail.example', MAIL_APP_PASSWORD: 'refresh-token-1', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars' };

function fakeClient(connect: () => Promise<void> = async () => undefined) {
  return { usable: true, connect, logout: async () => undefined, close: () => undefined, noop: async () => undefined, list: async () => [], on: () => undefined };
}

describe('the engine with a Microsoft account', () => {
  it('MS-06 IMAP signs in with the account\'s address and a fresh access token, never a password (added: 2.5)', async () => {
    const tokens = { accessToken: vi.fn(async () => 'access-1'), invalidate: vi.fn() };
    const made: unknown[] = [];
    const gateway = new ImapGateway(loadConfig({ ...base, MAIL_AUTH: 'microsoft' }), { tokens, createClient: auth => { made.push(auth); return fakeClient() as never; } });
    await gateway.listFolders();
    expect(made).toEqual([{ user: 'me@msmail.example', accessToken: 'access-1' }]);
  });

  it('MS-06 a password account still signs in with its password', async () => {
    const made: unknown[] = [];
    const gateway = new ImapGateway(loadConfig(base), { createClient: auth => { made.push(auth); return fakeClient() as never; } });
    await gateway.listFolders();
    expect(made).toEqual([{ user: 'me@msmail.example', pass: 'refresh-token-1' }]);
  });

  it('MS-06 a sign-in the server refuses drops the access token, so the next connection asks Microsoft afresh', async () => {
    const tokens = { accessToken: vi.fn(async () => 'access-1'), invalidate: vi.fn() };
    const refused = Object.assign(new Error('Authentication failed'), { authenticationFailed: true });
    const gateway = new ImapGateway(loadConfig({ ...base, MAIL_AUTH: 'microsoft' }), { tokens, createClient: () => fakeClient(async () => { throw refused; }) as never });
    await expect(gateway.listFolders()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(tokens.invalidate).toHaveBeenCalled();
  });

  it('MS-07 SMTP signs in with OAuth2 and a fresh access token for each send; a password account keeps its password', async () => {
    const transports: any[] = [];
    vi.spyOn(nodemailer, 'createTransport').mockImplementation(((options: any) => {
      transports.push(options);
      return { sendMail: async () => ({ accepted: ['someone@example.invalid'], rejected: [] }), verify: async () => true };
    }) as never);
    const tokens = { accessToken: vi.fn(async () => `access-${tokens.accessToken.mock.calls.length}`), invalidate: vi.fn() };
    const service = new MailService(loadConfig({ ...base, MAIL_AUTH: 'microsoft' }), { tokens });
    await service.sendSystemEmail('someone@example.invalid', 'Hello', 'Hi');
    await service.sendSystemEmail('someone@example.invalid', 'Hello again', 'Hi');
    const oauth = transports.filter(t => t.auth?.type === 'OAuth2');
    expect(oauth.map(t => t.auth)).toEqual([
      { type: 'OAuth2', user: 'me@msmail.example', accessToken: 'access-1' },
      { type: 'OAuth2', user: 'me@msmail.example', accessToken: 'access-2' }
    ]);
    expect(transports.some(t => t.auth?.pass)).toBe(false);
    transports.length = 0;
    new MailService(loadConfig(base));
    expect(transports.map(t => t.auth)).toEqual([{ user: 'me@msmail.example', pass: 'refresh-token-1' }]);
  });
});

describe('a Microsoft account in the account list', () => {
  const list = (extra: Record<string, unknown>) => ({
    MAIL_ACCOUNTS: JSON.stringify([{ name: 'outlook', email: 'me@msmail.example', imap: { host: 'outlook.office365.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' }, sentCopyMode: 'yahoo', ...extra }]),
    MAIL_PASSWORDS: JSON.stringify({ outlook: 'refresh-token-1' }),
    MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars'
  });

  it('MS-08 auth and when its sign-in was last saved come through the account list (added: 2.5)', () => {
    const [account] = loadAccounts(list({ auth: 'microsoft', tokenSavedAt: 1234 }));
    expect(account).toMatchObject({ name: 'outlook', auth: 'microsoft', tokenSavedAt: 1234 });
    expect(account!.config.MAIL_AUTH).toBe('microsoft');
    expect(loadAccounts(list({}))[0]!.config.MAIL_AUTH).toBe('password');
  });

  it('MS-08 without a Microsoft app id on the server, the account is there but every call says Microsoft sign-in isn\'t set up', async () => {
    const services = createAccountServices(loadAccounts(list({ auth: 'microsoft' })));
    await expect(services.get('outlook')!.listFolders()).rejects.toMatchObject({ code: 'MICROSOFT_NOT_SET_UP' });
  });

  it('MS-08 with an app id, a new refresh token Microsoft hands out is passed on to be saved', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'a1', refresh_token: 'refresh-token-2', expires_in: 3600 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const saved: Array<[string, string]> = [];
    const services = createAccountServices(loadAccounts({ ...list({ auth: 'microsoft', tokenSavedAt: 0 }), MICROSOFT_CLIENT_ID: 'client-123' }), { onToken: (name, token) => { saved.push([name, token]); } });
    vi.spyOn(ImapGateway.prototype as any, 'connection').mockImplementation(async function (this: any) { await this.options.tokens.accessToken(); return fakeClient(); });
    await services.get('outlook')!.listFolders().catch(() => undefined);
    vi.unstubAllGlobals();
    expect(saved).toEqual([['outlook', 'refresh-token-2']]);
  });
});

describe('a Microsoft account installed', () => {
  const state = (account: Record<string, unknown>) => JSON.stringify({
    version: 1, key: 'k'.repeat(22), signInAddress: 'me@msmail.example', grants: {}, fingerprints: [],
    accounts: [{ name: 'outlook', email: 'me@msmail.example', provider: 'outlook', imap: { host: 'outlook.office365.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' }, sentCopyMode: 'yahoo', ...account }]
  });
  const credentials = JSON.stringify({ passwords: { outlook: 'refresh-token-1' }, signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }, encryptionKey: 'e'.repeat(43) });

  it('MS-09 the state keeps auth and when the sign-in was saved; the engine\'s settings carry them (added: 2.5)', () => {
    const installed = readInstalled({ UNIVERSAL_MAIL_STATE: state({ auth: 'microsoft', tokenSavedAt: 99 }), UNIVERSAL_MAIL_CREDENTIALS: credentials, PUBLIC_URL: 'https://mail.example' });
    expect(installed.status).toBe('ready');
    const settings = mailSettings((installed as any).state.accounts, { outlook: 'refresh-token-1' });
    expect(JSON.parse(settings.MAIL_ACCOUNTS)[0]).toMatchObject({ auth: 'microsoft', tokenSavedAt: 99 });
  });

  it('MS-09 saving a new refresh token: the credentials and its date, without rebuilding the mail access', async () => {
    const installed = readInstalled({ UNIVERSAL_MAIL_STATE: state({ auth: 'microsoft' }), UNIVERSAL_MAIL_CREDENTIALS: credentials, PUBLIC_URL: 'https://mail.example' }) as any;
    const saves: Array<[string, string]> = [];
    const store = createInstallStore(installed, { state: async json => { saves.push(['state', json]); }, credentials: async json => { saves.push(['credentials', json]); } });
    const rebuilt = vi.fn();
    store.onAccountsChange(rebuilt);
    store.saveToken('outlook', 'refresh-token-2', 5_000);
    await store.settled();
    expect(rebuilt).not.toHaveBeenCalled();
    expect(JSON.parse(saves.find(([what]) => what === 'credentials')![1]).passwords.outlook).toBe('refresh-token-2');
    expect(JSON.parse(saves.filter(([what]) => what === 'state').at(-1)![1]).accounts[0]).toMatchObject({ tokenSavedAt: 5_000 });
    expect(JSON.parse(store.mailSettings().MAIL_PASSWORDS).outlook).toBe('refresh-token-2');
  });
});
