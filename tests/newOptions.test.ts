import { afterEach, describe, expect, it, vi } from 'vitest';
import { simpleParser } from 'mailparser';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/mail/imap.js';
import { MailService } from '../src/mail/mailService.js';
import { activityFor } from '../src/activity.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// 2.4.6, the owner's choice: three options on tools that already exist.
// - matching: act on everything a search finds, without listing uids (BLK)
// - allFolders on search_email: one search over every folder (FND-10)
// - counts on list_folders: how many messages and how many unread (FOL)
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; vi.restoreAllMocks(); });

// The fixture's search ignores filters; here it checks subject and read state,
// newest first, at most limit, with a cursor when more matched.
function filteringSearch(fixture: NonNullable<typeof f>) {
  vi.spyOn(ImapGateway.prototype, 'searchPage').mockImplementation(async input => {
    const all = [];
    for (const row of [...fixture.rows.values()].filter(r => r.mailbox === input.mailbox).sort((a, b) => b.uid - a.uid)) {
      const subject = (await simpleParser(row.raw)).subject ?? '';
      if (input.subject && !subject.toLowerCase().includes(input.subject.toLowerCase())) continue;
      if (input.read !== undefined && row.read !== input.read) continue;
      all.push({ mailbox: row.mailbox, uid: row.uid, messageId: row.messageId, subject, from: [], to: [], read: row.read, flagged: row.flagged, untrustedContent: true as const });
    }
    const messages = all.slice(0, input.limit);
    return { messages, ...(all.length > input.limit ? { next: messages.at(-1)!.uid } : {}) };
  });
}

describe('acting on everything a search finds', () => {
  it('BLK-01 matching acts on the messages that match, and the answer says how many matched (added: 2.4.6)', async () => {
    f = await startToolFixture();
    filteringSearch(f);
    await f.seed('INBOX', { subject: 'Job alert: one' });
    await f.seed('INBOX', { subject: 'Lunch on Friday' });
    await f.seed('INBOX', { subject: 'job ALERT: two' });
    const r = await f.call('trash_email', { mailbox: 'INBOX', matching: { subject: 'job alert' } });
    expect(r.result).toMatchObject({ ok: true, matched: { count: 2, more: false } });
    expect(r.result.message).toMatch(/2 messages matched/);
    const left = [...f.rows.values()].filter(row => row.mailbox === 'INBOX');
    expect(left).toHaveLength(1);
    expect([...f.rows.values()].filter(row => row.mailbox === 'Trash')).toHaveLength(2);
  });

  it('BLK-01 every tool that takes uids takes matching: move, archive, read, unread, flag, trash, junk, restore', async () => {
    f = await startToolFixture();
    const tools = await f.tools();
    for (const name of ['move_email', 'archive_email', 'mark_read', 'mark_unread', 'flag_email', 'trash_email', 'junk_email', 'restore_email']) {
      const schema = tools.find(t => t.name === name)!.inputSchema as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties), name).toContain('matching');
    }
  });

  it('BLK-02 more than 100 match: the newest 100 are acted on and the answer says to call again', async () => {
    f = await startToolFixture();
    filteringSearch(f);
    for (let i = 0; i < 103; i++) await f.seed('INBOX', { subject: `Digest ${i}` });
    const r = await f.call('trash_email', { mailbox: 'INBOX', matching: { subject: 'digest' } });
    expect(r.result).toMatchObject({ ok: true, matched: { count: 100, more: true } });
    expect(r.result.message).toMatch(/More match: call again/);
    // The oldest three are still there.
    expect([...f.rows.values()].filter(row => row.mailbox === 'INBOX')).toHaveLength(3);
  });

  it('BLK-03 matching with nothing to match on is refused, and nothing changes', async () => {
    f = await startToolFixture();
    filteringSearch(f);
    await f.seed('INBOX', { subject: 'Keep me' });
    const r = await f.call('trash_email', { mailbox: 'INBOX', matching: {} });
    expect(r.result).toMatchObject({ ok: false, code: 'MAIL-MATCHING-EMPTY' });
    expect([...f.rows.values()].filter(row => row.mailbox === 'INBOX')).toHaveLength(1);
  });

  it('BLK-03 exactly one of uid, uids or matching', async () => {
    f = await startToolFixture();
    const a = await f.seed('INBOX', { subject: 'One' });
    const both = await f.call('archive_email', { mailbox: 'INBOX', uid: a.uid, matching: { subject: 'One' } });
    expect(both.isError).toBe(true);
    const none = await f.call('archive_email', { mailbox: 'INBOX' });
    expect(none.isError).toBe(true);
  });

  it('BLK-04 nothing matched: a plain answer, nothing changed, nothing for the activity log', async () => {
    f = await startToolFixture();
    filteringSearch(f);
    await f.seed('INBOX', { subject: 'Lunch' });
    const r = await f.call('archive_email', { mailbox: 'INBOX', matching: { subject: 'invoice' } });
    expect(r.result).toMatchObject({ ok: true, code: 'NOTHING_MATCHED', matched: { count: 0, more: false } });
    expect(activityFor('archive_email', { mailbox: 'INBOX', matching: { subject: 'invoice' } }, r.result)).toBeUndefined();
  });

  it('BLK-04 the activity log counts what matching acted on, with undo', async () => {
    f = await startToolFixture();
    filteringSearch(f);
    await f.seed('INBOX', { subject: 'Promo 1' });
    await f.seed('INBOX', { subject: 'Promo 2' });
    const args: Record<string, unknown> = { mailbox: 'INBOX', matching: { subject: 'promo' } };
    const r = await f.call('archive_email', args);
    const resolved = { ...args, uids: r.result.matched.uids };
    expect(activityFor('archive_email', resolved, r.result)).toMatchObject({ action: expect.any(String), count: 2, undo: { kind: 'move' } });
  });
});

