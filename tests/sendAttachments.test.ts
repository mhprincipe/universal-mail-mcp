import { simpleParser } from 'mailparser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MailService } from '../src/mail/mailService.js';
import { createSendLog } from '../src/sendLimits.js';
import { PNG_1X1, messageWithAttachments, pdfOf } from '../testkit/src/attachments.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// Sending attachments (added 2.4.1, the owner: "how about if we want to attach
// a file?"). Two kinds: a file already in the mailbox (an attachment of another
// email, by its folder, uid and index: the server copies it, so nothing large
// passes through the AI), and a small text file the AI writes (a CSV, notes, a
// calendar invite). Read in the parsing sandbox like any attachment.
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; vi.restoreAllMocks(); });

const sentCopies = () => [...f!.rows.values()].filter(r => r.mailbox === 'Sent');

const invoice = pdfOf('Invoice total 42.00 EUR');

async function withInvoice() {
  const raw = await messageWithAttachments([
    { filename: 'invoice.pdf', contentType: 'application/pdf', content: invoice },
    { filename: 'photo.png', contentType: 'image/png', content: PNG_1X1 }
  ]);
  return (await f!.seedRaw('INBOX', raw)).uid;
}

describe('sending attachments', () => {
  it('OUT-01 a send carries a file from another email, byte for byte, and a text file the AI wrote; the answer lists them', async () => {
    f = await startToolFixture();
    const uid = await withInvoice();
    const sent = await f.call('send_email', {
      to: ['accountant@example.invalid'], subject: 'Invoice', text: 'Attached.', newRecipientsConfirmed: true,
      attachments: [{ mailbox: 'INBOX', uid, index: 0 }], files: [{ filename: 'costs.csv', text: 'item,cost\ncafé,300\n' }]
    });
    expect(sent.result).toMatchObject({ ok: true, data: { attachments: [
      { filename: 'invoice.pdf', contentType: 'application/pdf', size: invoice.length },
      { filename: 'costs.csv', contentType: 'text/csv' }
    ] } });
    const [copy] = sentCopies();
    const parsed = await simpleParser(copy!.raw);
    expect(parsed.text?.trim()).toBe('Attached.');
    expect(parsed.attachments.map(a => [a.filename, a.contentType])).toEqual([['invoice.pdf', 'application/pdf'], ['costs.csv', 'text/csv']]);
    expect(parsed.attachments[0]!.content.equals(invoice)).toBe(true);
    expect(parsed.attachments[1]!.content.toString('utf8')).toBe('item,cost\ncafé,300\n');
    // Labelled as UTF-8, so "café" reads right in the recipient's mail app.
    expect((parsed.attachments[1]!.headers.get('content-type') as { params?: { charset?: string } }).params?.charset).toBe('utf-8');
    // Reading an attachment to send it doesn't mark its email read.
    expect(f.rows.get(uid)!.read).toBe(false);
  });

  it('OUT-02 a reply and a draft can carry them too; editing a draft keeps its attachments (it used to refuse)', async () => {
    f = await startToolFixture();
    const uid = await withInvoice();
    const reply = await f.call('reply_email', { mailbox: 'INBOX', uid, text: 'Here is my copy.', newRecipientsConfirmed: true, files: [{ filename: 'notes.md', text: '# Notes' }] });
    expect(reply.result).toMatchObject({ ok: true, data: { attachments: [{ filename: 'notes.md', contentType: 'text/markdown' }] } });
    expect((await simpleParser(sentCopies()[0]!.raw)).attachments.map(a => a.filename)).toEqual(['notes.md']);

    const draft = await f.call('create_draft', { to: ['friend@example.invalid'], subject: 'Photo', text: 'First try', attachments: [{ mailbox: 'INBOX', uid, index: 1 }] });
    expect(draft.result).toMatchObject({ ok: true, data: { attachments: [{ filename: 'photo.png', contentType: 'image/png' }] } });
    const updated = await f.call('update_draft', { mailbox: 'Draft', uid: draft.result.data.uid, text: 'Second try', files: [{ filename: 'invite.ics', text: 'BEGIN:VCALENDAR\nEND:VCALENDAR\n' }] });
    expect(updated.result).toMatchObject({ ok: true, data: { attachments: [{ filename: 'photo.png' }, { filename: 'invite.ics', contentType: 'text/calendar' }] } });
    // The fixture can't delete, so the old draft stays beside the new one.
    const kept = f.rows.get(updated.result.data.uid);
    const parsed = await simpleParser(kept!.raw);
    expect(parsed.text?.trim()).toBe('Second try');
    expect(parsed.attachments.map(a => a.filename)).toEqual(['photo.png', 'invite.ics']);
    expect(parsed.attachments[0]!.content.equals(PNG_1X1)).toBe(true);
  });

  it('OUT-03 nothing is sent when an attachment isn\'t there, a file\'s name or kind isn\'t allowed, or they are too large together', async () => {
    f = await startToolFixture({ env: { MAX_ATTACHMENT_BYTES: String(invoice.length - 1) } });
    const uid = await withInvoice();
    const send = (extra: Record<string, unknown>) => f!.call('send_email', { to: ['a@example.invalid'], subject: 's', text: 't', newRecipientsConfirmed: true, ...extra });
    expect((await send({ attachments: [{ mailbox: 'INBOX', uid, index: 7 }] })).result).toMatchObject({ ok: false, code: 'ATTACHMENT_NOT_FOUND' });
    for (const filename of ['run.exe', 'page.html', '.profile.txt', '../secret.txt', 'dir/notes.txt', 'noextension', 'a\u0000.txt']) {
      expect((await send({ files: [{ filename, text: 'x' }] })).result, filename).toMatchObject({ ok: false, code: 'MAIL-FILE-NOT-ALLOWED' });
    }
    // The invoice alone is one byte over.
    expect((await send({ attachments: [{ mailbox: 'INBOX', uid, index: 0 }] })).result).toMatchObject({ ok: false, code: 'ATTACHMENTS_TOO_LARGE' });
    expect((await send({ files: [{ filename: 'big.txt', text: 'x'.repeat(invoice.length) }] })).result).toMatchObject({ ok: false, code: 'ATTACHMENTS_TOO_LARGE' });
    expect(sentCopies()).toEqual([]);
  });

  it('OUT-04 the tools describe both kinds, and what may be written', async () => {
    f = await startToolFixture();
    const tools = await f.tools();
    for (const name of ['send_email', 'reply_email', 'create_draft', 'update_draft']) {
      const properties = (tools.find(t => t.name === name)!.inputSchema as any).properties;
      expect(properties.attachments.description, name).toMatch(/index/);
      expect(properties.files.description, name).toMatch(/\.csv/);
    }
  });
});

