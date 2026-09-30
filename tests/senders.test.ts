import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/mail/imap.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// Who fills my inbox (added 2.4.1): the newest messages in one folder,
// counted by sender, in one call, so an AI can plan a clean-up without
// opening hundreds of messages. Read-only; names are the senders' own words.
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; vi.restoreAllMocks(); });

function from(sender: string, date: string, headers: string[] = []) {
  return Buffer.from([`From: ${sender}`, 'To: self@example.invalid', 'Subject: Hello', `Date: ${date}`,
    `Message-ID: <w-${Math.random().toString(36).slice(2)}@example.invalid>`, ...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain', '', 'Hi'].join('\r\n'));
}
const ONE_CLICK = ['List-Unsubscribe: <https://shop.example.com/u?id=1>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'];

describe('who fills a folder', () => {
  it('WHO-01 senders by how many messages, with unread counts, their newest date and whether one click unsubscribes', async () => {
    f = await startToolFixture();
    const news = [
      await f.seedRaw('INBOX', from('Daily News <news@news.example.com>', 'Mon, 28 Sep 2026 08:00:00 +0000')),
      await f.seedRaw('INBOX', from('news@news.example.com', 'Tue, 29 Sep 2026 08:00:00 +0000')),
      await f.seedRaw('INBOX', from('NEWS@news.example.com', 'Wed, 30 Sep 2026 08:00:00 +0000'))
    ];
    f.rows.get(news[0]!.uid)!.read = true;
    await f.seedRaw('INBOX', from('Shop <deals@shop.example.com>', 'Tue, 29 Sep 2026 09:00:00 +0000', ONE_CLICK));
    await f.seedRaw('INBOX', from('Shop <deals@shop.example.com>', 'Wed, 30 Sep 2026 09:00:00 +0000'));
    await f.seedRaw('INBOX', from('Sam <sam@example.org>', 'Wed, 30 Sep 2026 10:00:00 +0000'));
    await f.seedRaw('Archive', from('Elsewhere <x@elsewhere.example>', 'Wed, 30 Sep 2026 10:00:00 +0000'));

    const answer = await f.call('summarize_senders', { mailbox: 'INBOX' });
    expect(answer.result).toMatchObject({ ok: true, data: { mailbox: 'INBOX', looked: 6, untrustedContent: true } });
    expect(answer.result.data.senders).toEqual([
      { address: 'news@news.example.com', name: 'Daily News', messages: 3, unread: 2, newest: '2026-09-30T08:00:00.000Z', unsubscribe: 'none' },
      { address: 'deals@shop.example.com', name: 'Shop', messages: 2, unread: 2, newest: '2026-09-30T09:00:00.000Z', unsubscribe: 'one-click' },
      { address: 'sam@example.org', name: 'Sam', messages: 1, unread: 1, newest: '2026-09-30T10:00:00.000Z', unsubscribe: 'none' }
    ]);
    const top = await f.call('summarize_senders', { mailbox: 'INBOX', top: 2 });
    expect(top.result.data.senders.map((s: { address: string }) => s.address)).toEqual(['news@news.example.com', 'deals@shop.example.com']);
    // Most first, whenever their mail came.
    for (let i = 0; i < 4; i++) await f.seedRaw('INBOX', from('late@late.example', 'Wed, 30 Sep 2026 11:00:00 +0000'));
    const ranked = await f.call('summarize_senders', { mailbox: 'INBOX', top: 2 });
    expect(ranked.result.data.senders.map((s: { address: string }) => s.address)).toEqual(['late@late.example', 'news@news.example.com']);
  });

  it('WHO-02 a sender that looks like a scam carries its cautions', async () => {
    f = await startToolFixture();
    await f.seedRaw('INBOX', from('PayPal <service@paypa1-secure.example>', 'Wed, 30 Sep 2026 10:00:00 +0000'));
    const [sender] = (await f.call('summarize_senders', {})).result.data.senders;
    expect(sender.cautions?.length).toBeGreaterThan(0);
  });
});

describe('what each sender offers, and where replies go', () => {
  it('WHO-06 the best way each sender offers to unsubscribe: one click, a link, an email address, or none (added: 2.4.2, found live: "No" for LinkedIn, which offers a link)', async () => {
    f = await startToolFixture();
    await f.seedRaw('INBOX', from('Jobs <jobalerts@jobs.example.com>', 'Wed, 30 Sep 2026 08:00:00 +0000', ['List-Unsubscribe: <https://jobs.example.com/unsub?id=1>']));
    await f.seedRaw('INBOX', from('Club <news@club.example.org>', 'Wed, 30 Sep 2026 08:00:00 +0000', ['List-Unsubscribe: <mailto:leave@club.example.org>']));
    await f.seedRaw('INBOX', from('Club <news@club.example.org>', 'Wed, 30 Sep 2026 09:00:00 +0000', ['List-Unsubscribe: <mailto:leave@club.example.org>, <https://club.example.org/u>']));
    await f.seedRaw('INBOX', from('Sam <sam@example.org>', 'Wed, 30 Sep 2026 10:00:00 +0000'));
    const senders = (await f.call('summarize_senders', {})).result.data.senders as Array<{ address: string; unsubscribe: string }>;
    expect(Object.fromEntries(senders.map(s => [s.address, s.unsubscribe]))).toEqual({
      'news@club.example.org': 'link', 'jobalerts@jobs.example.com': 'link', 'sam@example.org': 'none'
    });
  });

  it('WHO-07 a sender whose replies go to another domain carries that caution too, once (added: 2.4.2, found live)', async () => {
    f = await startToolFixture();
    for (let i = 0; i < 2; i++) await f.seedRaw('INBOX', from('Wine Shop <shop@shared1.bulkmailer.example>', 'Wed, 30 Sep 2026 10:00:00 +0000', ['Reply-To: owner@freemail.example']));
    const [sender] = (await f.call('summarize_senders', {})).result.data.senders;
    expect(sender.cautions).toEqual(['Replies would go to owner@freemail.example, not to the sender\'s own domain (bulkmailer.example).']);
  });
});

describe('reading the newest messages', () => {
  const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });

  it('WHO-03 only the newest N by position, read-only, envelopes, flags and two headers, never a body; system emails left out', async () => {
    const gateway = new ImapGateway(config);
    const locks: unknown[] = [];
    const fetchAll = vi.fn(async () => [
      { uid: 501, flags: new Set(['\\Seen']), envelope: { messageId: '<a@x>', date: new Date('2026-09-30T08:00:00Z'), from: [{ name: 'Shop', address: 'deals@shop.example.com' }] },
        headers: Buffer.from('List-Unsubscribe: <https://shop.example.com/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n') },
      { uid: 502, flags: new Set(), envelope: { messageId: '<code@system.universal-mail.invalid>', from: [{ address: 'me@example.invalid' }] }, headers: Buffer.from('') },
      // Replies going to another domain: a caution from the envelope's Reply-To (WHO-07).
      { uid: 503, flags: new Set(), envelope: { messageId: '<w@x>', from: [{ address: 'shop@shared1.bulkmailer.example' }], replyTo: [{ address: 'owner@freemail.example' }] }, headers: Buffer.from('') },
      { uid: 504, flags: new Set(), envelope: { messageId: '<b@x>', from: [] }, headers: Buffer.from('') }
    ]);
    const client = {
      mailbox: { exists: 503 },
      getMailboxLock: vi.fn(async (_path: string, options: unknown) => { locks.push(options); return { release: vi.fn() }; }),
      fetchAll
    };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as never));
    expect(await gateway.senderStats('INBOX', 500)).toEqual([
      { from: { name: 'Shop', address: 'deals@shop.example.com' }, date: '2026-09-30T08:00:00.000Z', read: true, unsubscribe: 'one-click' },
      { from: { address: 'shop@shared1.bulkmailer.example' }, read: false, unsubscribe: 'none', cautions: ["Replies would go to owner@freemail.example, not to the sender's own domain (bulkmailer.example)."] },
      { read: false, unsubscribe: 'none' }
    ]);
    expect(locks).toEqual([{ readOnly: true }]);
    expect(fetchAll).toHaveBeenCalledWith('4:*', { envelope: true, flags: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] });
  });
});
