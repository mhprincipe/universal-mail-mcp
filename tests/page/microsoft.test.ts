import { afterEach, describe, expect, it } from 'vitest';
import { createCanary } from '../../testkit/src/canary.js';
import { startPage, type ServiceAnswer } from './pageHarness.js';

// Adding an Outlook.com account on your page (2.5): Sign in with Microsoft,
// a code typed at microsoft.com, then the usual checks with the access token;
// the refresh token kept where an app password is kept, never shown.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

const last = (list: string[]) => JSON.parse(list.at(-1)!);
const ADDRESS = 'me@msmail.example';

// Microsoft, scripted: the device code once, then each poll's answer in turn.
function microsoft(polls: ServiceAnswer[], refreshToken = 'refresh-token-ms') {
  return (path: string): ServiceAnswer => {
    if (path === '/oauth2/v2.0/devicecode') return { status: 200, body: { device_code: 'device-code-secret', user_code: 'WXYZ-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 } };
    return polls.shift() ?? { status: 200, body: { access_token: 'access-ms', refresh_token: refreshToken, expires_in: 3600 } };
  };
}
const pending: ServiceAnswer = { status: 400, body: { error: 'authorization_pending' } };

describe('when Microsoft stops accepting the sign-in', () => {
  it('MS-17 the "something broke" email says to sign in again, and the page says the Microsoft sign-in needs renewing (added: 2.5)', async () => {
    const { vi } = await import('vitest');
    const { ImapGateway } = await import('../../src/mail/imap.js');
    p = await startPage({
      microsoft: microsoft([]),
      state: { accounts: [{ name: 'outlook', email: ADDRESS, provider: 'outlook', auth: 'microsoft', imap: { host: 'outlook.office365.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' }, sentCopyMode: 'yahoo' }], signInAddress: ADDRESS },
      passwords: { outlook: 'refresh-token-old' }
    });
    const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { outlook: ['read'] });
    const refused = vi.spyOn(ImapGateway.prototype, 'listFolders').mockRejectedValue(Object.assign(new Error('Authentication failed.'), { authenticationFailed: true }));
    await p.mcp(claude, grant.connection, 'tools/call', { name: 'list_folders', arguments: { account: 'outlook' } });
    refused.mockRestore();
    const broke = p.sent.find(s => /stopped working/.test(s.subject));
    expect(broke).toMatchObject({ subject: 'The Microsoft sign-in for outlook stopped working' });
    expect(broke!.text).toContain('Sign in again');
    expect((await p.signIn()).html).toContain('Microsoft sign-in needs renewing');
  });
});

describe('Sign in with Microsoft', () => {
  it('MS-12 shown only when Microsoft sign-in is set up on the server (added: 2.5)', async () => {
    p = await startPage();
    expect((await p.signIn()).html).not.toContain('Add an Outlook.com account');
    await p.close();
    p = await startPage({ microsoft: microsoft([]) });
    expect((await p.signIn()).html).toContain('Add an Outlook.com account');
  });

  it('MS-12 an Outlook.com address given an app password is told to sign in with Microsoft; nothing is checked', async () => {
    p = await startPage({ microsoft: microsoft([]) });
    await p.signIn();
    const page = await p.act('/accounts/add', { email: ADDRESS, password: 'some-app-password' });
    expect(page.html).toContain('Outlook.com accounts sign in with Microsoft');
    expect(p.saves.state).toHaveLength(0);
  });

  it('MS-13 the code and Microsoft\'s page are shown; finishing before approving says so and keeps the code; approving adds the account (added: 2.5)', async () => {
    const refresh = createCanary('refresh');
    p = await startPage({ microsoft: microsoft([pending], refresh) });
    p.accepted[ADDRESS] = 'token:access-ms';
    await p.signIn();
    const started = await p.act('/accounts/microsoft/start', { email: ADDRESS, name: 'outlook' });
    expect(started.html).toContain('WXYZ-1234');
    expect(started.html).toContain('https://microsoft.com/devicelogin');
    expect(started.html).not.toContain('device-code-secret');
    const early = await p.act('/accounts/microsoft/finish', {});
    expect(early.html).toContain('not approved yet');
    expect(early.html).toContain('WXYZ-1234');
    const done = await p.act('/accounts/microsoft/finish', {});
    expect(done.html).toContain('outlook was added');
    expect(last(p.saves.state).accounts.at(-1)).toMatchObject({
      name: 'outlook', email: ADDRESS, provider: 'outlook', auth: 'microsoft', sentCopyMode: 'yahoo',
      imap: { host: 'outlook.office365.com' }, smtp: { host: 'smtp-mail.outlook.com' }, tokenSavedAt: p.clock.now()
    });
    expect(last(p.saves.credentials).passwords.outlook).toBe(refresh);
    expect(p.sent.at(-1)!.subject).toBe('An email account was added to Universal Mail');
    for (const page of p.pages) expect(page).not.toContain(refresh);
    expect(JSON.stringify(p.logged())).not.toContain(refresh);
    // Microsoft was asked for the code with the server's app id, and polled with the device code.
    expect(p.microsoftCalls.map(c => c.path)).toEqual(['/oauth2/v2.0/devicecode', '/oauth2/v2.0/token', '/oauth2/v2.0/token']);
    expect(p.microsoftCalls[0]!.body.client_id).toBe('ms-client-id');
  });

  it('MS-14 declined or expired: said plainly, and nothing is saved', async () => {
    p = await startPage({ microsoft: microsoft([{ status: 400, body: { error: 'authorization_declined' } }, { status: 400, body: { error: 'expired_token' } }]) });
    await p.signIn();
    await p.act('/accounts/microsoft/start', { email: ADDRESS });
    expect((await p.act('/accounts/microsoft/finish', {})).html).toContain('was not approved');
    await p.act('/accounts/microsoft/start', { email: ADDRESS });
    expect((await p.act('/accounts/microsoft/finish', {})).html).toContain('The code ran out');
    expect(p.saves.state).toHaveLength(0);
  });

  it('MS-14 a code past its time is not sent to Microsoft again: said, start again', async () => {
    // A code that lasts a minute (Microsoft's last 15; the page's own session ends after 15 idle).
    const short = (path: string): ServiceAnswer => path === '/oauth2/v2.0/devicecode'
      ? { status: 200, body: { device_code: 'device-code-secret', user_code: 'WXYZ-1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 60, interval: 5 } }
      : { status: 200, body: { access_token: 'access-ms', refresh_token: 'refresh-token-ms', expires_in: 3600 } };
    p = await startPage({ microsoft: short });
    await p.signIn();
    await p.act('/accounts/microsoft/start', { email: ADDRESS });
    p.clock.advance(61_000);
    expect((await p.act('/accounts/microsoft/finish', {})).html).toContain('The code ran out');
    expect(p.microsoftCalls.map(c => c.path)).toEqual(['/oauth2/v2.0/devicecode']);
    expect(p.saves.state).toHaveLength(0);
  });

  it('MS-14 Microsoft not answering when a sign-in starts: said, nothing started', async () => {
    p = await startPage({ microsoft: () => { throw new Error('down'); } });
    await p.signIn();
    expect((await p.act('/accounts/microsoft/start', { email: ADDRESS })).html).toContain('Microsoft did not answer');
    expect((await p.act('/accounts/microsoft/finish', {})).html).toContain('Start again');
  });

  it('MS-14 approved, but the account then fails its check: said, nothing saved', async () => {
    p = await startPage({ microsoft: microsoft([]) });
    p.accepted[ADDRESS] = 'token:some-other-token';
    await p.signIn();
    await p.act('/accounts/microsoft/start', { email: ADDRESS });
    const page = await p.act('/accounts/microsoft/finish', {});
    expect(page.html).toContain('could not read or send mail');
    expect(p.saves.state).toHaveLength(0);
  });

  it('MS-14 only an Outlook.com address can start; finishing with nothing started says so', async () => {
    p = await startPage({ microsoft: microsoft([]) });
    await p.signIn();
    expect((await p.act('/accounts/microsoft/start', { email: 'someone@example.invalid' })).html).toContain('is not an Outlook.com, Hotmail, Live or MSN address');
    expect((await p.act('/accounts/microsoft/finish', {})).html).toContain('Start again');
    expect(p.microsoftCalls).toHaveLength(0);
  });

  it('MS-15 a Microsoft account shows Sign in again, not an app password; signing in again replaces its token and keeps everything else', async () => {
    p = await startPage({
      microsoft: microsoft([], 'refresh-token-new'),
      state: { accounts: [{ name: 'outlook', email: ADDRESS, provider: 'outlook', auth: 'microsoft', imap: { host: 'outlook.office365.com', port: 993, tls: 'implicit' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' }, sentCopyMode: 'yahoo', sendLimits: { perHour: 5, perDay: 9 } }], signInAddress: ADDRESS },
      passwords: { outlook: 'refresh-token-old' }
    });
    p.accepted[ADDRESS] = 'token:access-ms';
    const shown = (await p.signIn()).html;
    expect(shown).toContain('Sign in again');
    expect(shown).not.toContain('Change the app password');
    await p.act('/accounts/microsoft/start', { email: ADDRESS, again: 'outlook' });
    const done = await p.act('/accounts/microsoft/finish', {});
    expect(done.html).toContain('outlook is signed in again');
    expect(last(p.saves.state).accounts).toHaveLength(1);
    expect(last(p.saves.state).accounts[0]).toMatchObject({ name: 'outlook', auth: 'microsoft', sendLimits: { perHour: 5, perDay: 9 } });
    expect(last(p.saves.credentials).passwords.outlook).toBe('refresh-token-new');
  });
});
