import type { Transform } from 'node:stream';
import { Splitter } from '@zone-eu/mailsplit';
import { simpleParser } from 'mailparser';
import type { Address } from './types.js';

// Runs inside the parse worker, which Node loads without compiling it, so this
// file uses only syntax that type-stripping can erase and imports only packages.

export type ParsedMessage = {
  messageId?: string; subject?: string;
  from: Address[]; to: Address[]; cc: Address[]; bcc: Address[]; replyTo: Address[];
  text?: string; html?: string;
  inReplyTo?: string; references: string[];
  attachments: Array<{ filename?: string; contentType: string; size: number; contentId?: string }>;
};

function addresses(value: any): Address[] {
  const groups = Array.isArray(value) ? value : value ? [value] : [];
  return groups.flatMap((group: any) => group?.value ?? [])
    .filter((x: any) => x?.address)
    .map((x: any) => ({ name: x.name || undefined, address: x.address }));
}

function normalizeRefs(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).match(/<[^>]+>/g) ?? [];
}

export type ParseLimits = { maxDepth: number; maxParts: number; maxHeaderBytes: number };
// Far above real mail (forwarded chains rarely nest past ten), far below what
// hurts: the parser stops at these before building anything.
export const defaultLimits: ParseLimits = { maxDepth: 50, maxParts: 1000, maxHeaderBytes: 256 * 1024 };

export class ParseLimitExceeded extends Error {
  readonly limit: 'depth' | 'parts' | 'header size';
  constructor(limit: 'depth' | 'parts' | 'header size') {
    super(`MIME ${limit} limit exceeded`);
    this.limit = limit;
  }
}

// A first pass with the same splitter mailparser uses. It enforces the three
// limits while holding only the MIME structure, not the content.
function checkStructure(raw: Buffer, limits: ParseLimits): Promise<void> {
  return new Promise((resolve, reject) => {
    const splitter = new Splitter({ maxHeadSize: limits.maxHeaderBytes, maxChildNodes: limits.maxParts });
    splitter.on('data', (chunk: { type: string; parentNode?: unknown }) => {
      if (chunk.type !== 'node') return;
      let depth = 0;
      for (let node = chunk.parentNode as { parentNode?: unknown } | undefined; node; node = node.parentNode as typeof node) depth++;
      if (depth > limits.maxDepth) splitter.destroy(new ParseLimitExceeded('depth'));
    });
    // The splitter is a Transform stream at runtime (it extends Transform), but
    // mailsplit's declarations narrow its events to 'data' only, which makes it
    // incompatible with Node's stream types. Hence the cast, in this one place.
    const stream = splitter as unknown as Transform;
    stream.on('error', (error: Error & { code?: string }) => {
      if (error.code !== 'EMAXLEN') return reject(error);
      reject(new ParseLimitExceeded(/child nodes/.test(error.message) ? 'parts' : 'header size'));
    });
    stream.on('end', () => resolve());
    stream.end(raw);
  });
}

// The same fields and mapping v1's getEmail produced, as plain data that can
// cross a thread boundary. Attachment bytes are left behind.
export async function parseMessage(raw: Buffer, limits: ParseLimits = defaultLimits): Promise<ParsedMessage> {
  await checkStructure(raw, limits);
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
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
