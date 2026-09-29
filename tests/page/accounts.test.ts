import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImapGateway } from '../../src/yahoo/imap.js';
import { startPage } from './pageHarness.js';

// Your page: the accounts (design §3.6). Every change takes effect at once,
// is saved, and is emailed to you.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

const last = (list: string[]) => JSON.parse(list.at(-1)!);
const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

describe('accounts on your page', () => {
  // ENG-18 (added): connections are kept now, so a change of accounts must
  // log the old ones out, not leave them open with an old password.
  it('ENG-18 changing an account logs out the kept connections of the mail access it replaces', async () => {
    p = await startPage();
    const closed = vi.spyOn(ImapGateway.prototype, 'close');
    p.app.signin!.mail();
    await p.signIn();
    p.accepted['me@example.invalid'] = 'me-new-app-password';
    await p.act('/accounts/password', { name: 'me', password: 'me-new-app-password' });
    expect(closed).toHaveBeenCalledTimes(2);
    closed.mockRestore();
  });

  it('PG-03 adding an account runs the same checks as setup; it is saved, usable at once, and you are told', async () => {
    p = await startPage();
    p.accepted['side@example.invalid'] = 'side-app-password';
    await p.signIn();
    const page = await p.act('/accounts/add', { email: 'side@example.invalid', password: 'side-app-password', name: 'side' });
    expect(page.html).toContain('side was added');
    expect(page.html).toContain('id="account-side"');
    expect(last(p.saves.credentials).passwords.side).toBe('side-app-password');
    expect(last(p.saves.state).accounts.at(-1)).toMatchObject({ name: 'side', email: 'side@example.invalid', imap: { port: 3 }, sending: true });
    expect(p.app.signin!.accountNames()).toContain('side');
    expect(p.sent.at(-1)).toMatchObject({ to: 'me@example.invalid', subject: 'An email account was added to Universal Mail' });
    // The password is never shown back.
    expect(page.html).not.toContain('side-app-password');
  });

  it('PG-03 a wrong password shows the same message as setup, and nothing is added', async () => {
    p = await startPage();
    await p.signIn();
    const before = p.saves.credentials.length;
    const page = await p.act('/accounts/add', { email: 'side@example.invalid', password: 'not-the-right-one', name: 'side' });
    expect(page.html).toContain('Example Mail didn&#39;t accept that app password.');
    expect(page.html).toContain('example.invalid/app-passwords');
    expect(page.html).not.toContain('id="account-side"');
    expect(p.saves.credentials.length).toBe(before);
    expect(page.html).not.toContain('not-the-right-one');
  });

  it('PG-03 a name already taken is refused; one left blank is chosen for you', async () => {
    p = await startPage();
    p.accepted['side@example.invalid'] = 'side-app-password';
    await p.signIn();
    expect((await p.act('/accounts/add', { email: 'side@example.invalid', password: 'side-app-password', name: 'work' })).html).toContain('That name is taken');
    const page = await p.act('/accounts/add', { email: 'side@example.invalid', password: 'side-app-password', name: '' });
    expect(page.html).toContain('id="account-side"');
  });

  it('PG-04 Fix it changes a password: checked first, saved, and the account turns green', async () => {
    p = await startPage();
    p.accepted['me@example.invalid'] = 'new-app-password';
    await p.signIn();
    const wrong = await p.act('/accounts/password', { name: 'me', password: 'still-wrong' });
    expect(wrong.html).toContain('Example Mail didn&#39;t accept that app password.');
    const page = await p.act('/accounts/password', { name: 'me', password: 'new-app-password' });
    expect(page.html).toMatch(/id="account-me">[\s\S]*?class="ok">Working/);
    expect(last(p.saves.credentials).passwords).toEqual({ me: 'new-app-password', work: 'work-app-password' });
    expect(p.sent.at(-1)!.subject).toBe('The app password for me was changed');
  });

  it('PG-05 removing an account stops access immediately and deletes its password', async () => {
    p = await startPage();
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'], work: ['read', 'organize'] });
    await p.signIn();
    const refused = await p.act('/accounts/remove', { name: 'work', confirm: 'wrong' });
    expect(refused.html).toContain('Type the account name');
    expect(p.app.signin!.accountNames()).toContain('work');

    const page = await p.act('/accounts/remove', { name: 'work', confirm: 'work' });
    expect(page.html).toContain('work was removed');
    expect(p.app.signin!.accountNames()).toEqual(['me']);
    expect(last(p.saves.credentials).passwords).toEqual({ me: 'me-app-password' });
    expect(last(p.saves.state).accounts.map((a: { name: string }) => a.name)).toEqual(['me']);
    // No app keeps a permission for an account that's gone.
    expect(p.app.signin!.grants.get(claude)!.accounts).toEqual({ me: ['read'] });
    expect(p.sent.at(-1)!.subject).toBe('An email account was removed from Universal Mail');
  });

  it('PG-19 an account can be renamed: its password, settings and every app\'s permissions carry over, and apps use the new name at once without reconnecting (added: the owner, after Gmail was named for its address)', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'], work: ['read', 'organize', 'send'] });
    await p.signIn();
    await p.act('/accounts/sending', { name: 'work', on: 'off' });
    const form = (await p.get()).html;
    expect(form).toMatch(/id="account-work">[\s\S]*?\/accounts\/rename/);

    expect((await p.act('/accounts/rename', { name: 'work', to: 'me' })).html).toContain('That name is taken');
    expect((await p.act('/accounts/rename', { name: 'work', to: 'Two words' })).html).toContain('Names use lowercase letters, digits and hyphens');
    expect((await p.act('/accounts/rename', { name: 'gone', to: 'office' })).html).toContain('That account isn&#39;t here any more.');
    expect(p.app.signin!.accountNames()).toEqual(['me', 'work']);

    const page = await p.act('/accounts/rename', { name: 'work', to: ' Office ' });
    expect(page.html).toContain('work is now called office');
    expect(page.html).toContain('id="account-office"');
    expect(page.html).not.toContain('id="account-work"');
    expect(p.app.signin!.accountNames()).toEqual(['me', 'office']);
    expect(last(p.saves.credentials).passwords).toEqual({ me: 'me-app-password', office: 'work-app-password' });
    const saved = last(p.saves.state).accounts;
    expect(saved.map((a: { name: string }) => a.name)).toEqual(['me', 'office']);
    expect(saved[1]).toMatchObject({ email: 'work@example.invalid', sending: false });
    // The same connection (no new sign-in), with the permissions under the new name.
    expect(p.app.signin!.grants.get(claude)).toMatchObject({ connection: grant.connection, accounts: { me: ['read'], office: ['read', 'organize', 'send'] } });
    expect(p.app.signin!.grants.get(claude)!.accounts).not.toHaveProperty('work');
    expect(p.sent.at(-1)).toMatchObject({ subject: 'An email account was renamed' });
    expect(p.sent.at(-1)!.text).toContain('"work" is now "office"');
  });

  it('PG-03 an app password pasted with the spaces its provider shows (Gmail\'s "abcd efgh ijkl mnop") works as it is (added: adding Gmail)', async () => {
    p = await startPage();
    p.accepted['side@example.invalid'] = 'abcdefghijklmnop';
    p.accepted['me@example.invalid'] = 'qrstuvwxyzabcdef';
    await p.signIn();
    const page = await p.act('/accounts/add', { email: 'side@example.invalid', password: ' abcd efgh ijkl mnop ', name: 'side' });
    expect(page.html).toContain('side was added');
    expect(last(p.saves.credentials).passwords.side).toBe('abcdefghijklmnop');
    await p.act('/accounts/password', { name: 'me', password: 'qrst uvwx yzab cdef' });
    expect(last(p.saves.credentials).passwords.me).toBe('qrstuvwxyzabcdef');
  });

  it('PG-05 the last account can\'t be removed', async () => {
    p = await startPage();
    await p.signIn();
    await p.act('/accounts/remove', { name: 'work', confirm: 'work' });
    const page = await p.act('/accounts/remove', { name: 'me', confirm: 'me' });
    expect(page.html).toContain('Universal Mail needs at least one account');
    expect(p.app.signin!.accountNames()).toEqual(['me']);
  });

  it('PG-08 sending can be turned off and on per account; off means no app can send from it', async () => {
    p = await startPage();
    await p.signIn();
    let page = await p.act('/accounts/sending', { name: 'work', on: 'off' });
    expect(page.html).toMatch(/id="account-work">[\s\S]*?Sending off/);
    expect(last(p.saves.state).accounts[1].sending).toBe(false);
    expect(() => p!.app.signin!.mail().service('work', 'send')).toThrow(/Sending is turned off for work/);
    expect(() => p!.app.signin!.mail().service('me', 'send')).not.toThrow();
    const sentBefore = p.sent.length;
    page = await p.act('/accounts/sending', { name: 'work', on: 'on' });
    expect(() => p!.app.signin!.mail().service('work', 'send')).not.toThrow();
    // Turning it on is a change you're told about.
    expect(p.sent.slice(sentBefore).map(s => s.subject)).toEqual(['Sending was turned on for work']);
  });
});
