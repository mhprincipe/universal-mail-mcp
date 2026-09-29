import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startProduct, type Product } from '../testkit/src/product.js';
import { seed } from '../testkit/src/seed.js';

// Tuning the slowest tools of the owner's live runs (2026-09-28): get_thread
// ~8 s, reply 4-6 s, send 3.5-5 s, create_folder 4.5 s. On a real mail server
// (Dovecot, Yahoo's layout) through the fault proxy, which records every
// command: each test shows the wasted work gone and the answer unchanged.
describe('the slow tools, tuned', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like', { imapFault: {}, sentCopyMode: 'yahoo', serverSavesSent: true }); });
  afterAll(async () => { await p?.stop(); });

  const during = async <T>(fn: () => Promise<T>) => {
    const before = p.proxy!.lines().length;
    const value = await fn();
    return { value, lines: p.proxy!.lines().slice(before) };
  };

  it('ENG-22 a thread is still found whole, without asking a folder for every message number it holds (added: tuning)', async () => {
    // Enough mail that "every message number" is a real answer.
    await seed(p.server, { messages: Array.from({ length: 30 }, (_, i) => ({ mailbox: 'INBOX', subject: `filler ${i}` })) });
    const [root] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Plan', messageId: '<plan@example.invalid>' }] })).messages;
    await seed(p.server, { messages: [{ mailbox: 'Sent', subject: 'Re: Plan', headers: { 'In-Reply-To': '<plan@example.invalid>', References: '<plan@example.invalid>' } }] });
    const { value, lines } = await during(() => p.ok('get_thread', { mailbox: 'INBOX', uid: root!.uid }));
    expect(value.map((m: { subject: string }) => m.subject).sort()).toEqual(['Plan', 'Re: Plan']);
    expect(lines.filter(l => /SEARCH ALL/i.test(l))).toEqual([]);
  });

  it('ENG-22 the Message-ID fallback (Yahoo\'s header search missing) also reads only the newest messages', async () => {
    const [m] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'find me' }] })).messages;
    p.proxy!.setRules({ blankHeaderSearch: true });
    try {
      const { value, lines } = await during(() => p.ok('search_email', { mailbox: 'INBOX', messageId: m!.messageId }));
      expect(value.map((r: { uid: number }) => r.uid)).toEqual([m!.uid]);
      expect(lines.filter(l => /SEARCH ALL\s*$/i.test(l))).toEqual([]);
    } finally { p.proxy!.setRules({}); }
  });

  it('ENG-23 creating a folder that already exists asks nothing to be created and keeps the connection (added: tuning)', async () => {
    await p.ok('create_folder', { path: 'Existing' });
    await p.ok('list_folders');
    const { value, lines } = await during(() => p.ok('create_folder', { path: 'Existing' }));
    expect(value).toEqual({ path: 'Existing', created: false });
    expect(lines.filter(l => /^(CREATE|LOGIN|AUTHENTICATE)\b/i.test(l))).toEqual([]);
    // A new one is still created.
    expect(await p.ok('create_folder', { path: 'Brand new' })).toMatchObject({ created: true });
  });

  it('ENG-24 where the provider files its own Sent copy, sending doesn\'t go looking for it (it appears a minute later), and says so (added: tuning)', async () => {
    const { value, lines } = await during(() => p.call('send_email', { to: ['friend@example.invalid'], subject: 'hello', text: 'hi' }));
    expect(value.result.ok).toBe(true);
    expect(lines.filter(l => /SEARCH|EXAMINE|SELECT|APPEND/i.test(l))).toEqual([]);
    expect(value.result.warnings.join(' ')).toMatch(/files its own Sent copy.*minute.*do not resend/i);
  });

  it('ENG-25 mail that arrives while a folder is open on the kept connection can be read and replied to at once (added: tuning)', async () => {
    // The kept connection has INBOX open; a new message arrives through
    // another connection, and its UID is used before anything refreshes the
    // folder (the 30-second check hasn't come round).
    await p.ok('search_email', { mailbox: 'INBOX', limit: 1 });
    const [fresh] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Just arrived', from: 'friend@example.invalid' }] })).messages;
    expect((await p.ok('get_email', { mailbox: 'INBOX', uid: fresh!.uid })).subject).toBe('Just arrived');
    const [another] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Also just arrived', from: 'friend@example.invalid' }] })).messages;
    expect((await p.ok('reply_email', { mailbox: 'INBOX', uid: another!.uid, text: 'got it' })).messageId).toBeTruthy();
  });

  it('ENG-24 a reply reads only the original\'s headers, not the whole message, and threads exactly as before', async () => {
    const [original] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Question', messageId: '<q@example.invalid>', from: 'friend@example.invalid', headers: { References: '<earlier@example.invalid>' }, body: 'x'.repeat(50_000) }] })).messages;
    const { value, lines } = await during(() => p.ok('reply_email', { mailbox: 'INBOX', uid: original!.uid, text: 'answer' }));
    expect(value.messageId).toBeTruthy();
    expect(lines.filter(l => /BODY(\.PEEK)?\[\]/i.test(l))).toEqual([]);
    const sent = p.smtp.messages.at(-1)!;
    expect(sent.to).toEqual(['friend@example.invalid']);
    const raw = sent.raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
    expect(raw).toMatch(/^Subject: Re: Question$/m);
    expect(raw).toMatch(/^In-Reply-To: <q@example\.invalid>$/m);
    expect(raw).toMatch(/^References: <earlier@example\.invalid> <q@example\.invalid>$/m);
  });
  it('DIA-13 on a real server: a read shows its mail commands and parsing (no new login on the kept connection); a send shows SMTP (added: the fourth live run)', async () => {
    const log = vi.spyOn(console, 'log');
    try {
      const [m] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Timed' }] })).messages;
      await p.ok('get_email', { mailbox: 'INBOX', uid: m!.uid });
      await p.ok('get_email', { mailbox: 'INBOX', uid: m!.uid });
      await p.call('send_email', { to: ['friend@example.invalid'], subject: 'timed', text: 'hi' });
      const lines = log.mock.calls.map(([l]) => { try { return JSON.parse(String(l)); } catch { return {}; } }).filter(e => e.event === 'tool');
      const read = lines.filter(e => e.name === 'get_email').at(-1);
      expect(read.phases['imap.fetchOne'].n).toBeGreaterThanOrEqual(1);
      expect(read.phases.parse.n).toBe(1);
      expect(read.phases['imap.connect']).toBeUndefined();
      expect(lines.find(e => e.name === 'send_email').phases['smtp.send'].n).toBe(1);
    } finally { log.mockRestore(); }
  });
  it('ENG-27 on a real server: a read right after a change in the same folder opens nothing again, and still marks nothing read (added: measured live)', async () => {
    const [m] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Reused folder' }] })).messages;
    // Read, then unread: both change it, so the folder is open for changes.
    await p.ok('mark_read', { mailbox: 'INBOX', uid: m!.uid });
    await p.ok('mark_unread', { mailbox: 'INBOX', uid: m!.uid });
    const { value, lines } = await during(() => p.ok('get_email', { mailbox: 'INBOX', uid: m!.uid }));
    expect(value.subject).toBe('Reused folder');
    expect(lines.filter(l => /^(SELECT|EXAMINE)\b/i.test(l))).toEqual([]);
    const [found] = await p.ok('search_email', { mailbox: 'INBOX', messageId: m!.messageId });
    expect(found.read).toBe(false);
  });
});
