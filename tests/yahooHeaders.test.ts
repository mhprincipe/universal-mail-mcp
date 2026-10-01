import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/mail/imap.js';

// Found live (2026-10-01, twice): on Yahoo every sender showed unsubscribe
// "none" (Indeed showed one-click on Gmail), LinkedIn's link was never seen,
// and threads came back as Sent copies only, never the Inbox ones the recent-
// messages scan should find. All three asked Yahoo for a few named header
// lines (HEADER.FIELDS); 2.4.4 asked for them as written, and nothing changed.
// Reading whole messages always worked there. So the header block is read
// whole (HEADER) and the lines are picked out here. This stand-in answers as
// Yahoo was seen to: named lines, nothing; the whole block, everything.
const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
afterEach(() => vi.restoreAllMocks());

const block = [
  'Return-Path: <bounce-root@x>',
  'From: Jobs <alerts@jobs.example.com>',
  'Message-ID: <m1@x>',
  'In-Reply-To: <earlier@example.invalid>',
  'References: <root@x>',
  '\t<earlier@example.invalid>',
  'List-Unsubscribe: <mailto:leave@jobs.example.com>,',
  ' <https://jobs.example.com/unsubscribe?id=1>',
  'Subject: Jobs for you'
].join('\r\n') + '\r\n\r\n';
const asYahoo = (query: { headers?: unknown }) => query.headers === true ? Buffer.from(block) : query.headers ? Buffer.from('\r\n') : undefined;

function yahoo() {
  const gateway = new ImapGateway(config, { unreliableHeaderSearch: true });
  const row = (uid: number, query: { headers?: unknown }) => ({
    uid, flags: new Set(), envelope: { messageId: `<m${uid}@x>`, from: [{ name: 'Jobs', address: 'alerts@jobs.example.com' }] },
    headers: asYahoo(query)
  });
  const client = {
    mailbox: { path: 'INBOX', readOnly: true, exists: 1 },
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    fetchOne: vi.fn(async (uid: number, query: { headers?: unknown }) => row(uid, query)),
    fetchAll: vi.fn(async (_range: unknown, query: { headers?: unknown }) => [row(1, query)]),
    // Yahoo's header search missed new mail (ENG-21): the scan has to find it.
    search: vi.fn(async () => []),
    noop: vi.fn()
  };
  vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as never));
  return { gateway, client };
}

describe('the header block read whole', () => {
  it('UNS-12 the sender summary sees the unsubscribe link on a server that answers nothing to named header lines (Yahoo) (added: 2.4.4; fixed: 2.4.5, found live twice)', async () => {
    const [row] = await yahoo().gateway.senderStats('INBOX', 10);
    expect(row).toMatchObject({ unsubscribe: 'link' });
  });

  it('UNS-12 the unsubscribe tool reads the same headers, folded over lines', async () => {
    expect(await yahoo().gateway.fetchListHeaders('INBOX', 1)).toMatchObject({ listUnsubscribe: '<mailto:leave@jobs.example.com>, <https://jobs.example.com/unsubscribe?id=1>' });
  });

  it('UNS-12 a reply reads the References it needs to join the conversation, and only those', async () => {
    expect((await yahoo().gateway.fetchReplyHeaders('INBOX', 1)).references).toEqual(['<root@x>', '<earlier@example.invalid>']);
  });

  it('UNS-12 the thread scan finds a message by its References; an id anywhere else in the header (Return-Path, From) doesn\'t count', async () => {
    expect(await yahoo().gateway.findThreadUids('INBOX', '<root@x>')).toEqual([1]);
    expect(await yahoo().gateway.findThreadUids('INBOX', '<bounce-root@x>')).toEqual([]);
  });

  it('UNS-12 the whole block is asked for, never named lines', async () => {
    const { gateway, client } = yahoo();
    await gateway.senderStats('INBOX', 10);
    await gateway.fetchListHeaders('INBOX', 1);
    await gateway.fetchReplyHeaders('INBOX', 1);
    await gateway.findThreadUids('INBOX', '<root@x>');
    const asked = [...client.fetchAll.mock.calls.map(c => c[1]), ...client.fetchOne.mock.calls.map(c => c[1])].map(q => (q as { headers?: unknown }).headers).filter(h => h !== undefined);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(h => h === true)).toBe(true);
  });
});
