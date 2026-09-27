import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
export async function composeRaw(input, keepBcc = false) {
    const operationId = input.operationId ?? randomUUID();
    const messageId = input.messageId ?? `<${operationId}@yahoo-mail-mcp.local>`;
    const info = await composer.sendMail({
        from: input.from, to: input.to, cc: input.cc, bcc: keepBcc ? input.bcc : undefined, subject: input.subject,
        text: input.text, html: input.html, messageId, inReplyTo: input.inReplyTo,
        references: input.references, keepBcc,
        headers: { 'X-Yahoo-MCP-Operation-ID': operationId, ...input.headers }
    });
    return { raw: info.message, messageId, operationId };
}
//# sourceMappingURL=mime.js.map