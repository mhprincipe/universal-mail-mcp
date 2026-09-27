import { randomUUID } from 'node:crypto';
// System emails (sign-in codes, notices, alerts) are invisible to the AI in
// every folder (design §6.5, red team S1). They're recognised by a Message-ID
// the server generates under a reserved domain, which every tool already
// fetches. Not by searching their X-Universal-Mail header: Yahoo's header
// search returns nothing, so a "NOT header" filter would show everything.
export const SYSTEM_DOMAIN = 'system.universal-mail.invalid';
export const systemMessageId = () => `<${randomUUID()}@${SYSTEM_DOMAIN}>`;
export const isSystemMessageId = (messageId) => typeof messageId === 'string' && messageId.toLowerCase().endsWith(`@${SYSTEM_DOMAIN}>`);
//# sourceMappingURL=systemMail.js.map