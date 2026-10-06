import { describe, expect, it } from 'vitest';
import { ImapGateway } from '../src/mail/imap.js';

// FND-08 (added: 2.4.6, found live 2026-10-06): Yahoo's own search left out
// mail moved into a folder. In Trash, every search for a sender found 4 of
// its 16 messages: the 12 just moved there weren't found, even by their full
// address. Here, a stand-in for that server: its search knows only some of
// the folder, and the newest messages are checked directly as well.
type Row = { uid: number; from: string; name?: string; to?: string; subject?: string; seen?: boolean };

function server(rows: Row[], indexed: number[], options: { gmail?: boolean; reliable?: boolean } = {}) {
  const calls = { ranges: [] as string[], searches: 0 };
  const envelope = (r: Row) => ({
    messageId: `<m${r.uid}@example.invalid>`, subject: r.subject ?? 'news', date: new Date(Date.UTC(2026, 9, 1, 0, r.uid)),
    from: [{ name: r.name, address: r.from }], to: [{ address: r.to ?? 'owner@example.invalid' }]
  });
  const row = (r: Row) => ({ uid: r.uid, envelope: envelope(r), flags: new Set<string>(r.seen ? ['\\Seen'] : []), size: 10 });
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>(options.gmail ? [['X-GM-EXT-1', true]] : []),
    mailbox: { path: 'Trash', exists: rows.length, readOnly: true },
    connect: async () => undefined, logout: async () => undefined, close: () => undefined, noop: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    // The server's search: only what it indexed, by sender address or name.
    search: async (query: { from?: string; subject?: string; seen?: boolean }) => {
      calls.searches++;
      return rows.filter(r => indexed.includes(r.uid))
        .filter(r => !query.from || `${r.name ?? ''} ${r.from}`.toLowerCase().includes(query.from.toLowerCase()))
        .filter(r => !query.subject || (r.subject ?? 'news').toLowerCase().includes(query.subject.toLowerCase()))
        .filter(r => query.seen === undefined || Boolean(r.seen) === query.seen)
        .map(r => r.uid);
    },
    // By UID (a page) or by position ("first:*", the newest).
    fetchAll: async (wanted: number[] | string) => {
      if (typeof wanted === 'string') {
        calls.ranges.push(wanted);
        const first = Number(wanted.split(':')[0]);
        return rows.slice(first - 1).map(row);
      }
      return rows.filter(r => wanted.includes(r.uid)).map(row);
    }
  };
  const gateway = new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never, unreliableHeaderSearch: !options.reliable });
  return { gateway, calls };
}

const nexxt = (uid: number, extra: Partial<Row> = {}): Row => ({ uid, from: 'alert@email.example-jobs.test', name: 'Job Alerts', ...extra });
const other = (uid: number): Row => ({ uid, from: `news${uid}@shop.example`, name: 'Shop' });
const uids = (r: { messages: Array<{ uid: number }> }) => r.messages.map(m => m.uid);

