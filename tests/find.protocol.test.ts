import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG_1X1, messageWithAttachments, pdfOf } from '../testkit/src/attachments.js';
import { startProduct, type Product } from '../testkit/src/product.js';
import { seed } from '../testkit/src/seed.js';

// 2.4.2 on a real mail server (Dovecot, Yahoo's layout): attachments seen in
// search results from the server's own message structure, and marks that say
// what they really changed.
describe('2.4.2 on a real mail server', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like'); });
  afterAll(async () => { await p?.stop(); });

  it('FND-05 search results name attachments from the stored structure; hasAttachments and attachmentName find them; a plain message has none (added: 2.4.2)', async () => {
    const withFiles = await messageWithAttachments([
      { filename: 'invoice-march.pdf', contentType: 'application/pdf', content: pdfOf('March') },
      { filename: 'photo.png', contentType: 'image/png', content: PNG_1X1 }
    ], { messageId: '<files@example.invalid>', subject: 'Files' });
    await seed(p.server, { folders: ['Found'], messages: [
      { mailbox: 'Found', subject: 'Files', messageId: '<files@example.invalid>', raw: withFiles },
      { mailbox: 'Found', subject: 'Plain' }
    ] });
    const all = await p.ok('search_email', { mailbox: 'Found' });
    expect(all.map((m: { subject: string; attachmentNames?: string[] }) => [m.subject, m.attachmentNames])).toEqual([['Plain', undefined], ['Files', ['invoice-march.pdf', 'photo.png']]]);
    expect((await p.ok('search_email', { mailbox: 'Found', hasAttachments: true })).map((m: { subject: string }) => m.subject)).toEqual(['Files']);
    expect((await p.ok('search_email', { mailbox: 'Found', attachmentName: 'INVOICE' })).map((m: { subject: string }) => m.subject)).toEqual(['Files']);
    expect(await p.ok('search_email', { mailbox: 'Found', attachmentName: 'contract' })).toEqual([]);
  });

  it('ACT-11 a mark says which messages it really changed, from the flags the server held just before (added: 2.4.2)', async () => {
    const { messages } = await seed(p.server, { folders: ['Marks'], messages: [
      { mailbox: 'Marks', subject: 'one' }, { mailbox: 'Marks', subject: 'two' }, { mailbox: 'Marks', subject: 'three' }
    ] });
    const [one, two, three] = messages.map(m => m.uid);
    await p.ok('mark_read', { mailbox: 'Marks', uid: two });
    expect(await p.ok('mark_read', { mailbox: 'Marks', uids: [one, two, three] })).toMatchObject({ changed: [one, three] });
    expect(await p.ok('mark_read', { mailbox: 'Marks', uid: two })).toMatchObject({ changed: [] });
  });
});
