import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from '../../src/tools.js';
import { VERSION } from '../../src/version.js';
import { ImapGateway } from '../../src/mail/imap.js';
import { KEY, PUBLIC_URL, startPage } from './pageHarness.js';

// The emails the server sends on its own (design §3.7).
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; vi.restoreAllMocks(); });

const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const DAY = 24 * 60 * 60_000;
// The provider refusing the saved app password, as ImapFlow reports it.
const refusePassword = () => vi.spyOn(ImapGateway.prototype, 'listFolders').mockRejectedValue(Object.assign(new Error('Authentication failed.'), { authenticationFailed: true }));
const listFolders = (page: NonNullable<typeof p>, connection: number) => page.mcp(claude, connection, 'tools/call', { name: 'list_folders', arguments: { account: 'me' } });

describe('emails the server sends', () => {
  it('PG-11 every change sends a "something changed" email, and turning sending off is not one', async () => {
    p = await startPage({ accepted: { 'me@example.invalid': 'new-app-password', 'work@example.invalid': 'work-app-password', 'side@example.invalid': 'side-app-password' } });
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.signIn();
    const before = p.sent.length;
    await p.act('/accounts/add', { email: 'side@example.invalid', password: 'side-app-password', name: 'side' });
    await p.act('/accounts/password', { name: 'me', password: 'new-app-password' });
    await p.act('/accounts/sending', { name: 'work', on: 'off' });
    await p.act('/accounts/sending', { name: 'work', on: 'on' });
    await p.act('/apps/permissions', { app: claude, 'me:read': 'on', 'me:organize': 'on' });
    await p.act('/apps/disconnect', { app: claude });
    await p.act('/accounts/remove', { name: 'side', confirm: 'side' });
    expect(p.sent.slice(before).map(s => `${s.to}: ${s.subject}`)).toEqual([
      'me@example.invalid: An email account was added to Universal Mail',
      'me@example.invalid: The app password for me was changed',
      'me@example.invalid: Sending was turned on for work',
      'me@example.invalid: Claude\'s permissions changed',
      'me@example.invalid: Claude was disconnected from your email',
      'me@example.invalid: An email account was removed from Universal Mail'
    ]);
  });

  it('PG-12 repeated sign-in failures on an account send one "something broke" email with Fix it, not one per failure', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    refusePassword();
    for (let i = 0; i < 3; i++) await listFolders(p, grant.connection);
    const broke = p.sent.filter(s => /stopped working/.test(s.subject));
    expect(broke).toHaveLength(1);
    expect(broke[0]).toMatchObject({ to: 'me@example.invalid', subject: 'The password for me stopped working' });
    expect(broke[0]!.text).toContain(`Fix it: ${PUBLIC_URL}/${KEY}`);
    // The page says so too.
    await p.signIn();
    expect((await p.get()).html).toMatch(/id="account-me">[\s\S]*?Password not accepted/);
  });

  it('PG-12 once fixed, a new break is told again', async () => {
    p = await startPage({ accepted: { 'me@example.invalid': 'new-app-password', 'work@example.invalid': 'work-app-password' } });
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    const refused = refusePassword();
    await listFolders(p, grant.connection);
    await p.signIn();
    await p.act('/accounts/password', { name: 'me', password: 'new-app-password' });
    refused.mockRejectedValue(Object.assign(new Error('Authentication failed.'), { authenticationFailed: true }));
    await listFolders(p, grant.connection);
    expect(p.sent.filter(s => /stopped working/.test(s.subject))).toHaveLength(2);
  });

  it('PG-13 when the sign-in account is the broken one, the alert goes out through another account', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    p.broken.add('me');
    refusePassword();
    await listFolders(p, grant.connection);
    expect(p.sent.find(s => /stopped working/.test(s.subject))).toMatchObject({ account: 'work', to: 'me@example.invalid' });
  });

  it('PG-14 the free-trial reminder is sent before day 80 when the account wasn\'t upgraded, once, even across a restart', async () => {
    const installedAt = '2026-07-01T12:00:00.000Z';
    p = await startPage({ state: { trialReminder: true, installedAt }, start: new Date(Date.parse(installedAt) + 69 * DAY) });
    await p.get();
    expect(p.sent.filter(s => /free trial/i.test(s.subject))).toHaveLength(0);
    p.clock.advance(2 * DAY);
    await p.get();
    await p.get();
    const reminders = p.sent.filter(s => /free trial/i.test(s.subject));
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.text).toContain('Activate full account');
    await p.app.signin!.saved();
    const saved = JSON.parse(p.saves.state.at(-1)!);
    expect(saved.trialReminderSent).toBe(true);
    await p.close();
    // Restarted with what was saved: not sent again.
    p = await startPage({ state: saved, start: new Date(Date.parse(installedAt) + 75 * DAY) });
    await p.get();
    expect(p.sent.filter(s => /free trial/i.test(s.subject))).toHaveLength(0);
  });

  it('PG-14 an upgraded account never gets the reminder', async () => {
    p = await startPage({ state: { trialReminder: false, installedAt: '2026-07-01T12:00:00.000Z' }, start: new Date('2026-09-15T12:00:00Z') });
    await p.get();
    expect(p.sent.filter(s => /free trial/i.test(s.subject))).toHaveLength(0);
  });

  it('PG-15 update-available emails mark security releases; each version is told once; the feed is asked at most daily', async () => {
    // The next major version: newer than whatever is running, so a release doesn't break the test.
    const nextMajor = VERSION.replace(/^(\d+)\..*$/, (_m, major: string) => `${Number(major) + 1}.0.0`);
    p = await startPage({ env: { UPDATE_FEED_URL: 'https://updates.example.invalid/latest.json' }, feed: { version: nextMajor, security: true } });
    await p.get();
    await p.get();
    const updates = p.sent.filter(s => /available/.test(s.subject));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.subject).toBe(`Universal Mail ${nextMajor} is available (security update)`);
    expect(updates[0]!.text).toContain('node setup.js');
    expect(p.feedAsked).toEqual(['https://updates.example.invalid/latest.json']);
    p.clock.advance(DAY + 1000);
    await p.get();
    expect(p.feedAsked).toHaveLength(2);
    expect(p.sent.filter(s => /available/.test(s.subject))).toHaveLength(1);
  });

  it('PG-15 nothing newer, an ordinary release, or no feed configured', async () => {
    // Relative to the running version, so a release doesn't break the test.
    p = await startPage({ env: { UPDATE_FEED_URL: 'https://updates.example.invalid/latest.json' }, feed: { version: VERSION, security: false } });
    await p.get();
    expect(p.sent.filter(s => /available/.test(s.subject))).toHaveLength(0);
    await p.close();
    const nextPatch = VERSION.replace(/^(\d+\.\d+\.)(\d+).*$/, (_m, head: string, patch: string) => `${head}${Number(patch) + 1}`);
    p = await startPage({ env: { UPDATE_FEED_URL: 'https://updates.example.invalid/latest.json' }, feed: { version: nextPatch, security: false } });
    await p.get();
    expect(p.sent.find(s => /available/.test(s.subject))!.subject).toBe(`Universal Mail ${nextPatch} is available`);
    await p.close();
    p = await startPage({ feed: { version: '9.0.0', security: true } });
    await p.get();
    expect(p.feedAsked).toEqual([]);
  });
});

