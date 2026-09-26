import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';

const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

export type ComposeInput = {
  from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string;
  text?: string; html?: string; inReplyTo?: string; references?: string[];
  messageId?: string; operationId?: string;
  headers?: Record<string, string>;
};

export async function composeRaw(input: ComposeInput, keepBcc = false): Promise<{ raw: Buffer; messageId: string; operationId: string }> {
  const operationId = input.operationId ?? randomUUID();
  const messageId = input.messageId ?? `<${operationId}@yahoo-mail-mcp.local>`;
  const info = await composer.sendMail({
    from: input.from, to: input.to, cc: input.cc, bcc: keepBcc ? input.bcc : undefined, subject: input.subject,
    text: input.text, html: input.html, messageId, inReplyTo: input.inReplyTo,
    references: input.references, keepBcc,
    headers: { 'X-Yahoo-MCP-Operation-ID': operationId, ...input.headers }
  });
  return { raw: info.message as Buffer, messageId, operationId };
}
