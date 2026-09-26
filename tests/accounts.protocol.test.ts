import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startImapServer, type ImapServer } from '../testkit/src/imapServer.js';
import { startMultiProduct, type MultiProduct } from '../testkit/src/product.js';
import { peek, seed } from '../testkit/src/seed.js';

// Five accounts across three kinds of server. personal and work share a
// server but not a mailbox; broken has the wrong password.
let yahooLike: ImapServer;
let minimal: ImapServer;
let hostile: ImapServer;
let product: MultiProduct;
const as = (server: ImapServer, user: string) => ({ ...server, user });
const working = () => ({
  personal: as(yahooLike, 'personal@example.invalid'),
  work: as(yahooLike, 'work@example.invalid'),
  family: as(minimal, 'family@example.invalid'),
  old: as(hostile, 'old@example.invalid')
});

beforeAll(async () => {
  [yahooLike, minimal, hostile] = await Promise.all([startImapServer('yahoo-like'), startImapServer('minimal'), startImapServer('hostile')]);
  // One message per account, each UID 1, so any mix-up between accounts shows.
  for (const [name, server] of Object.entries(working())) {
    await seed(server, { messages: [{ mailbox: 'INBOX', subject: `hello ${name}`, date: new Date('2026-09-10T12:00:00Z') }] });
  }
  product = await startMultiProduct([
    ...Object.entries(working()).map(([name, server]) => ({ name, server, user: server.user })),
    { name: 'broken', server: yahooLike, user: 'broken@example.invalid', password: 'not-the-password' }
  ]);
});
afterAll(async () => {
  await product?.stop();
  await Promise.all([yahooLike, minimal, hostile].map(s => s?.stop()));
});

describe('five accounts on real servers', () => {
  it('PRO-06 accounts stay isolated, and one broken account does not affect the others', async () => {
    // Search with no account covers every account and says which each result is from.
    const found = await product.call('search_email', { mailbox: 'INBOX' });
    expect(found.result.ok).toBe(true);
    expect((found.result.data as Array<{ account: string; subject: string }>).map(m => `${m.account}: ${m.subject}`).sort())
      .toEqual(['family: hello family', 'old: hello old', 'personal: hello personal', 'work: hello work']);
    expect(found.result.warnings).toEqual([expect.stringMatching(/^Couldn't search broken: /)]);

    // Same UID, different accounts, different messages.
    expect(await product.ok('get_email', { account: 'work', mailbox: 'INBOX', uid: 1 })).toMatchObject({ subject: 'hello work' });
    expect(await product.ok('get_email', { account: 'personal', mailbox: 'INBOX', uid: 1 })).toMatchObject({ subject: 'hello personal' });

    // A move in one account changes only that account.
    await product.ok('archive_email', { account: 'family', mailbox: 'INBOX', uid: 1 });
    const accounts = working();
    expect((await peek(accounts.family, 'Archive')).map(m => m.subject)).toEqual(['hello family']);
    for (const name of ['personal', 'work', 'old'] as const) {
      expect((await peek(accounts[name], 'INBOX')).map(m => m.subject), name).toEqual([`hello ${name}`]);
      expect(await peek(accounts[name], 'Archive'), name).toEqual([]);
    }

    // Each account keeps its own server's rules: old's server can't move safely.
    expect((await product.call('archive_email', { account: 'old', mailbox: 'INBOX', uid: 1 })).result.code).toBe('SAFE_MOVE_UNAVAILABLE');

    // The broken account fails on its own; the next request elsewhere is fine.
    expect((await product.call('get_email', { account: 'broken', mailbox: 'INBOX', uid: 1 })).result.code).toBe('AUTH_FAILED');
    expect(await product.ok('get_email', { account: 'personal', mailbox: 'INBOX', uid: 1 })).toMatchObject({ subject: 'hello personal' });

    // Five accounts: a tool that needs one says so, listing them.
    expect((await product.call('list_folders')).result).toMatchObject({
      code: 'MAIL-ACCOUNT-REQUIRED', message: 'Say which account to use: broken, family, old, personal, work.'
    });
  });
});