describe('when the tools change', () => {
  // Found live (2026-09-30): Claude kept the tool list it saw when it was
  // connected, and never saw five tools added since. The owner is told once,
  // with the steps, whenever a new version brings tools the apps don't know.
  const notices = () => p!.sent.filter(s => /tools/i.test(s.subject));

  it('NTC-01 new tools since the last start: one email naming them and saying how to refresh each app; told once, even across a restart (added: 2.4.3, found live)', async () => {
    const before = TOOL_NAMES.filter(name => name !== 'forward_email' && name !== 'junk_email');
    p = await startPage({ state: { toolNames: before } });
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.get();
    await p.get();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.subject).toBe('Universal Mail has new tools for your AI apps');
    expect(notices()[0]!.text).toContain('forward_email, junk_email');
    expect(notices()[0]!.text).toContain('Claude');
    expect(notices()[0]!.text).toMatch(/Settings → Connectors/);
    expect(notices()[0]!.text).toContain(`It should list ${TOOL_NAMES.length}.`);
    await p.app.signin!.saved();
    const saved = JSON.parse(p.saves.state.at(-1)!);
    expect(saved.toolNames).toEqual([...TOOL_NAMES]);
    await p.close();
    p = await startPage({ state: saved });
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.get();
    expect(notices()).toHaveLength(0);
  });

  it('NTC-02 a new installation (no apps yet) and a restart with the same tools say nothing; a server updated from before 2.4.3 with apps connected says so once', async () => {
    // No list noted yet: a new installation.
    p = await startPage({ state: { toolNames: undefined } });
    await p.get();
    expect(notices()).toHaveLength(0);
    await p.app.signin!.saved();
    expect(JSON.parse(p.saves.state.at(-1)!).toolNames).toEqual([...TOOL_NAMES]);
    await p.close();
    p = await startPage({ state: { toolNames: [...TOOL_NAMES] } });
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.get();
    expect(notices()).toHaveLength(0);
    await p.close();
    // Updated from a version that didn't keep the list: its apps may hold an old one.
    p = await startPage({ state: { toolNames: undefined } });
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.get();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.text).toContain(`Universal Mail ${VERSION} has ${TOOL_NAMES.length} tools`);
  });
});
