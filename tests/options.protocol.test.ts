import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProduct, type Product } from '../testkit/src/product.js';
import { seed } from '../testkit/src/seed.js';

// 2.4.6 on a real mail server (Dovecot, Yahoo's layout): the three new options
// and the direct check, through the tools, over the wire.
describe('2.4.6 on a real mail server', () => {
  let p: Product;
  beforeAll(async () => { p = await startProduct('yahoo-like'); });
  afterAll(async () => { await p?.stop(); });

  it('BLK-01 matching moves what a search finds, and only that (added: 2.4.6)', async () => {
    await seed(p.server, { folders: ['Bulk', 'Bulk done'], messages: [
      { mailbox: 'Bulk', subject: 'Weekly digest 1' }, { mailbox: 'Bulk', subject: 'Lunch?' }, { mailbox: 'Bulk', subject: 'weekly DIGEST 2' }
    ] });
    const { result } = await p.call('move_email', { mailbox: 'Bulk', destination: 'Bulk done', matching: { subject: 'weekly digest' } });
    expect(result).toMatchObject({ ok: true, matched: { count: 2, more: false } });
    expect((await p.ok('search_email', { mailbox: 'Bulk' })).map((m: { subject: string }) => m.subject)).toEqual(['Lunch?']);
    expect((await p.ok('search_email', { mailbox: 'Bulk done' })).map((m: { subject: string }) => m.subject).sort()).toEqual(['Weekly digest 1', 'weekly DIGEST 2']);
  });

  it('FND-10 one search over every folder finds mail in each, naming its folder, and leaves out Trash (added: 2.4.6)', async () => {
    await seed(p.server, { folders: ['Everywhere A', 'Everywhere B'], messages: [
      { mailbox: 'Everywhere A', subject: 'Pelican report' }, { mailbox: 'Everywhere B', subject: 'Pelican report, again' },
      { mailbox: 'Trash', subject: 'Pelican report, binned' }
    ] });
    const found = await p.ok('search_email', { allFolders: true, subject: 'pelican' });
    expect(found.map((m: { mailbox: string }) => m.mailbox).sort()).toEqual(['Everywhere A', 'Everywhere B']);
  });

  it('FND-08 on a real server whose search finds everything, the direct check adds nothing twice (added: 2.4.6)', async () => {
    await seed(p.server, { folders: ['Twice'], messages: [
      { mailbox: 'Twice', subject: 'From the club', from: 'news@club.example' }, { mailbox: 'Twice', subject: 'Other', from: 'shop@store.example' },
      { mailbox: 'Twice', subject: 'From the club again', from: 'news@club.example' }
    ] });
    const found = await p.ok('search_email', { mailbox: 'Twice', from: 'club.example' });
    expect(found.map((m: { subject: string }) => m.subject)).toEqual(['From the club again', 'From the club']);
  });

  it('FOL-01 counts come from the server: messages and unread per folder (added: 2.4.6)', async () => {
    const { messages } = await seed(p.server, { folders: ['Counted'], messages: [
      { mailbox: 'Counted', subject: 'a' }, { mailbox: 'Counted', subject: 'b' }, { mailbox: 'Counted', subject: 'c' }
    ] });
    await p.ok('mark_read', { mailbox: 'Counted', uid: messages[0]!.uid });
    const folders = await p.ok('list_folders', { counts: true });
    expect(folders.find((x: { path: string }) => x.path === 'Counted')).toMatchObject({ messages: 3, unread: 2 });
  });
});
