import { convert } from 'html-to-text';
import mammoth from 'mammoth';
import { simpleParser } from 'mailparser';
import { extractText, getDocumentProxy } from 'unpdf';
import { checkStructure, defaultLimits } from "./parseCore.js";
// An image over this isn't passed to the AI: a picture that size is rarely a
// receipt or a screenshot, and it would crowd out the conversation.
export const MAX_IMAGE_BYTES = 3_000_000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function decode(content, charset) {
    try {
        return new TextDecoder(charset || 'utf-8').decode(content);
    }
    catch {
        return new TextDecoder('utf-8').decode(content);
    }
}
export async function readAttachment(raw, index) {
    // The email's structure limits first, as when it's opened (ATT-09).
    await checkStructure(raw, defaultLimits);
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    const attachment = (parsed.attachments ?? [])[index];
    if (!attachment)
        return undefined;
    const filename = attachment.filename || undefined;
    const base = { ...(filename ? { filename } : {}), contentType: attachment.contentType, size: attachment.size };
    // For the generic "octet-stream" many mail apps send, the parser has already
    // named the type from the file's name (scan.pdf: application/pdf).
    const type = attachment.contentType.toLowerCase().split(';')[0].trim();
    const content = attachment.content;
    try {
        if (type === 'text/html') {
            // Words only: no scripts, no styles, no link targets or image addresses.
            return { ...base, kind: 'text', text: convert(decode(content, undefined), { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] }) };
        }
        if (type.startsWith('text/') || type === 'application/json' || type === 'application/csv') {
            const charset = attachment.headers?.get('content-type')?.params?.charset;
            return { ...base, kind: 'text', text: decode(content, charset) };
        }
        if (type === 'application/pdf') {
            // Text only: no system fonts, nothing fetched (fonts, character maps),
            // no images decoded. (pdf.js 6 no longer evaluates code from fonts.)
            const document = await getDocumentProxy(new Uint8Array(content), { useSystemFonts: false, useWorkerFetch: false, maxImageSize: 1 });
            const { text } = await extractText(document, { mergePages: true });
            return { ...base, kind: 'text', text: String(text) };
        }
        if (type === DOCX) {
            return { ...base, kind: 'text', text: (await mammoth.extractRawText({ buffer: content })).value };
        }
        if (IMAGES.has(type)) {
            if (content.length > MAX_IMAGE_BYTES)
                return { ...base, kind: 'unsupported', reason: 'too large to show' };
            return { ...base, contentType: type, kind: 'image', image: content.toString('base64') };
        }
        return { ...base, kind: 'unsupported' };
    }
    catch {
        // Damaged or protected: said so, never a crash.
        return { ...base, kind: 'unreadable' };
    }
}
//# sourceMappingURL=attachmentCore.js.map