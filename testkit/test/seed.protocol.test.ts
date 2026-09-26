import { describe, expect, it } from 'vitest';
import { startImapServer } from '../src/imapServer.js';
import { connect, seed } from '../src/seed.js';

// TK-03: tests arrange real mailboxes in one call, and every profile has the
// special folders a real provider advertises.
describe('TK-03 seeding helper', () => {
  it('creates folders and messages, returns their UIDs, and the profile special folders exist', async () => {
    const server = await startImapServer('yahoo-like');
    try {
      const seeded = await seed(server, {
        folders: ['Receipts'],
        messages: [{ mailbox: 'INBOX', subject: 'first' }, { mailbox: 'Receipts', subject: 'second' }]
      });
      expect(seeded.messages.map(m => [m.mailbox, m.subject, typeof m.uid])).toEqual([
        ['INBOX', 'first', 'number'],
        ['Receipts', 'second', 'number']
      ]);

      const client = connect(server);
      await client.connect();
      try {
        const specialUse = Object.fromEntries((await client.list()).filter(f => f.specialUse).map(f => [f.specialUse, f.path]));
        // ImapFlow marks INBOX as \Inbox itself; the rest come from the profile.
        expect(specialUse).toEqual({ '\\Inbox': 'INBOX', '\\Sent': 'Sent', '\\Drafts': 'Draft', '\\Archive': 'Archive', '\\Junk': 'Bulk', '\\Trash': 'Trash' });

        const receipts = seeded.messages[1]!;
        const lock = await client.getMailboxLock('Receipts');
        try {
          const message = await client.fetchOne(String(receipts.uid), { envelope: true }, { uid: true });
          expect(message && message.envelope?.subject).toBe('second');
          expect(message && message.envelope?.messageId).toBe(receipts.messageId);
        } finally { lock.release(); }
      } finally { await client.logout(); }
    } finally {
      await server.stop();
    }
  });
});
