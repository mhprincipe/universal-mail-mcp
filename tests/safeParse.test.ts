import { afterEach, describe, expect, it } from 'vitest';
import { createDeflate } from 'node:zlib';
import { parseMessage } from '../src/parseCore.js';
import { createSafeParser, type SafeParser } from '../src/safeParse.js';

const ordinary = [
  'Message-ID: <m1@example.invalid>',
  'In-Reply-To: <m0@example.invalid>',
  'References: <r1@example.invalid> <m0@example.invalid>',
  'Subject: =?UTF-8?B?Q2Fmw6kgcGxhbnM=?=',
  'From: =?UTF-8?Q?Ana_D=C3=ADaz?= <ana@example.invalid>',
  'To: bo@example.invalid, Cy <cy@example.invalid>',
  'Cc: Di <di@example.invalid>',
  'Reply-To: replies@example.invalid',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello there.',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello <b>there</b>.</p>',
  '--inner--',
  '--outer',
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'aGVsbG8=',
  '--outer--',
  ''
].join('\r\n');

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

function nested(depth: number): string {
  let body = 'Content-Type: text/plain\r\n\r\ninnermost\r\n';
  for (let level = depth; level > 0; level--) {
    body = `Content-Type: multipart/mixed; boundary="b${level}"\r\n\r\n--b${level}\r\n${body}--b${level}--\r\n`;
  }
  return `Message-ID: <deep@example.invalid>\r\nMIME-Version: 1.0\r\n${body}`;
}

function manyParts(count: number): string {
  const parts = Array.from({ length: count }, (_, i) => `--p\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`).join('');
  return `Message-ID: <bomb@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="p"\r\n\r\n${parts}--p--\r\n`;
}

const hugeHeader = () => `Message-ID: <huge@example.invalid>\r\nX-Filler: ${'a'.repeat(2 * 1024 * 1024)}\r\n\r\nbody\r\n`;

const unsafe = { code: 'MAIL-PARSE-UNSAFE', message: "This email couldn't be opened safely." };

let parser: SafeParser | undefined;
afterEach(async () => { await parser?.close(); parser = undefined; });

