import { afterEach, describe, expect, it } from 'vitest';
import { KEY, startPage } from './pageHarness.js';

// Your page's unusual paths: each says what happened, in plain words, and
// changes nothing it shouldn't.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const last = (list: string[]) => JSON.parse(list.at(-1)!);

describe('your page, the unusual paths', () => {
  it('PG-03 an address no provider is found for gets setup\'s words for it', async () => {
    p = await startPage();
    await p.signIn();
    const page = await p.act('/accounts/add', { email: 'me@unknown.invalid', password: 'x-password', name: '' });
    expect(page.html).toContain('We couldn&#39;t work out how to reach me@unknown.invalid.');
    expect(page.html).not.toContain('id="account-me-2"');
  });

  it('PG-03 a server that can\'t be reached, or won\'t encrypt, is never blamed on the password', async () => {
    p = await startPage();
    await p.signIn();
    const down = await p.act('/accounts/add', { email: 'down@example.invalid', password: 'x-password', name: 'down' });
    expect(down.html).toContain('We couldn&#39;t reach Example Mail to check down@example.invalid.');
    const insecure = await p.act('/accounts/add', { email: 'insecure@example.invalid', password: 'x-password', name: 'insecure' });
    expect(insecure.html).toContain('didn&#39;t offer a secure connection');
    expect(p.app.signin!.accountNames()).toEqual(['me', 'work']);
  });

  it('PG-03 a name must be lowercase letters, digits and hyphens', async () => {
    p = await startPage();
    p.accepted['side@example.invalid'] = 'side-app-password';
    await p.signIn();
    expect((await p.act('/accounts/add', { email: 'side@example.invalid', password: 'side-app-password', name: 'My Side!' })).html).toContain('Names use lowercase letters, digits and hyphens');
  });

  it('PG-03 the Sent test decides who files Sent copies; if it can\'t run, sending waits for a check', async () => {
    p = await startPage();
    p.accepted['appends@example.invalid'] = 'a-app-password';
    p.accepted['nosend@example.invalid'] = 'n-app-password';
    await p.signIn();
    await p.act('/accounts/add', { email: 'appends@example.invalid', password: 'a-app-password', name: 'appends' });
    expect(last(p.saves.state).accounts.at(-1)).toMatchObject({ name: 'appends', sentCopyMode: 'append' });
    await p.act('/accounts/add', { email: 'nosend@example.invalid', password: 'n-app-password', name: 'nosend' });
    expect(last(p.saves.state).accounts.at(-1)).toMatchObject({ name: 'nosend', sentCopyMode: 'unverified' });
  });

  it('PG-04 an account that isn\'t there any more: said so, for a password, a removal and sending', async () => {
    p = await startPage();
    await p.signIn();
    for (const [path, fields] of [['/accounts/password', { name: 'gone', password: 'x' }], ['/accounts/remove', { name: 'gone', confirm: 'gone' }], ['/accounts/sending', { name: 'gone', on: 'off' }]] as const) {
      expect((await p.act(path, fields)).html, path).toContain('That account isn&#39;t here any more.');
    }
  });

  it('PG-04 a new password for a server that can\'t be reached: its own words, nothing saved', async () => {
    p = await startPage({ state: { accounts: [{ name: 'me', email: 'down@example.invalid', provider: 'other', imap: { host: '127.0.0.1', port: 1, tls: 'none' }, smtp: { host: '127.0.0.1', port: 1, tls: 'starttls' }, sentCopyMode: 'yahoo' }], signInAddress: 'down@example.invalid' }, passwords: { me: 'old-app-password' } });
    await p.signIn();
    const before = p.saves.credentials.length;
    const page = await p.act('/accounts/password', { name: 'me', password: 'new-app-password' });
    expect(page.html).toContain('We couldn&#39;t reach Example Mail');
    expect(p.saves.credentials.length).toBe(before);
  });

  it('PG-03 a password too short to be an app password is refused before anything is checked or saved (added: found by an edge test)', async () => {
    p = await startPage();
    p.accepted['side@example.invalid'] = 'short';
    p.accepted['me@example.invalid'] = 'short';
    await p.signIn();
    const before = p.saves.credentials.length;
    expect((await p.act('/accounts/add', { email: 'side@example.invalid', password: 'short', name: 'side' })).html).toContain('App passwords are at least 8 characters');
    expect((await p.act('/accounts/password', { name: 'me', password: 'short' })).html).toContain('App passwords are at least 8 characters');
    expect(p.saves.credentials.length).toBe(before);
    // Everything still works: the mail access was never broken by it.
    expect(p.app.signin!.accountNames()).toEqual(['me', 'work']);
  });

  it('PG-06 an app that isn\'t connected any more: said so, for permissions and disconnect', async () => {
    p = await startPage();
    await p.signIn();
    expect((await p.act('/apps/permissions', { app: claude, 'me:read': 'on' })).html).toContain('That app isn&#39;t connected any more.');
    expect((await p.act('/apps/disconnect', { app: claude })).html).toContain('That app isn&#39;t connected any more.');
  });

  it('PG-01 codes: a wrong one says so; too many asked for is refused; one that can\'t be emailed says so', async () => {
    p = await startPage();
    const start = await p.get();
    const codePage = await p.post('/signin/code', { csrf: p.csrfIn(start.html) });
    expect((await p.post('/signin/verify', { csrf: p.csrfIn(codePage.html), code: 'ZZZZ-ZZZZ' })).html).toContain('That code didn&#39;t match');
    // Five an hour: the rest are refused.
    for (let i = 0; i < 4; i++) await p.post('/signin/code', { csrf: p.csrfIn(start.html) });
    const limited = await p.post('/signin/code', { csrf: p.csrfIn(start.html) });
    expect(limited.response.status).toBe(429);
    expect(limited.html).toContain('Too many codes were asked for');
    await p.close();

    p = await startPage();
    p.broken.add('me');
    p.broken.add('work');
    const again = await p.get();
    const failed = await p.post('/signin/code', { csrf: p.csrfIn(again.html) });
    expect(failed.response.status).toBe(503);
    expect(failed.html).toContain('The code couldn&#39;t be emailed');
  });

  it('PG-01 behind Cloud Run, the code limit per requester is per real visitor, not per Google front end (added)', async () => {
    p = await startPage();
    const start = await p.get();
    const ask = (from: string) => fetch(`${p!.base}/${KEY}/signin/code`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: p!.cookie(), 'X-Forwarded-For': from },
      body: new URLSearchParams({ csrf: p!.csrfIn(start.html) })
    });
    // Three an hour per requester.
    for (let i = 0; i < 3; i++) expect((await ask('198.51.100.7')).status).toBe(200);
    expect((await ask('198.51.100.7')).status).toBe(429);
    // Someone else, through the same front end, still can.
    expect((await ask('203.0.113.9')).status).toBe(200);
  });

  it('PG-01 fingerprints: none saved yet, a signature that doesn\'t match, and the scripts are served', async () => {
    p = await startPage();
    const start = await p.get();
    const options = await p.post('/signin/passkey/options', { csrf: p.csrfIn(start.html) });
    expect(options.response.status).toBe(400);
    const bad = await fetch(`${p.base}/${KEY}/signin/passkey/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: p.cookie() }, body: JSON.stringify({ csrf: p.csrfIn(start.html), response: { id: 'nope' } }) });
    expect(bad.status).toBe(403);
    // Adding one needs a signed-in session.
    const refused = await p.post('/fingerprint/options', { csrf: p.csrfIn(start.html) });
    expect(refused.response.status).toBe(403);
    const page = await p.signIn();
    const badSave = await fetch(`${p.base}/${KEY}/fingerprint/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: p.cookie() }, body: JSON.stringify({ csrf: p.csrfIn(page.html), response: { id: 'nope' } }) });
    expect(badSave.status).toBe(403);
    for (const script of ['/passkey.js', '/fingerprint.js']) {
      const served = await p.get(script);
      expect(served.response.headers.get('content-type')).toContain('javascript');
    }
  });

  it('PG-15 a feed that fails, or names no proper version, is logged and ignored', async () => {
    p = await startPage({ env: { UPDATE_FEED_URL: 'https://updates.example.invalid/latest.json' } });
    await p.get();
    expect(p.logged()).toContainEqual({ event: 'update_check_failed', error: 'Error' });
    await p.close();
    p = await startPage({ env: { UPDATE_FEED_URL: 'https://updates.example.invalid/latest.json' }, feed: { version: 'soon', security: true } });
    await p.get();
    expect(p.sent.filter(s => /available/.test(s.subject))).toEqual([]);
  });
});