describe('one search over every folder', () => {
  it('FND-10 allFolders searches every folder but Trash and Junk, newest first, naming each one\'s folder (added: 2.4.6)', async () => {
    f = await startToolFixture();
    await f.seed('INBOX', { subject: 'A' });
    await f.seed('Archive', { subject: 'B' });
    await f.seed('Trash', { subject: 'C' });
    await f.seed('Sent', { subject: 'D' });
    const r = await f.call('search_email', { allFolders: true, limit: 10 });
    expect(r.result.ok).toBe(true);
    expect(r.result.data.map((m: { mailbox: string }) => m.mailbox)).toEqual(['Sent', 'Archive', 'INBOX']);
    expect(r.result.message).toMatch(/Searched 4 folders/);
  });

  it('FND-10 on Gmail, All Mail is searched once instead of every label', async () => {
    const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
    const s = new MailService(config);
    vi.spyOn(s.imap, 'listFolders').mockResolvedValue([
      { path: 'INBOX', specialUse: '\\Inbox', selectable: true }, { path: '[Gmail]/All Mail', specialUse: '\\All', selectable: true },
      { path: 'Work', selectable: true }, { path: '[Gmail]/Trash', specialUse: '\\Trash', selectable: true }
    ]);
    const search = vi.spyOn(s.imap, 'searchPage').mockResolvedValue({ messages: [] });
    await s.searchEverywhere({ from: 'someone', limit: 10 });
    expect(search.mock.calls.map(([input]) => input.mailbox)).toEqual(['[Gmail]/All Mail']);
  });

  it('FND-10 the usual folders first; it stops after 45 s and says how many folders it left', async () => {
    const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
    const clock = { t: 0 };
    const s = new MailService(config, { clock: { now: () => clock.t } });
    vi.spyOn(s.imap, 'listFolders').mockResolvedValue([
      ...Array.from({ length: 20 }, (_, i) => ({ path: `F${i}`, selectable: true })),
      { path: 'INBOX', specialUse: '\\Inbox', selectable: true }, { path: 'Sent', specialUse: '\\Sent', selectable: true }
    ]);
    const search = vi.spyOn(s.imap, 'searchPage').mockImplementation(async () => { clock.t += 5_000; return { messages: [] }; });
    const r = await s.searchEverywhere({ from: 'someone', limit: 10 });
    const order = search.mock.calls.map(([input]) => input.mailbox);
    expect(order.slice(0, 2)).toEqual(['INBOX', 'Sent']);
    expect(order).toHaveLength(10);
    expect(r.warnings).toContain('Searched 10 of 22 folders before the time limit; 12 weren\'t searched. Search those folders one at a time to look further.');
  });

  it('FND-10 lists the folders afresh, so one made a moment ago is searched (found on the real server)', async () => {
    const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
    const s = new MailService(config);
    const list = vi.spyOn(s.imap, 'listFolders').mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox', selectable: true }]);
    vi.spyOn(s.imap, 'searchPage').mockResolvedValue({ messages: [] });
    await s.searchEverywhere({ from: 'someone', limit: 10 });
    expect(list).toHaveBeenCalledWith({ fresh: true });
  });

  it('FND-10 the direct check of the newest messages runs only in the usual folders', async () => {
    const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
    const s = new MailService(config);
    vi.spyOn(s.imap, 'listFolders').mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox', selectable: true }, { path: 'Work', selectable: true }]);
    const search = vi.spyOn(s.imap, 'searchPage').mockResolvedValue({ messages: [] });
    await s.searchEverywhere({ from: 'someone', limit: 10 });
    expect(Object.fromEntries(search.mock.calls.map(([input]) => [input.mailbox, input.directCheck]))).toEqual({ INBOX: true, Work: false });
  });
});

