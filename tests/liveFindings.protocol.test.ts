import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProduct, type Product } from '../testkit/src/product.js';
import { locate, seed } from '../testkit/src/seed.js';

// The owner's full live run (2026-09-28), on a real mail server (Dovecot,
// Yahoo's layout) behind the fault proxy, which can blank header searches the
// way Yahoo did.
describe('what the full live run found, on a real mail server', () => {
  let p: Product;
  beforeAll(async () => {
    p = await startProduct('yahoo-like', { imapFault: {} });
    await p.ok('create_folder', { path: 'Universal Mail test' });
  });
  afterAll(async () => { await p?.stop(); });

  it('ENG-20 a batch move asked in any order reports each message\'s own new UID (added: found live)', async () => {
    const seeded = (await seed(p.server, { messages: ['one', 'two', 'three'].map(subject => ({ mailbox: 'INBOX', subject })) })).messages;
    const [a, b, c] = seeded;
    const moved = await p.ok('trash_email', { mailbox: 'INBOX', uids: [c!.uid, a!.uid, b!.uid] });
    for (const message of seeded) {
      const pair = moved.moved.find((m: { sourceUid: number }) => m.sourceUid === message.uid);
      const [where] = await locate(p.server, message.messageId);
      expect(where!.mailbox, message.subject).toBe('Trash');
      expect(pair.destinationUid, message.subject).toBe(where!.uid);
    }
  });

  it('ENG-21 re-finding a message by Message-ID after a move works even when header search finds nothing (added: found live)', async () => {
    const [m] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'to move' }] })).messages;
    p.proxy!.setRules({ blankHeaderSearch: true });
    try {
      const moved = await p.ok('move_email', { mailbox: 'INBOX', uid: m!.uid, destination: 'Universal Mail test' });
      const found = await p.ok('search_email', { mailbox: 'Universal Mail test', messageId: m!.messageId });
      expect(found.map((r: { uid: number }) => r.uid)).toEqual([moved.destinationUid]);
      // And trash_email's own re-find (the batch path) still confirms its pairs.
      const trashed = await p.ok('trash_email', { mailbox: 'Universal Mail test', uids: [moved.destinationUid] });
      const [where] = await locate(p.server, m!.messageId);
      expect(trashed.moved[0].destinationUid).toBe(where!.uid);
    } finally { p.proxy!.setRules({}); }
  });

  it('ENG-19 what Universal Mail writes carries no References header of its own: the ".ref" ones seen live were added by Yahoo', async () => {
    const draft = await p.ok('create_draft', { to: ['friend@example.invalid'], subject: 'plain draft', text: 'first' });
    const updated = await p.ok('update_draft', { mailbox: draft.mailbox, uid: draft.uid, text: 'second' });
    const opened = await p.ok('get_email', { mailbox: updated.mailbox, uid: updated.uid });
    expect(opened.references).toEqual([]);
    await p.ok('send_email', { to: ['friend@example.invalid'], subject: 'plain send', text: 'hello' });
    const sent = p.smtp.messages.at(-1)!.raw.toString('utf8');
    expect(sent).not.toMatch(/^References:/im);
    expect(sent).not.toMatch(/\.ref@/i);
  });
});
