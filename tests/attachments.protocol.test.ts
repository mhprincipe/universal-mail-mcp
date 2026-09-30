import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PNG_1X1, messageWithAttachments, pdfOf } from '../testkit/src/attachments.js';
import { startProduct, type Product } from '../testkit/src/product.js';
import { peek, seed } from '../testkit/src/seed.js';

// Reading attachments on a real mail server (Dovecot, Yahoo's layout): the
// attachment is read from the message as the server stores it, and the email
// is not marked read by it.
describe('attachments on a real mail server', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like', { imapFault: {} }); });
  afterAll(async () => { await p?.stop(); });

  it('ATT-06 a PDF\'s text and an image come back from the message the server holds, and the email stays unread (added: reading attachments)', async () => {
    const messageId = '<with-attachments@example.invalid>';
    const raw = await messageWithAttachments([
      { filename: 'invoice.pdf', contentType: 'application/pdf', content: pdfOf('Invoice total 42.00 EUR') },
      { filename: 'receipt.png', contentType: 'image/png', content: PNG_1X1 }
    ], { messageId, subject: 'Your invoice' });
    const [message] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Your invoice', messageId, raw }] })).messages;
    const email = await p.ok('get_email', { mailbox: 'INBOX', uid: message!.uid });
    expect(email.attachments.map((a: { index: number; filename: string }) => [a.index, a.filename])).toEqual([[0, 'invoice.pdf'], [1, 'receipt.png']]);
    const lines = p.proxy!.lines().length;
    const pdf = await p.ok('get_attachment', { mailbox: 'INBOX', uid: message!.uid, index: 0 });
    expect(pdf).toMatchObject({ filename: 'invoice.pdf', kind: 'text', readable: true, untrustedContent: true });
    expect(pdf.text).toContain('Invoice total 42.00 EUR');
    expect(await p.ok('get_attachment', { mailbox: 'INBOX', uid: message!.uid, index: 1 })).toMatchObject({ kind: 'image', readable: true });
    // Read with PEEK only, and the server agrees it's still unread.
    const sent = p.proxy!.lines().slice(lines);
    expect(sent.filter(l => /STORE|\bBODY\[\]/i.test(l))).toEqual([]);
    expect((await peek(p.server, 'INBOX')).find(m => m.messageId === messageId)).toMatchObject({ seen: false });
  });
});