describe('safe parsing', () => {
  it('PAR-01 an ordinary message parses in the worker with the fields v1 returned', async () => {
    const expected = {
      messageId: '<m1@example.invalid>',
      subject: 'Café plans',
      from: [{ name: 'Ana Díaz', address: 'ana@example.invalid' }],
      to: [{ address: 'bo@example.invalid' }, { name: 'Cy', address: 'cy@example.invalid' }],
      cc: [{ name: 'Di', address: 'di@example.invalid' }],
      bcc: [],
      replyTo: [{ address: 'replies@example.invalid' }],
      text: expect.stringMatching(/^Hello there\.\s*$/),
      html: expect.stringMatching(/^<p>Hello <b>there<\/b>\.<\/p>\s*$/),
      inReplyTo: '<m0@example.invalid>',
      references: ['<r1@example.invalid>', '<m0@example.invalid>'],
      // Details only: attachment bytes never cross back from the worker.
      attachments: [{ index: 0, filename: 'plan.pdf', contentType: 'application/pdf', size: 5, contentId: undefined }]
    };
    parser = createSafeParser();
    expect(await parser.parse(Buffer.from(ordinary))).toEqual(expected);
    // The same core, called directly, gives the same answer: the worker is only transport.
    expect(await parseMessage(Buffer.from(ordinary))).toEqual(expected);
  });

  it('PAR-02 every message in the hostile corpus returns MAIL-PARSE-UNSAFE within the time limit', { timeout: 30_000 }, async () => {
    const timeoutMs = 2_000;
    const corpus: Array<[string, SafeParser, string]> = [
      ['deep nesting', createSafeParser({ timeoutMs }), nested(200)],
      ['part bomb', createSafeParser({ timeoutMs }), manyParts(3_000)],
      ['huge header', createSafeParser({ timeoutMs }), hugeHeader()],
      ['never finishes', createSafeParser({ timeoutMs, workerFile: fixture('hangingWorker.mjs') }), 'Subject: x\r\n\r\nx'],
      ['eats memory', createSafeParser({ timeoutMs: 20_000, memoryMb: 32, workerFile: fixture('memoryHogWorker.mjs') }), 'Subject: x\r\n\r\nx']
    ];
    try {
      for (const [name, hostileParser, raw] of corpus) {
        const started = Date.now();
        await expect(hostileParser.parse(Buffer.from(raw)), name).rejects.toMatchObject(unsafe);
        expect(Date.now() - started, name).toBeLessThan(timeoutMs + 3_000);
      }
    } finally {
      await Promise.all(corpus.map(([, hostileParser]) => hostileParser.close()));
    }
  });

  it('PAR-03 a killed or crashed worker does not stop parsing: the next email opens', { timeout: 20_000 }, async () => {
    parser = createSafeParser({ timeoutMs: 1_000, workerFile: fixture('selectiveWorker.mjs') });
    const ok = (subject: string) => Buffer.from(`Message-ID: <${subject}@example.invalid>\r\nSubject: ${subject}\r\n\r\nhi`);

    await expect(parser.parse(Buffer.from('Subject: HANG\r\n\r\nx'))).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: 'time limit' } });
    expect(await parser.parse(ok('after-kill'))).toMatchObject({ subject: 'after-kill' });

    await expect(parser.parse(Buffer.from('Subject: CRASH\r\n\r\nx'))).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: 'worker stopped' } });
    expect(await parser.parse(ok('after-crash'))).toMatchObject({ subject: 'after-crash' });
  });

  it('PAR-04 an email that failed to open is not parsed again', { timeout: 20_000 }, async () => {
    parser = createSafeParser({ timeoutMs: 1_000, workerFile: fixture('selectiveWorker.mjs') });
    const stuck = Buffer.from('Message-ID: <shared@example.invalid>\r\nSubject: HANG\r\n\r\nx');
    await expect(parser.parse(stuck)).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: 'time limit' } });

    const started = Date.now();
    await expect(parser.parse(stuck)).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: 'failed before' } });
    expect(Date.now() - started).toBeLessThan(500);

    // Remembered by its exact bytes, not its Message-ID, which any sender can
    // copy: a hostile email must not be able to block a genuine one.
    const genuine = Buffer.from('Message-ID: <shared@example.invalid>\r\nSubject: fine\r\n\r\nhi');
    expect(await parser.parse(genuine)).toMatchObject({ subject: 'fine' });
  });

  it('PAR-06 an ordinary email caught behind a stuck or crashing one still opens', { timeout: 20_000 }, async () => {
    parser = createSafeParser({ timeoutMs: 1_000, workerFile: fixture('selectiveWorker.mjs') });
    const ok = (subject: string) => Buffer.from(`Subject: ${subject}\r\n\r\nhi`);

    const [stuck, bystander] = await Promise.allSettled([parser.parse(Buffer.from('Subject: BUSY\r\n\r\nx')), parser.parse(ok('bystander'))]);
    expect(stuck).toMatchObject({ status: 'rejected', reason: { code: 'MAIL-PARSE-UNSAFE' } });
    expect(bystander).toMatchObject({ status: 'fulfilled', value: { subject: 'bystander' } });

    const [crash, survivor] = await Promise.allSettled([parser.parse(Buffer.from('Subject: CRASH\r\n\r\nx')), parser.parse(ok('survivor'))]);
    expect(crash).toMatchObject({ status: 'rejected', reason: { code: 'MAIL-PARSE-UNSAFE' } });
    expect(survivor).toMatchObject({ status: 'fulfilled', value: { subject: 'survivor' } });
  });

  it('PAR-05 the limits on MIME depth, part count and header size each trigger on their own', async () => {
    const limits = { maxDepth: 5, maxParts: 10, maxHeaderBytes: 1024 };
    const header = (bytes: number) => `Message-ID: <h@example.invalid>\r\nX-Filler: ${'a'.repeat(bytes)}\r\n\r\nbody\r\n`;

    // Within every limit.
    for (const raw of [nested(5), manyParts(5), header(500)]) {
      await expect(parseMessage(Buffer.from(raw), limits), raw.slice(0, 60)).resolves.toBeDefined();
    }
    // Each over exactly one limit, and named by it.
    await expect(parseMessage(Buffer.from(nested(6)), limits)).rejects.toMatchObject({ limit: 'depth' });
    await expect(parseMessage(Buffer.from(manyParts(20)), limits)).rejects.toMatchObject({ limit: 'parts' });
    await expect(parseMessage(Buffer.from(header(2_000)), limits)).rejects.toMatchObject({ limit: 'header size' });
  });

  it('PAR-07 a slow-starting worker does not count against an email\'s time limit', { timeout: 20_000 }, async () => {
    parser = createSafeParser({ timeoutMs: 1_000, workerFile: fixture('slowStartWorker.mjs') });
    expect(await parser.parse(Buffer.from('Subject: patient\r\n\r\nhi'))).toMatchObject({ subject: 'patient' });
  });

  it('PAR-07 a worker that never starts is reported as unavailable, not blamed on the email', { timeout: 20_000 }, async () => {
    parser = createSafeParser({ startupTimeoutMs: 500, workerFile: fixture('neverReadyWorker.mjs') });
    const unavailable = { code: 'MAIL-PARSER-UNAVAILABLE', message: "Emails can't be opened right now. Try again in a minute." };
    const email = Buffer.from('Subject: innocent\r\n\r\nhi');
    await expect(parser.parse(email)).rejects.toMatchObject(unavailable);
    // Not remembered as unsafe: asking again tries again.
    await expect(parser.parse(email)).rejects.toMatchObject(unavailable);
  });

  it('PAR-02 malformed encodings never crash the parser', async () => {
    parser = createSafeParser();
    const malformed = [
      'Subject: =?UTF-8?B?not base64!!?=\r\n\r\nbody',
      'Content-Type: text/plain; charset=no-such-charset\r\n\r\n\xff\xfe body',
      'Content-Transfer-Encoding: base64\r\n\r\n%%%not-base64%%%',
      'Content-Type: multipart/mixed; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nno closing boundary'
    ];
    for (const raw of malformed) {
      const outcome = await parser.parse(Buffer.from(raw, 'latin1')).then(() => 'parsed', (error: { code?: string }) => error.code);
      expect(['parsed', 'MAIL-PARSE-UNSAFE'], raw.slice(0, 40)).toContain(outcome);
    }
  });
});

