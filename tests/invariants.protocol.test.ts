import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedTools } from '../scripts/verification-client.js';
import { startProduct, type Product } from '../testkit/src/product.js';
import { profiles, type ProfileName } from '../testkit/src/profiles.js';
import { locate, peek, seed } from '../testkit/src/seed.js';

// The safety rules, on every kind of server. Each is checked against what the
// server really holds. A fault proxy sits in front of every server, so tests
// can count commands and cut connections at chosen moments.
const shapes: ProfileName[] = ['yahoo-like', 'minimal', 'gmail-like', 'hostile'];

describe.each(shapes)('safety invariants on %s', profile => {
  const folders = profiles[profile].folders;
  const archive = folders.archive ?? folders.all!;
  const canMove = profile !== 'hostile';
  let p: Product;
  let n = 0;
  const fresh = async (count: number, mailbox = 'INBOX') => (await seed(p.server, {
    messages: Array.from({ length: count }, () => ({ mailbox, subject: `${profile} ${++n}`, from: 'friend@example.invalid' }))
  })).messages;
  // Commands the product sends while running fn.
  const commandsDuring = async (fn: () => Promise<unknown>) => {
    const before = p.proxy!.commands().length;
    await fn();
    return p.proxy!.commands().slice(before);
  };

  beforeAll(async () => {
    p = await startProduct(profile, { imapFault: {} });
    await p.ok('create_folder', { path: 'Test' });
  });
  afterAll(async () => { await p?.stop(); });

  it('INV-01 no tool marks a message read', async () => {
    const [a, b, c] = await fresh(3);
    const follow = async (tool: string, args: Record<string, unknown>) => {
      const r = await p.call(tool, args);
      return r.result.ok ? { mailbox: r.result.data.destination, uid: r.result.data.destinationUid } : { mailbox: args.mailbox, uid: args.uid };
    };
    await p.call('search_email', { mailbox: 'INBOX' });
    await p.call('get_email', { mailbox: 'INBOX', uid: a!.uid });
    await p.call('get_thread', { mailbox: 'INBOX', uid: a!.uid, allFolders: true });
    await p.call('reply_email', { newRecipientsConfirmed: true, mailbox: 'INBOX', uid: b!.uid, text: 'reply' });
    await p.call('flag_email', { mailbox: 'INBOX', uid: a!.uid, flagged: true });
    await p.call('flag_email', { mailbox: 'INBOX', uid: a!.uid, flagged: false });
    let at = await follow('move_email', { mailbox: 'INBOX', uid: c!.uid, destination: 'Test' });
    at = await follow('archive_email', at);
    at = await follow('trash_email', at);
    await follow('restore_email', at);
    const draft = await p.ok('create_draft', { to: ['friend@example.invalid'], subject: 'draft', text: 'first' });
    await p.call('update_draft', { mailbox: draft.mailbox, uid: draft.uid, text: 'second' });

    for (const message of [a!, b!, c!]) {
      const copies = await locate(p.server, message.messageId);
      expect(copies.length, message.subject).toBeGreaterThan(0);
      expect(copies.filter(copy => copy.seen), message.subject).toEqual([]);
    }
  });

  it('INV-02 no tool moves mail to a folder that does not exist under that exact name', async () => {
    const [m] = await fresh(1);
    const near = [archive.toLowerCase(), archive.toUpperCase(), `${archive} `, 'Test/', 'test', 'Nowhere'].filter(d => d !== archive);
    for (const destination of near) {
      const moved = await p.call('move_email', { mailbox: 'INBOX', uid: m!.uid, destination });
      expect(moved.result.code, destination).toBe('FOLDER_NOT_FOUND');
      const restored = await p.call('restore_email', { mailbox: 'INBOX', uid: m!.uid, destination });
      expect(restored.result.code, destination).toBe('FOLDER_NOT_FOUND');
    }
    expect((await locate(p.server, m!.messageId)).map(copy => copy.mailbox)).toEqual(['INBOX']);
  });

  it('INV-03 no change is retried without proof that the first attempt did not happen', async () => {
    // A flag change cut off after the server made it: checked, not repeated.
    const [flagged] = await fresh(1);
    p.proxy!.setRules({ dropAfter: 'UID STORE' });
    const stores = await commandsDuring(() => p.call('flag_email', { mailbox: 'INBOX', uid: flagged!.uid, flagged: true }));
    p.proxy!.setRules({});
    expect(stores.filter(c => c === 'UID STORE')).toHaveLength(1);
    expect(await locate(p.server, flagged!.messageId)).toMatchObject([{ flagged: true }]);

    // A draft saved but not confirmed: found by Message-ID, not saved twice.
    p.proxy!.setRules({ dropAfter: 'APPEND' });
    const appends = await commandsDuring(async () => {
      const draft = await p.call('create_draft', { to: ['friend@example.invalid'], subject: 'once', text: 'x' });
      expect(draft.result.code).toBe('RECOVERED');
      expect(await locate(p.server, draft.result.data.messageId)).toHaveLength(1);
    });
    p.proxy!.setRules({});
    expect(appends.filter(c => c === 'APPEND')).toHaveLength(1);

    if (!canMove) return;
    // A move cut off after the server acted: one command, never a second.
    const moveCommand = profile === 'minimal' ? 'UID COPY' : 'UID MOVE';
    const [single, ...batch] = await fresh(3);
    p.proxy!.setRules({ dropAfter: moveCommand });
    const moves = await commandsDuring(async () => {
      await p.call('move_email', { mailbox: 'INBOX', uid: single!.uid, destination: 'Test' });
      const many = await p.call('move_email', { mailbox: 'INBOX', uids: batch.map(m => m.uid), destination: 'Test' });
      expect(many.result.status).toBe('UNKNOWN');
    });
    p.proxy!.setRules({});
    expect(moves.filter(c => c === moveCommand)).toHaveLength(2);
    for (const m of [single!, ...batch]) expect(await locate(p.server, m.messageId), m.subject).toHaveLength(profile === 'minimal' ? 2 : 1);
  });

  it('INV-05 a replacement draft is saved before the original is deleted', async () => {
    const original = await p.ok('create_draft', { to: ['friend@example.invalid'], subject: 'draft', text: 'first' });
    const commands = await commandsDuring(() => p.call('update_draft', { mailbox: original.mailbox, uid: original.uid, text: 'second' }));
    const saved = commands.indexOf('APPEND');
    expect(saved).toBeGreaterThanOrEqual(0);
    const deletions = commands.map((c, i) => [c, i] as const).filter(([c]) => c === 'UID EXPUNGE' || c === 'UID STORE').map(([, i]) => i);
    for (const at of deletions) expect(at).toBeGreaterThan(saved);

    // The replacement is saved but not confirmed: the original must survive.
    const second = await p.ok('create_draft', { to: ['friend@example.invalid'], subject: 'draft 2', text: 'first' });
    p.proxy!.setRules({ dropAfter: 'APPEND' });
    await p.call('update_draft', { mailbox: second.mailbox, uid: second.uid, text: 'second' });
    p.proxy!.setRules({});
    expect(await locate(p.server, second.messageId)).toHaveLength(1);
  });

  it('INV-06 no tool can permanently delete', async () => {
    expect(expectedTools.filter(name => /delete|expunge|purge|empty|destroy/i.test(name))).toEqual([]);
    // Trashing something already in Trash leaves it there.
    const [trashed] = await fresh(1, folders.trash);
    await p.call('trash_email', { mailbox: folders.trash, uid: trashed!.uid });
    expect((await locate(p.server, trashed!.messageId)).map(copy => copy.mailbox)).toEqual([folders.trash]);
  });

  it('INV-07 every message carries untrustedContent: true', async () => {
    const [m] = await fresh(1);
    const rows = await p.ok('search_email', { mailbox: 'INBOX' }) as Array<{ untrustedContent?: boolean }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter(row => row.untrustedContent !== true)).toEqual([]);
    expect(await p.ok('get_email', { mailbox: 'INBOX', uid: m!.uid })).toMatchObject({ untrustedContent: true });
    const thread = await p.ok('get_thread', { mailbox: 'INBOX', uid: m!.uid }) as Array<{ untrustedContent?: boolean }>;
    expect(thread.filter(message => message.untrustedContent !== true)).toEqual([]);
  });
});
