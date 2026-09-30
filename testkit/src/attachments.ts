import JSZip from 'jszip';
import nodemailer from 'nodemailer';

// Real attachments, made here rather than stored as binary fixtures: a PDF
// with one line of text, a Word document with one paragraph, a 1x1 PNG, and
// the email that carries them.

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// A one-page PDF showing `text` in Helvetica: the smallest file a real PDF
// reader (pdf.js) opens.
export function pdfOf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A Word document with one paragraph.
export async function docxOf(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// A 1x1 transparent PNG.
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export type TestAttachment = { filename?: string; contentType: string; content: string | Buffer };

// Made when this module loads, so a test's fake mail transport (the tool
// fixture replaces nodemailer's) never stands in for it.
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });

// An email from someone else, with these attachments in this order.
export async function messageWithAttachments(attachments: TestAttachment[], fields: { subject?: string; messageId?: string } = {}): Promise<Buffer> {
  const info = await composer.sendMail({
    from: 'sender@example.invalid', to: 'self@example.invalid', subject: fields.subject ?? 'With attachments',
    messageId: fields.messageId ?? `<att-${Math.random().toString(36).slice(2)}@fixture.invalid>`,
    text: 'See attached.',
    attachments: attachments.map(a => ({ ...(a.filename ? { filename: a.filename } : {}), contentType: a.contentType, content: a.content }))
  });
  return info.message as Buffer;
}
