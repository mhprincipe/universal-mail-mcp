import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProduct, type Product } from '../testkit/src/product.js';
import { locate, seed } from '../testkit/src/seed.js';

// ENG-18 on a real mail server (Dovecot, Yahoo's folder layout), through the
// fault proxy, which records every command: a whole session of different
// tools logs in once; read-only and read-write folders alternate on the one
// connection and nothing is marked read; a connection the network cut is
// replaced and the next call works.
describe('one connection, on a real mail server', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like', { imapFault: {} }); });
  afterAll(async () => { await p?.stop(); });

  const logins = () => p.proxy!.commands().filter(c => c === 'LOGIN' || c === 'AUTHENTICATE').length;

  it('ENG-18 a session of fifteen different calls logs in once, and marks nothing read (added: found in the live baseline)', async () => {
    const [a, b] = (await seed(p.server, { messages: [{ mailbox: 'INBOX', subject: 'one' }, { mailbox: 'INBOX', subject: 'two' }] })).messages;
    const before = logins();
    await p.ok('list_folders');
    await p.ok('create_folder', { path: 'Session' });
    await p.ok('search_email', { mailbox: 'INBOX', limit: 5 });
    await p.ok('get_email', { mailbox: 'INBOX', uid: a!.uid });
    await p.ok('get_thread', { mailbox: 'INBOX', uid: a!.uid });
    await p.ok('flag_email', { mailbox: 'INBOX', uid: a!.uid, flagged: true });
    await p.ok('flag_email', { mailbox: 'INBOX', uid: a!.uid, flagged: false });
    await p.ok('mark_unread', { mailbox: 'INBOX', uids: [a!.uid, b!.uid] });
    const moved = await p.ok('move_email', { mailbox: 'INBOX', uid: b!.uid, destination: 'Session' });
    await p.ok('search_email', { mailbox: 'Session', messageId: b!.messageId });
    const archived = await p.ok('archive_email', { mailbox: 'Session', uid: moved.destinationUid });
    await p.ok('restore_email', { mailbox: archived.destination, uid: archived.destinationUid, destination: 'INBOX' });
    const draft = await p.ok('create_draft', { to: ['friend@example.invalid'], subject: 'session draft', text: 'first' });
    await p.ok('update_draft', { mailbox: draft.mailbox, uid: draft.uid, text: 'second' });
    await p.ok('get_email', { mailbox: 'INBOX', uid: a!.uid });
    expect(logins() - before).toBe(1);
    for (const message of [a!, b!]) {
      const copies = await locate(p.server, message.messageId);
      expect(copies.length, message.subject).toBeGreaterThan(0);
      expect(copies.filter(copy => copy.seen), message.subject).toEqual([]);
    }
  });

  it('ENG-18 when the network cuts the kept connection, the next call logs in again and works', async () => {
    await p.ok('list_folders');
    const before = logins();
    // The proxy cuts the connection at the next search, mid-call: that read is retried on a fresh connection.
    p.proxy!.setRules({ dropAfter: 'UID SEARCH' });
    const found = await p.call('search_email', { mailbox: 'INBOX', limit: 1 });
    p.proxy!.setRules({});
    expect(found.result.ok).toBe(true);
    await p.ok('search_email', { mailbox: 'INBOX', limit: 1 });
    expect(logins() - before).toBe(1);
  });
});
