import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messageWithAttachments, pdfOf } from '../testkit/src/attachments.js';
import { startProduct, type Product } from '../testkit/src/product.js';
import { peek, seed } from '../testkit/src/seed.js';

// Sending attachments on a real mail server (Dovecot, Yahoo's layout) and a
// real SMTP server: the file is copied from the message the server holds.
describe('sending attachments on a real mail server', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like'); });
  afterAll(async () => { await p?.stop(); });

  it('OUT-06 a file from a stored email and a written one arrive at the SMTP server byte for byte; the source email stays unread (added: 2.4.1)', async () => {
    const messageId = '<to-send-on@example.invalid>';
    const invoice = pdfOf('Invoice total 42.00 EUR');
    const raw = await messageWithAttachments([{ filename: 'invoice.pdf', contentType: 'application/pdf', content: invoice }], { messageId, subject: 'Invoice' });
    const [message] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Invoice', messageId, raw }] })).messages;
    const sent = await p.ok('send_email', {
      to: ['accountant@example.invalid'], subject: 'For the books', text: 'Attached.', newRecipientsConfirmed: true,
      attachments: [{ mailbox: 'INBOX', uid: message!.uid, index: 0 }], files: [{ filename: 'summary.txt', text: 'Paid in full.' }]
    });
    expect(sent.attachments.map((a: { filename: string }) => a.filename)).toEqual(['invoice.pdf', 'summary.txt']);
    const delivered = await simpleParser(p.smtp.messages.at(-1)!.raw);
    expect(delivered.attachments.map(a => a.filename)).toEqual(['invoice.pdf', 'summary.txt']);
    expect(delivered.attachments[0]!.content.equals(invoice)).toBe(true);
    expect(delivered.attachments[1]!.content.toString('utf8')).toBe('Paid in full.');
    expect((await peek(p.server, 'INBOX')).find(m => m.messageId === messageId)).toMatchObject({ seen: false });
  });

  it('FWD-06 a forward of a stored email reaches the SMTP server with its attachments and the original\'s text (added: 2.4.1)', async () => {
    const messageId = '<to-forward@example.invalid>';
    const receipt = pdfOf('Receipt 17');
    const raw = await messageWithAttachments([{ filename: 'receipt.pdf', contentType: 'application/pdf', content: receipt }], { messageId, subject: 'Receipt' });
    const [message] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'Receipt', messageId, raw }] })).messages;
    await p.ok('forward_email', { mailbox: 'INBOX', uid: message!.uid, to: ['accountant@example.invalid'], text: 'For the books.', newRecipientsConfirmed: true });
    const delivered = await simpleParser(p.smtp.messages.at(-1)!.raw);
    expect(delivered.subject).toBe('Fwd: Receipt');
    expect(delivered.text).toContain('For the books.');
    expect(delivered.text).toContain('See attached.');
    expect(delivered.attachments.map(a => a.filename)).toEqual(['receipt.pdf']);
    expect(delivered.attachments[0]!.content.equals(receipt)).toBe(true);
    expect((await peek(p.server, 'INBOX')).find(m => m.messageId === messageId)).toMatchObject({ seen: false });
  });
});