describe('folder counts', () => {
  function countingClient() {
    const statuses: string[] = [];
    const client = {
      usable: true, connect: async () => undefined, logout: async () => undefined, close: () => undefined, noop: async () => undefined,
      list: async () => [
        { path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>(), delimiter: '/' },
        { path: '[Gmail]', specialUse: '', flags: new Set<string>(['\\Noselect']), delimiter: '/' },
        { path: 'Work', specialUse: '', flags: new Set<string>(), delimiter: '/' }
      ],
      status: async (path: string) => { statuses.push(path); return path === 'INBOX' ? { messages: 1200, unseen: 37 } : { messages: 15, unseen: 0 }; }
    };
    return { client, statuses };
  }

  it('FOL-01 counts: each folder\'s messages and unread, asked of the server folder by folder; a folder that holds no mail is skipped (added: 2.4.6)', async () => {
    const { client, statuses } = countingClient();
    const gateway = new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never });
    const folders = await gateway.listFolders({ counts: true });
    expect(folders.find(x => x.path === 'INBOX')).toMatchObject({ messages: 1200, unread: 37 });
    expect(folders.find(x => x.path === 'Work')).toMatchObject({ messages: 15, unread: 0 });
    expect(folders.find(x => x.path === '[Gmail]')).not.toHaveProperty('messages');
    expect(statuses).toEqual(['INBOX', 'Work']);
  });

  it('FOL-01 counts list the folders afresh: one made since the last list is counted (found on the real server)', async () => {
    const { client } = countingClient();
    const gateway = new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never });
    await gateway.listFolders();
    const list = client.list;
    client.list = async () => [...await list(), { path: 'New', specialUse: '', flags: new Set<string>(), delimiter: '/' }];
    expect((await gateway.listFolders({ counts: true })).map(x => x.path)).toContain('New');
  });

  it('FOL-01 without counts, list_folders asks for none (as before)', async () => {
    const { client, statuses } = countingClient();
    const gateway = new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never });
    const folders = await gateway.listFolders();
    expect(folders[0]).not.toHaveProperty('messages');
    expect(statuses).toEqual([]);
  });

  it('FOL-01 the list_folders tool takes counts, and passes it on', async () => {
    f = await startToolFixture();
    const schema = (await f.tools()).find(t => t.name === 'list_folders')!.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain('counts');
    const list = vi.mocked(ImapGateway.prototype.listFolders);
    list.mockClear();
    await f.call('list_folders', { counts: true });
    expect(list).toHaveBeenCalledWith({ counts: true });
  });
});