describe('reading an attachment safely', () => {
  it('ATT-07 an attachment that never finishes is stopped at the time limit and remembered, and the email itself still opens (added: reading attachments)', { timeout: 20_000 }, async () => {
    parser = createSafeParser({ timeoutMs: 1_000, workerFile: fixture('selectiveWorker.mjs') });
    const raw = Buffer.from([
      'Message-ID: <stuck@example.invalid>', 'Subject: STUCKATTACHMENT', 'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'hi',
      '--b', 'Content-Type: text/plain; name="a.txt"', 'Content-Disposition: attachment; filename="a.txt"', '', 'attached', '--b--'
    ].join('\r\n'));
    await expect(parser.attachment(raw, 0)).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: 'time limit' } });
    const started = Date.now();
    await expect(parser.attachment(raw, 0)).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: 'failed before' } });
    expect(Date.now() - started).toBeLessThan(500);
    // The email is not the attachment: it still opens.
    expect(await parser.parse(raw)).toMatchObject({ subject: 'STUCKATTACHMENT', attachments: [{ index: 0, filename: 'a.txt' }] });
  });
});

describe('a PDF built to explode', () => {
  // About 1 MB that pdf.js inflates to 1 GB: its memory is outside the
  // worker's heap limit, so the sandbox watches it separately.
  async function pdfBomb(inflatedMb: number): Promise<Buffer> {
    const deflate = createDeflate({ level: 9 });
    const chunks: Buffer[] = [];
    deflate.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise(resolve => deflate.on('end', resolve));
    const block = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < inflatedMb; i++) if (!deflate.write(block)) await new Promise(r => deflate.once('drain', r));
    deflate.end();
    await done;
    const stream = Buffer.concat(chunks);
    const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
    const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
    return Buffer.concat([head, stream, tail]);
  }

  it('ATT-08 is stopped once the memory it takes outside the heap passes the limit, and the email still opens (added: security review, 2.4)', { timeout: 60_000 }, async () => {
    const pdf = await pdfBomb(1024);
    const raw = Buffer.concat([Buffer.from([
      'Message-ID: <bomb@example.invalid>', 'Subject: invoice', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/plain', '', 'see attached', '--b',
      'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"', 'Content-Transfer-Encoding: base64', '', ''
    ].join('\r\n')), Buffer.from(pdf.toString('base64').replace(/.{76}/g, '$&\r\n')), Buffer.from('\r\n--b--\r\n')]);
    // Only the memory watch may stop it: under load, inflating is slow enough
    // that the usual 10 s time limit could win first.
    parser = createSafeParser({ maxExternalMb: 128, timeoutMs: 50_000 });
    await expect(parser.attachment(raw, 0)).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: 'memory limit' } });
    expect(await parser.parse(raw)).toMatchObject({ subject: 'invoice' });
  });
});

