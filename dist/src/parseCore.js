import { Splitter } from '@zone-eu/mailsplit';
import { simpleParser } from 'mailparser';
function addresses(value) {
    const groups = Array.isArray(value) ? value : value ? [value] : [];
    return groups.flatMap((group) => group?.value ?? [])
        .filter((x) => x?.address)
        .map((x) => ({ name: x.name || undefined, address: x.address }));
}
function normalizeRefs(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value.map(String).filter(Boolean);
    return String(value).match(/<[^>]+>/g) ?? [];
}
// Far above real mail (forwarded chains rarely nest past ten), far below what
// hurts: the parser stops at these before building anything.
export const defaultLimits = { maxDepth: 50, maxParts: 1000, maxHeaderBytes: 256 * 1024 };
export class ParseLimitExceeded extends Error {
    limit;
    constructor(limit) {
        super(`MIME ${limit} limit exceeded`);
        this.limit = limit;
    }
}
// A first pass with the same splitter mailparser uses. It enforces the three
// limits while holding only the MIME structure, not the content.
function checkStructure(raw, limits) {
    return new Promise((resolve, reject) => {
        const splitter = new Splitter({ maxHeadSize: limits.maxHeaderBytes, maxChildNodes: limits.maxParts });
        splitter.on('data', (chunk) => {
            if (chunk.type !== 'node')
                return;
            let depth = 0;
            for (let node = chunk.parentNode; node; node = node.parentNode)
                depth++;
            if (depth > limits.maxDepth)
                splitter.destroy(new ParseLimitExceeded('depth'));
        });
        // The splitter is a Transform stream at runtime (it extends Transform), but
        // mailsplit's declarations narrow its events to 'data' only, which makes it
        // incompatible with Node's stream types. Hence the cast, in this one place.
        const stream = splitter;
        stream.on('error', (error) => {
            if (error.code !== 'EMAXLEN')
                return reject(error);
            reject(new ParseLimitExceeded(/child nodes/.test(error.message) ? 'parts' : 'header size'));
        });
        stream.on('end', () => resolve());
        stream.end(raw);
    });
}
// The same fields and mapping v1's getEmail produced, as plain data that can
// cross a thread boundary. Attachment bytes are left behind.
export async function parseMessage(raw, limits = defaultLimits) {
    await checkStructure(raw, limits);
    // An email with only HTML gets its text made from that HTML (PAR-08, found
    // live: "text" came back empty for newsletters). Its own text part, when it
    // has one, is kept as it is. This runs in the parse worker, under its limits.
    const parsed = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true });
    return {
        messageId: parsed.messageId || undefined,
        subject: parsed.subject || undefined,
        from: addresses(parsed.from), to: addresses(parsed.to), cc: addresses(parsed.cc), bcc: addresses(parsed.bcc),
        replyTo: addresses(parsed.replyTo),
        text: parsed.text || undefined,
        html: typeof parsed.html === 'string' ? parsed.html : undefined,
        inReplyTo: parsed.inReplyTo || undefined,
        references: normalizeRefs(parsed.references),
        attachments: (parsed.attachments ?? []).map(a => ({
            filename: a.filename || undefined, contentType: a.contentType, size: a.size, contentId: a.contentId || undefined
        }))
    };
}
//# sourceMappingURL=parseCore.js.map