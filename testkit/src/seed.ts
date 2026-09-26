import { randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import type { ImapServer } from './imapServer.js';

export type SeedMessage = {
  mailbox: string; subject: string; from?: string; to?: string; date?: Date; messageId?: string; body?: string;
  // Extra header lines, such as In-Reply-To and References for threads.
  headers?: Record<string, string>;
};
export type SeedPlan = { folders?: string[]; messages?: SeedMessage[] };
export type Seeded = { messages: Array<{ mailbox: string; uid: number; messageId: string; subject: string }> };

export function connect(server: ImapServer): ImapFlow {
  return new ImapFlow({ host: server.host, port: server.port, secure: false, auth: { user: server.user, pass: server.password }, logger: false });
}

function raw(message: SeedMessage, messageId: string): string {
  return [
    `From: ${message.from ?? 'sender@example.invalid'}`,
    `To: ${message.to ?? 'tester@example.invalid'}`,
    `Subject: ${message.subject}`,
    `Date: ${(message.date ?? new Date('2026-09-01T12:00:00Z')).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...Object.entries(message.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    message.body ?? `Body of ${message.subject}`
  ].join('\r\n');
}

export type Peeked = { uid: number; messageId?: string; subject?: string; seen: boolean; flagged: boolean };

// What a folder really holds, read-only, straight from the server: the
// yardstick for what a tool claims it did.
export async function peek(server: ImapServer, mailbox: string): Promise<Peeked[]> {
  const client = connect(server);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const rows = await client.fetchAll('1:*', { uid: true, envelope: true, flags: true }).catch(() => []);
      return rows.map(m => ({
        uid: m.uid, messageId: m.envelope?.messageId, subject: m.envelope?.subject,
        seen: Boolean(m.flags?.has('\\Seen')), flagged: Boolean(m.flags?.has('\\Flagged'))
      }));
    } finally { lock.release(); }
  } finally {
    await client.logout();
  }
}

// Every copy of a message, in whichever folders it is in.
export async function locate(server: ImapServer, messageId: string): Promise<Array<Peeked & { mailbox: string }>> {
  const client = connect(server);
  await client.connect();
  const folders = (await client.list()).filter(f => !f.flags.has('\\Noselect')).map(f => f.path);
  await client.logout();
  const found: Array<Peeked & { mailbox: string }> = [];
  for (const mailbox of folders) {
    for (const m of await peek(server, mailbox)) if (m.messageId === messageId) found.push({ ...m, mailbox });
  }
  return found;
}

// Folders first, then messages in order. A UID comes from the append reply
// when the server gives one, otherwise from a Message-ID search — so seeding
// works even on profiles that don't advertise UIDPLUS.
export async function seed(server: ImapServer, plan: SeedPlan): Promise<Seeded> {
  const client = connect(server);
  await client.connect();
  try {
    for (const folder of plan.folders ?? []) await client.mailboxCreate(folder).catch(() => undefined);
    const messages: Seeded['messages'] = [];
    for (const message of plan.messages ?? []) {
      const messageId = message.messageId ?? `<${randomUUID()}@seed.invalid>`;
      const appended = await client.append(message.mailbox, raw(message, messageId));
      let uid = appended && appended.uid;
      if (!uid) {
        const lock = await client.getMailboxLock(message.mailbox);
        try {
          const found = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
          uid = Array.isArray(found) ? found[0] : undefined;
        } finally { lock.release(); }
      }
      if (!uid) throw new Error(`Seeding could not find the UID of "${message.subject}" in ${message.mailbox}`);
      messages.push({ mailbox: message.mailbox, uid, messageId, subject: message.subject });
    }
    return { messages };
  } finally {
    await client.logout();
  }
}
