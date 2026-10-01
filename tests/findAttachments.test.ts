import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/mail/imap.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// Finding mail (added 2.4.2, found live): a search for "pdf" found nothing,
// because a server's text search doesn't look at attachment names, so the AI
// couldn't find the email to send a file from. Results now name their
// attachments, and a search can ask for only those with attachments, or by an
// attachment's name. And a search the server matches loosely (Yahoo's subject
// search) no longer reads its candidates five at a time: 20 round trips and
// 8.6 s, seen in the live log.
const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
afterEach(() => vi.restoreAllMocks());

type Part = { type: string; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; id?: string; childNodes?: Part[] };
const pdf = (filename: string): Part => ({ type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename } });
const plain: Part = { type: 'text/plain' };
const withParts = (...parts: Part[]): Part => ({ type: 'multipart/mixed', childNodes: [plain, ...parts] });

// A folder of `count` messages (uid 1 oldest); `structure(uid)` says what each holds.
function gatewayOver(count: number, structure: (uid: number) => Part, subject: (uid: number) => string = uid => `Message ${uid}`) {
  const gateway = new ImapGateway(config);
  const fetches: number[][] = [];
  const client = {
    mailbox: { path: 'INBOX', readOnly: true, exists: count },
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    // Honours the paging range (UID 1:n) as a server does; matches everything else.
    search: vi.fn(async (query: { uid?: string }) => Array.from({ length: count }, (_, i) => i + 1).filter(uid => !query.uid || uid <= Number(query.uid.split(':')[1]))),
    fetchAll: vi.fn(async (uids: number[] | string) => {
      const list = Array.isArray(uids) ? uids : String(uids).split(',').map(Number);
      fetches.push(list);
      return list.map(uid => ({ uid, flags: new Set(), size: 10, bodyStructure: structure(uid), envelope: { messageId: `<m${uid}@x>`, subject: subject(uid), from: [{ address: 'a@example.org' }] } }));
    })
  };
  vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as never));
  return { gateway, fetches };
}

describe('attachments in search results', () => {
  it('FND-01 each result names its attachments; inline pictures with a content id (newsletter images) are not attachments; none: no field', async () => {
    const { gateway } = gatewayOver(3, uid => uid === 3 ? withParts(pdf('invoice.pdf'), { type: 'image/png', disposition: 'inline', parameters: { name: 'logo.png' }, id: '<logo>' })
      : uid === 2 ? { type: 'multipart/mixed', childNodes: [{ type: 'multipart/alternative', childNodes: [plain, { type: 'text/html' }] }, { type: 'image/jpeg', parameters: { name: 'photo.jpg' } }, { type: 'application/octet-stream', disposition: 'attachment' }] }
      : plain);
    const { messages } = await gateway.searchPage({ mailbox: 'INBOX', limit: 10 });
    expect(messages.map(m => [m.uid, m.attachmentNames])).toEqual([[3, ['invoice.pdf']], [2, ['photo.jpg', '(unnamed application/octet-stream)']], [1, undefined]]);
  });

  it('FND-02 only messages with attachments, or with one whose name contains the words asked (any case); a page is still filled, and paging never skips or repeats', async () => {
    // Every fifth has one: a page fills partway through what it read, and the
    // next page starts right after the last one shown, not after all it read.
    const { gateway } = gatewayOver(200, uid => uid % 5 === 0 ? withParts(pdf(`Statement-${uid}.PDF`)) : plain);
    const first = await gateway.searchPage({ mailbox: 'INBOX', limit: 5, hasAttachments: true });
    expect(first.messages.map(m => m.uid)).toEqual([200, 195, 190, 185, 180]);
    const second = await gateway.searchPage({ mailbox: 'INBOX', limit: 5, hasAttachments: true, beforeUid: first.next });
    expect(second.messages.map(m => m.uid)).toEqual([175, 170, 165, 160, 155]);
    const named = await gateway.searchPage({ mailbox: 'INBOX', limit: 3, attachmentName: 'statement-1' });
    expect(named.messages.map(m => m.uid)).toEqual([195, 190, 185]);
    const without = await gateway.searchPage({ mailbox: 'INBOX', limit: 3, hasAttachments: false });
    expect(without.messages.map(m => m.uid)).toEqual([199, 198, 197]);
  });

  it('FND-03 a search checked here after the server\'s own reads 50 at a time, not a few; a plain search reads only what it shows', async () => {
    const loose = gatewayOver(200, () => plain, uid => uid <= 3 ? 'Universal Mail 2.4.1 files' : 'Universal Mail other');
    const found = await loose.gateway.searchPage({ mailbox: 'INBOX', limit: 5, subject: 'Universal Mail 2.4.1 files' });
    expect(found.messages.map(m => m.uid)).toEqual([3, 2, 1]);
    expect(loose.fetches.length).toBeLessThanOrEqual(4);
    expect(Math.max(...loose.fetches.map(f => f.length))).toBe(50);
    const plainSearch = gatewayOver(200, () => plain);
    await plainSearch.gateway.searchPage({ mailbox: 'INBOX', limit: 5 });
    expect(plainSearch.fetches).toEqual([[196, 197, 198, 199, 200]]);
  });

  it('FND-03 a big folder with few matches: looks at 1,000 at most, then answers with what it found, a cursor to go on, and says so', async () => {
    const { gateway, fetches } = gatewayOver(5000, uid => uid === 10 ? withParts(pdf('old.pdf')) : plain);
    const page = await gateway.searchPage({ mailbox: 'INBOX', limit: 5, hasAttachments: true });
    expect(page.messages).toEqual([]);
    expect(page.next).toBe(4001);
    expect(page.warning).toMatch(/1,000/);
    expect(fetches.flat()).toHaveLength(1000);
    const later = await gateway.searchPage({ mailbox: 'INBOX', limit: 5, hasAttachments: true, beforeUid: 11 });
    expect(later.messages.map(m => m.uid)).toEqual([10]);
  });
});