describe('a first message with attachments', () => {
  const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', SENT_COPY_MODE: 'append', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });

  it('OUT-05 held for someone new names what would go with it, so the owner knows what they are confirming', async () => {
    const s = new MailService(config, { sendLog: createSendLog() });
    const smtp = vi.spyOn((s as any).smtp, 'sendMail').mockResolvedValue({ accepted: ['x'], rejected: [] });
    vi.spyOn(s.imap, 'specialFolders').mockResolvedValue({ sent: 'Sent' } as any);
    vi.spyOn(s.imap, 'hasSentTo').mockResolvedValue(false);
    const raw = await messageWithAttachments([{ filename: 'statement.pdf', contentType: 'application/pdf', content: pdfOf('Balance') }]);
    vi.spyOn(s.imap, 'fetchRaw').mockResolvedValue({ raw, summary: {} as any, envelope: {} });
    const held = await s.sendEmail({ to: ['stranger@example.invalid'], subject: 's', text: 't', attachments: [{ mailbox: 'INBOX', uid: 1, index: 0 }], files: [{ filename: 'notes.txt', text: 'hi' }] })
      .catch(error => error);
    expect(held).toMatchObject({ code: 'MAIL-NEW-RECIPIENT', details: { newRecipients: ['stranger@example.invalid'], attachments: ['statement.pdf', 'notes.txt'] } });
    expect(held.message).toBe('This would be the first message to stranger@example.invalid, with 2 attachments (statement.pdf, notes.txt). Nothing was sent.');
    expect(smtp).not.toHaveBeenCalled();
  });
});

describe('the files to send, as the sandbox reads them', () => {
  it('OUT-07 every attachment with its name, its type (parameters dropped) and its exact bytes; the email\'s structure limits apply first (added: coverage: the worker\'s code isn\'t counted)', { timeout: 30_000 }, async () => {
    const { attachmentFiles } = await import('../src/attachmentCore.js');
    const raw = await messageWithAttachments([
      { filename: 'invoice.pdf', contentType: 'application/pdf', content: invoice },
      { filename: 'menu.txt', contentType: 'text/plain; charset=iso-8859-1', content: Buffer.from('Café', 'latin1') }
    ]);
    const files = await attachmentFiles(raw);
    expect(files.map(f => [f.filename, f.contentType])).toEqual([['invoice.pdf', 'application/pdf'], ['menu.txt', 'text/plain']]);
    expect(Buffer.from(files[0]!.content).equals(invoice)).toBe(true);
    expect(Buffer.from(files[1]!.content).equals(Buffer.from('Café', 'latin1'))).toBe(true);
    const deep = `Content-Type: multipart/mixed; boundary="b0"\r\n\r\n${Array.from({ length: 60 }, (_, i) => `--b${i}\r\nContent-Type: multipart/mixed; boundary="b${i + 1}"\r\n\r\n`).join('')}`;
    await expect(attachmentFiles(Buffer.from(deep, 'latin1'))).rejects.toThrow(/depth/);
  });
});
