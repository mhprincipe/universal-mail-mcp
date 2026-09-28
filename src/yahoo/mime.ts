import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';

const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

export type ComposeInput = {
  from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string;
  text?: string; html?: string; inReplyTo?: string; references?: string[];
  messageId?: string; operationId?: string;
  headers?: Record<string, string>;
};

// The Message-ID uses the sender's own domain, as mail apps do (ENG-19: it
// used to say yahoo-mail-mcp.local, version 1's name, to every recipient).
const senderDomain = (from: string) => /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/.exec(from)?.[1]?.toLowerCase() ?? 'universal-mail.invalid';

export async function composeRaw(input: ComposeInput, keepBcc = false): Promise<{ raw: Buffer; messageId: string; operationId: string }> {
  const operationId = input.operationId ?? randomUUID();
  const messageId = input.messageId ?? `<${operationId}@${senderDomain(input.from)}>`;
  const info = await composer.sendMail({
    from: input.from, to: input.to, cc: input.cc, bcc: keepBcc ? input.bcc : undefined, subject: input.subject,
    text: input.text, html: input.html, messageId, inReplyTo: input.inReplyTo,
    references: input.references, keepBcc,
    headers: { 'X-Universal-Mail-Operation-ID': operationId, ...input.headers }
  });
  return { raw: info.message as Buffer, messageId, operationId };
}