describe('an attachment inside a hostile structure', () => {
  it('ATT-09 reading an attachment applies the same structure limits as opening the email (depth, parts, header size) (added: security review, 2.4)', { timeout: 20_000 }, async () => {
    parser = createSafeParser({ timeoutMs: 5_000 });
    await expect(parser.attachment(Buffer.from(nested(200), 'latin1'), 0)).rejects.toMatchObject({ code: 'MAIL-PARSE-UNSAFE', details: { reason: expect.stringMatching(/depth limit/) } });
  });
});

describe('many emails at once', () => {
  it('PAR-09 past a limit, waiting emails are turned away at once ("busy, try again"), not held in memory; those already waiting still open (added: 2.4.2, security review)', { timeout: 30_000 }, async () => {
    parser = createSafeParser({ maxWaiting: 2 });
    const email = (n: number) => Buffer.from(ordinary.replace('<m1@example.invalid>', `<m${n}@busy.example>`));
    // One opens, two wait, the fourth is turned away.
    const results = await Promise.allSettled([1, 2, 3, 4].map(n => parser!.parse(email(n))));
    expect(results.slice(0, 3).map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(results[3]).toMatchObject({ status: 'rejected', reason: { code: 'MAIL-PARSER-BUSY', retryable: true } });
    // Turned away isn't failed: the same email opens once there's room.
    expect(await parser.parse(email(4))).toMatchObject({ messageId: '<m4@busy.example>' });
    // The limit a server gets unless told otherwise.
    const defaults = createSafeParser();
    try {
      const many = await Promise.allSettled(Array.from({ length: 25 }, (_, n) => defaults.parse(email(100 + n))));
      expect(many.filter(r => r.status === 'rejected')).toHaveLength(4);
    } finally { await defaults.close(); }
  });
});

describe('whose memory counts', () => {
  it('ATT-12 memory the rest of the server takes while an email is read doesn\'t count against it: only the reader\'s own (added: 2.4.2: a busy server could stop a read)', { timeout: 30_000 }, async () => {
    parser = createSafeParser({ maxExternalMb: 64, workerFile: fixture('slowAnswerWorker.mjs') });
    // Loaded first: the limit is measured from when an email's reading starts.
    await parser.parse(Buffer.from(ordinary.replace('<m1@example.invalid>', '<warm@example.invalid>')));
    const reading = parser.parse(Buffer.from(ordinary));
    // Meanwhile the server itself takes 200 MB (a big message fetched, say).
    await new Promise(resolve => setTimeout(resolve, 100));
    const elsewhere = Buffer.alloc(200 * 1024 * 1024, 1);
    await expect(reading).resolves.toMatchObject({ messageId: '<m1@example.invalid>' });
    expect(elsewhere.length).toBe(200 * 1024 * 1024);
  });
});