describe('the search tool', () => {
  let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
  afterEach(async () => { await f?.stop(); f = undefined; });

  it('FND-04 takes hasAttachments and attachmentName, says results name their attachments, and passes a warning on', async () => {
    f = await startToolFixture();
    const search = (await f.tools()).find(t => t.name === 'search_email')!;
    const properties = (search.inputSchema as any).properties;
    expect(properties.hasAttachments.type).toBe('boolean');
    expect(properties.attachmentName.type).toBe('string');
    expect(search.description).toMatch(/attachmentNames/);
    vi.mocked(ImapGateway.prototype.searchPage).mockResolvedValueOnce({ messages: [], next: 4001, warning: 'Looked at the newest 1,000 messages.' });
    const answer = await f.call('search_email', { mailbox: 'INBOX', hasAttachments: true });
    expect(answer.result).toMatchObject({ ok: true, cursor: '4001', warnings: ['Looked at the newest 1,000 messages.'] });
  });
});

describe('text search on Gmail', () => {
  function gmail(capabilities: string[]) {
    const gateway = new ImapGateway(config);
    const asked: any[] = [];
    const client = {
      capabilities: new Set(capabilities),
      mailbox: { path: 'INBOX', readOnly: true, exists: 0 },
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      search: vi.fn(async (query: unknown) => { asked.push(query); return []; }),
      fetchAll: vi.fn(async () => [])
    };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as never));
    return { gateway, asked };
  }

  it('FND-06 asks Gmail for the exact phrase with its own search, which honours quotes; its word search matched unrelated mail (added: 2.4.3, found live)', async () => {
    const { gateway, asked } = gmail(['IMAP4rev1', 'X-GM-EXT-1']);
    await gateway.searchPage({ mailbox: 'INBOX', limit: 5, text: 'Universal Mail "Gmail" test', from: 'me@example.org' });
    expect(asked[0]).toMatchObject({ gmraw: '"Universal Mail Gmail test"', from: 'me@example.org' });
    expect(asked[0].or).toBeUndefined();
  });

  it('FND-06 every other server keeps the standard search: sender, recipients, subject or body', async () => {
    const { gateway, asked } = gmail(['IMAP4rev1']);
    await gateway.searchPage({ mailbox: 'INBOX', limit: 5, text: 'invoice' });
    expect(asked[0]).toMatchObject({ or: [{ from: 'invoice' }, { to: 'invoice' }, { subject: 'invoice' }, { body: 'invoice' }] });
    expect(asked[0].gmraw).toBeUndefined();
  });
});

describe('what counts as an attachment', () => {
  let g: Awaited<ReturnType<typeof startToolFixture>> | undefined;
  afterEach(async () => { await g?.stop(); g = undefined; });

  it('FND-07 a search for attachments says that pictures shown in an email\'s text aren\'t counted; other searches don\'t (added: 2.4.4, found live)', async () => {
    g = await startToolFixture();
    expect((await g.call('search_email', { mailbox: 'INBOX', hasAttachments: true })).result.message).toMatch(/Pictures shown inside an email's text aren't counted/);
    expect((await g.call('search_email', { mailbox: 'INBOX', attachmentName: 'pdf' })).result.message).toMatch(/Pictures shown/);
    expect((await g.call('search_email', { mailbox: 'INBOX' })).result.message).not.toMatch(/Pictures/);
  });
});
