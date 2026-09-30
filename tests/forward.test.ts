import { simpleParser } from 'mailparser';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG_1X1, messageWithAttachments, pdfOf } from '../testkit/src/attachments.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// Forwarding (added 2.4.1): "forward the invoice to my accountant". A new
// Send tool: the owner's note, the original's details and text, and its
// attachments copied as they are. Held for someone new like any send.
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; });

const sentCopies = () => [...f!.rows.values()].filter(r => r.mailbox === 'Sent');
const invoice = pdfOf('Invoice total 42.00 EUR');

async function original(subject = 'Your invoice') {
  const raw = await messageWithAttachments([
    { filename: 'invoice.pdf', contentType: 'application/pdf', content: invoice },
    { filename: 'photo.png', contentType: 'image/png', content: PNG_1X1 }
  ], { subject });
  return (await f!.seedRaw('INBOX', raw)).uid;
}

describe('forwarding', () => {
  it('FWD-01 the note, then the original\'s sender, date, subject and text, and its attachments byte for byte; the original stays unread', async () => {
    f = await startToolFixture();
    const uid = await original();
    const forwarded = await f.call('forward_email', { mailbox: 'INBOX', uid, to: ['accountant@example.invalid'], text: 'For the books.', newRecipientsConfirmed: true });
    expect(forwarded.result).toMatchObject({ ok: true, code: 'SENT', data: { attachments: [{ filename: 'invoice.pdf' }, { filename: 'photo.png' }] } });
    const parsed = await simpleParser(sentCopies()[0]!.raw);
    expect(parsed.subject).toBe('Fwd: Your invoice');
    expect(parsed.to).toMatchObject({ value: [{ address: 'accountant@example.invalid' }] });
    const text = parsed.text ?? '';
    expect(text.indexOf('For the books.')).toBe(0);
    expect(text).toContain('---------- Forwarded message ----------');
    expect(text).toContain('From: sender@example.invalid');
    expect(text).toContain('Subject: Your invoice');
    expect(text).toMatch(/Date: \S/);
    expect(text).toContain('To: self@example.invalid');
    expect(text.indexOf('See attached.')).toBeGreaterThan(text.indexOf('---------- Forwarded message ----------'));
    expect(parsed.attachments.map(a => a.filename)).toEqual(['invoice.pdf', 'photo.png']);
    expect(parsed.attachments[0]!.content.equals(invoice)).toBe(true);
    expect(f.rows.get(uid)!.read).toBe(false);
  });

  it('FWD-02 without its attachments when asked; a subject already marked Fwd isn\'t marked twice; no note is fine', async () => {
    f = await startToolFixture();
    const uid = await original('Fwd: Your invoice');
    const forwarded = await f.call('forward_email', { mailbox: 'INBOX', uid, to: ['accountant@example.invalid'], includeAttachments: false, newRecipientsConfirmed: true });
    expect(forwarded.result.ok).toBe(true);
    expect(forwarded.result.data.attachments).toBeUndefined();
    const parsed = await simpleParser(sentCopies()[0]!.raw);
    expect(parsed.subject).toBe('Fwd: Your invoice');
    expect(parsed.attachments).toEqual([]);
    expect(parsed.text).toMatch(/^---------- Forwarded message ----------/);
  });

  it('FWD-03 to someone new it is held, naming the files that would go, and nothing is sent', async () => {
    f = await startToolFixture();
    const uid = await original();
    const held = await f.call('forward_email', { mailbox: 'INBOX', uid, to: ['stranger@example.invalid'] });
    expect(held.result).toMatchObject({ ok: false, code: 'MAIL-NEW-RECIPIENT', data: { newRecipients: ['stranger@example.invalid'], attachments: ['invoice.pdf', 'photo.png'] } });
    expect(sentCopies()).toEqual([]);
  });

  it('FWD-04 a message that isn\'t there is not found', async () => {
    f = await startToolFixture();
    expect((await f.call('forward_email', { mailbox: 'INBOX', uid: 99, to: ['a@example.invalid'], newRecipientsConfirmed: true })).result).toMatchObject({ ok: false });
    expect(sentCopies()).toEqual([]);
  });
});