describe('finding mail the server\'s search left out', () => {
  it('FND-08 a sender search also checks the newest messages directly: mail just moved in is found (added: 2.4.6, found live)', async () => {
    // 1-3 indexed long ago; 8-10 moved in, never indexed.
    const rows = [nexxt(1), other(2), nexxt(3), other(4), other(5), other(6), other(7), nexxt(8), nexxt(9), nexxt(10)];
    const { gateway } = server(rows, [1, 2, 3, 4, 5, 6, 7]);
    const page = await gateway.searchPage({ mailbox: 'Trash', from: 'example-jobs', limit: 25 });
    expect(uids(page)).toEqual([10, 9, 8, 3, 1]);
  });

  it('FND-08 the direct check matches part of a name or address in any case, and subject and read state still apply', async () => {
    const rows = [nexxt(1), nexxt(2, { subject: 'Weekly roles', seen: true }), nexxt(3, { subject: 'weekly ROLES' }), other(4)];
    const { gateway } = server(rows, []);
    expect(uids(await gateway.searchPage({ mailbox: 'Trash', from: 'JOB ALERTS', limit: 25 }))).toEqual([3, 2, 1]);
    expect(uids(await gateway.searchPage({ mailbox: 'Trash', from: 'jobs.test', subject: 'weekly roles', limit: 25 }))).toEqual([3, 2]);
    expect(uids(await gateway.searchPage({ mailbox: 'Trash', from: 'jobs', read: false, limit: 25 }))).toEqual([3, 1]);
  });

  it('FND-08 only the newest 100 are checked, in one read by position, and only on the first page', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? nexxt(i + 1) : other(i + 1)));
    const { gateway, calls } = server(rows, []);
    const first = await gateway.searchPage({ mailbox: 'Trash', from: 'example-jobs', limit: 100 });
    expect(calls.ranges).toEqual(['201:*']);
    expect(first.messages.every(m => m.uid > 200)).toBe(true);
    await gateway.searchPage({ mailbox: 'Trash', from: 'example-jobs', limit: 10, beforeUid: 150 });
    expect(calls.ranges).toEqual(['201:*']);
  });

  it('FND-08 no direct check when the server found a full page, for a text or Message-ID search, on Gmail, or where search is reliable', async () => {
    const rows = [nexxt(1), nexxt(2), nexxt(3)];
    const full = server(rows, [1, 2, 3]);
    await full.gateway.searchPage({ mailbox: 'Trash', from: 'jobs', limit: 2 });
    expect(full.calls.ranges).toEqual([]);
    const text = server(rows, []);
    await text.gateway.searchPage({ mailbox: 'Trash', text: 'jobs', limit: 25 });
    expect(text.calls.ranges).toEqual([]);
    // A Message-ID search has its own check (ENG-21): 200 newest, not this one's 100.
    const many = server(Array.from({ length: 300 }, (_, i) => nexxt(i + 1)), []);
    await many.gateway.searchPage({ mailbox: 'Trash', messageId: '<m1@example.invalid>', limit: 25 });
    expect(many.calls.ranges).toEqual(['101:*']);
    // Turned off by the caller (a search over every folder, FND-10).
    const off = server(rows, []);
    await off.gateway.searchPage({ mailbox: 'Trash', from: 'jobs', limit: 25, directCheck: false });
    expect(off.calls.ranges).toEqual([]);
    const gmail = server(rows, [], { gmail: true });
    expect(uids(await gmail.gateway.searchPage({ mailbox: 'Trash', from: 'jobs', limit: 25 }))).toEqual([]);
    expect(gmail.calls.ranges).toEqual([]);
    const reliable = server(rows, [], { reliable: true });
    await reliable.gateway.searchPage({ mailbox: 'Trash', from: 'jobs', limit: 25 });
    expect(reliable.calls.ranges).toEqual([]);
  });

  it('FND-08 the answer says the newest were checked directly when that found mail the search had missed', async () => {
    const { gateway } = server([nexxt(1), nexxt(2)], [1]);
    const page = await gateway.searchPage({ mailbox: 'Trash', from: 'jobs', limit: 25 });
    expect(page.note).toMatch(/search left out 1 .*found by checking the newest/i);
    const quiet = server([nexxt(1), nexxt(2)], [1, 2]);
    expect((await quiet.gateway.searchPage({ mailbox: 'Trash', from: 'jobs', limit: 25 })).note).toBeUndefined();
  });
});

describe('the search answer', () => {
  it('FND-08 says so when the direct check found mail the server\'s search left out', async () => {
    const { MailService } = await import('../src/mail/mailService.js');
    const { loadConfig } = await import('../src/config.js');
    const service = new MailService(loadConfig({ YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' }));
    const { vi } = await import('vitest');
    vi.spyOn(service.imap, 'searchPage').mockResolvedValue({ messages: [], note: 'The mail server\'s own search left out 2 of these.' });
    expect((await service.searchEmail({ mailbox: 'Trash', from: 'jobs', limit: 25 })).message).toBe('Success. The mail server\'s own search left out 2 of these.');
  });
});
