import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { realOneClick } from '../src/unsubscribe.js';
import { startProduct, type Product } from '../testkit/src/product.js';
import { peek, seed } from '../testkit/src/seed.js';

// The clean-up tools on a real mail server (Dovecot, Yahoo's layout, where
// the folder marked Junk is called "Bulk").
describe('cleaning up on a real mail server', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like'); });
  afterAll(async () => { await p?.stop(); });
  afterEach(() => vi.restoreAllMocks());

  it('JNK-04 junk goes to the folder the server marks as Junk, whatever its name, and restore brings it back (added: 2.4.1)', async () => {
    const [message] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Win a prize', messageId: '<prize@spam.example>' }] })).messages;
    const junked = await p.ok('junk_email', { mailbox: 'INBOX', uid: message!.uid });
    expect(junked.destination).toBe('Bulk');
    expect((await peek(p.server, 'Bulk')).map(m => m.messageId)).toContain('<prize@spam.example>');
    const back = await p.ok('restore_email', { mailbox: 'Bulk', uid: junked.destinationUid });
    expect(back.destination).toBe('INBOX');
  });

  it('UNS-10 the unsubscribe headers are read from the message the server holds, and the email is left unread where it was (added: 2.4.1)', async () => {
    const posted: string[] = [];
    vi.spyOn(realOneClick, 'resolve').mockResolvedValue(['93.184.216.34']);
    vi.spyOn(realOneClick, 'post').mockImplementation(async url => { posted.push(url.href); return 200; });
    const [message] = (await seed(p.server, { messages: [{
      mailbox: 'INBOX', subject: 'This week', from: 'News <news@news.example.com>', messageId: '<week@news.example.com>',
      headers: { 'List-Unsubscribe': '<mailto:leave@news.example.com>,\r\n <https://news.example.com/u?id=7>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    }] })).messages;
    expect(await p.ok('unsubscribe', { mailbox: 'INBOX', uid: message!.uid })).toMatchObject({ unsubscribed: true, sender: 'news.example.com' });
    expect(posted).toEqual(['https://news.example.com/u?id=7']);
    expect((await peek(p.server, 'INBOX')).find(m => m.messageId === '<week@news.example.com>')).toMatchObject({ seen: false });
  });

  it('WHO-05 senders are counted from the server\'s own envelopes, flags and headers (added: 2.4.1)', async () => {
    await seed(p.server, { folders: ['Counted'], messages: [
      { mailbox: 'Counted', subject: 'a', from: 'Shop <deals@shop.example.com>', headers: { 'List-Unsubscribe': '<https://shop.example.com/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } },
      { mailbox: 'Counted', subject: 'b', from: 'deals@shop.example.com' },
      { mailbox: 'Counted', subject: 'c', from: 'Sam <sam@example.org>' }
    ] });
    const [first] = await p.ok('search_email', { mailbox: 'Counted', from: 'sam@example.org' });
    await p.ok('mark_read', { mailbox: 'Counted', uid: first.uid });
    const answer = await p.ok('summarize_senders', { mailbox: 'Counted' });
    expect(answer).toMatchObject({ looked: 3, senders: [
      { address: 'deals@shop.example.com', name: 'Shop', messages: 2, unread: 2, unsubscribe: 'one-click' },
      { address: 'sam@example.org', name: 'Sam', messages: 1, unread: 0, unsubscribe: 'none' }
    ] });
  });
});
