import { afterEach, describe, expect, it } from 'vitest';
import { DOCX, PNG_1X1, docxOf, messageWithAttachments, pdfOf } from '../testkit/src/attachments.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// Reading attachments (added 2026-09-29, the owner: "review of attachments
// ... that is important"). A new read-only tool, get_attachment: text-like
// files, PDFs and Word documents come back as text; images as a picture the AI
// can look at; everything else by its details. Read in the same sandbox as
// email (time and memory limits), always marked untrusted, never marking the
// email read.
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; });

const read = async (uid: number, index: number) => (await f!.call('get_attachment', { mailbox: 'INBOX', uid, index }));

describe('reading attachments', () => {
  it('ATT-01 text, CSV, HTML, PDF and Word attachments come back as text, marked untrusted, and the email stays unread', async () => {
    f = await startToolFixture();
    const raw = await messageWithAttachments([
      { filename: 'notes.txt', contentType: 'text/plain; charset=utf-8', content: 'Meet at 10' },
      { filename: 'costs.csv', contentType: 'text/csv', content: 'item,cost\nsail,300' },
      { filename: 'page.html', contentType: 'text/html', content: '<p>Hello <b>there</b></p><script>steal()</script>' },
      { filename: 'invoice.pdf', contentType: 'application/pdf', content: pdfOf('Invoice total 42.00 EUR') },
      { filename: 'contract.docx', contentType: DOCX, content: await docxOf('Contract signed on Monday') }
    ]);
    const { uid } = await f.seedRaw('INBOX', raw);
    const email = (await f.call('get_email', { mailbox: 'INBOX', uid })).result.data;
    expect(email.attachments.map((a: { index: number; filename: string }) => [a.index, a.filename]))
      .toEqual([[0, 'notes.txt'], [1, 'costs.csv'], [2, 'page.html'], [3, 'invoice.pdf'], [4, 'contract.docx']]);

    const text = await read(uid, 0);
    expect(text.result).toMatchObject({ ok: true, data: { index: 0, filename: 'notes.txt', readable: true, kind: 'text', text: 'Meet at 10', untrustedContent: true } });
    expect((await read(uid, 1)).result.data.text).toContain('sail,300');
    const html = (await read(uid, 2)).result.data.text as string;
    expect(html).toMatch(/Hello\s+there/i);
    expect(html).not.toContain('steal()');
    expect((await read(uid, 3)).result.data).toMatchObject({ kind: 'text', text: expect.stringContaining('Invoice total 42.00 EUR') });
    expect((await read(uid, 4)).result.data).toMatchObject({ kind: 'text', text: expect.stringContaining('Contract signed on Monday') });
    expect(f.rows.get(uid)!.read).toBe(false);
  });

  it('ATT-01 a file sent as "application/octet-stream" is read by its name (.pdf, .docx, .txt)', async () => {
    f = await startToolFixture();
    const raw = await messageWithAttachments([
      { filename: 'scan.PDF', contentType: 'application/octet-stream', content: pdfOf('Scanned receipt') },
      { filename: 'letter.docx', contentType: 'application/octet-stream', content: await docxOf('Dear neighbour') },
      { filename: 'readme.txt', contentType: 'application/octet-stream', content: 'plain words' }
    ]);
    const { uid } = await f.seedRaw('INBOX', raw);
    expect((await read(uid, 0)).result.data.text).toContain('Scanned receipt');
    expect((await read(uid, 1)).result.data.text).toContain('Dear neighbour');
    expect((await read(uid, 2)).result.data.text).toBe('plain words');
  });

  it('ATT-02 an image comes back as a picture the AI can look at; the answer\'s JSON stays small; one too large is described instead', async () => {
    f = await startToolFixture();
    const raw = await messageWithAttachments([
      { filename: 'receipt.png', contentType: 'image/png', content: PNG_1X1 },
      { filename: 'huge.png', contentType: 'image/png', content: Buffer.alloc(3_100_000, 1) }
    ]);
    const { uid } = await f.seedRaw('INBOX', raw);
    const image = await read(uid, 0);
    expect(image.result.data).toMatchObject({ filename: 'receipt.png', readable: true, kind: 'image', untrustedContent: true });
    expect(image.content.find(c => c.type === 'image')).toEqual({ type: 'image', mimeType: 'image/png', data: PNG_1X1.toString('base64') });
    expect(JSON.stringify(image.result)).not.toContain(PNG_1X1.toString('base64'));
    const huge = await read(uid, 1);
    expect(huge.result.data).toMatchObject({ readable: false, kind: 'unsupported' });
    expect(huge.result.message).toMatch(/too large to show/i);
    expect(huge.content.some(c => c.type === 'image')).toBe(false);
  });

  it('ATT-03 other kinds are described, not read; a position that doesn\'t exist is not found; a long text is clipped and says so', async () => {
    f = await startToolFixture();
    const raw = await messageWithAttachments([
      { filename: 'photos.zip', contentType: 'application/zip', content: Buffer.from('PK\u0003\u0004 not really') },
      { filename: 'long.txt', contentType: 'text/plain', content: 'x'.repeat(150_000) }
    ]);
    const { uid } = await f.seedRaw('INBOX', raw);
    const zip = await read(uid, 0);
    expect(zip.result).toMatchObject({ ok: true, data: { filename: 'photos.zip', contentType: 'application/zip', readable: false, kind: 'unsupported' } });
    expect(zip.result.message).toMatch(/can't be read/i);
    const long = await read(uid, 1);
    expect(long.result.data).toMatchObject({ truncated: true });
    expect(long.result.data.text.length).toBeLessThanOrEqual(100_000);
    const missing = await read(uid, 9);
    expect(missing.isError).toBe(true);
    expect(missing.result).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND', status: 'NOT_FOUND' });
  });

  it('ATT-04 a damaged PDF or Word file says it couldn\'t be read, and the email still opens', async () => {
    f = await startToolFixture();
    const raw = await messageWithAttachments([
      { filename: 'broken.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 this is not a pdf') },
      { filename: 'broken.docx', contentType: DOCX, content: Buffer.from('not a zip at all') }
    ]);
    const { uid } = await f.seedRaw('INBOX', raw);
    for (const index of [0, 1]) {
      const answer = await read(uid, index);
      expect(answer.result, String(index)).toMatchObject({ ok: true, data: { readable: false, kind: 'unreadable' } });
      expect(answer.result.message).toMatch(/couldn't be read/i);
    }
    expect((await f.call('get_email', { mailbox: 'INBOX', uid })).result.ok).toBe(true);
  });

  it('ATT-05 get_attachment is a read: marked read-only for the apps, described as untrusted', async () => {
    f = await startToolFixture();
    const tool = (await f.tools()).find(t => t.name === 'get_attachment')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.description).toMatch(/untrusted/i);
    expect(tool.description).toMatch(/index/i);
  });
});
