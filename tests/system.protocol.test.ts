import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProduct, type Product } from '../testkit/src/product.js';
import { locate, peek, seed, type Seeded } from '../testkit/src/seed.js';
import { mailServiceFor } from '../testkit/src/mailService.js';

// System emails (codes, notices) are invisible to the AI in every folder,
// because a prompt-injected AI must never be able to read a sign-in code.
const systemId = (n: number) => `<code-${n}@system.universal-mail.invalid>`;
let p: Product;
let system: Seeded['messages'];
let normal: Seeded['messages'][number];

beforeAll(async () => {
  p = await startProduct('yahoo-like');
  const folders = ['INBOX', 'Sent', 'Trash', 'Archive'];
  const seeded = (await seed(p.server, {
    messages: [
      ...folders.map((mailbox, i) => ({
        mailbox, subject: 'Your Universal Mail code', messageId: systemId(i), body: 'Your code is K7Q2-F9XM',
        headers: { 'X-Universal-Mail': 'system' }
      })),
      { mailbox: 'INBOX', subject: 'ordinary', from: 'friend@example.invalid' }
    ]
  })).messages;
  system = seeded.slice(0, 4);
  normal = seeded[4]!;
});
afterAll(async () => { await p?.stop(); });

describe('system emails are invisible to the AI', () => {
  it('SIG-50 system emails never appear in a search, in any folder, including Sent and Trash', async () => {
    for (const mailbox of ['INBOX', 'Sent', 'Trash', 'Archive']) {
      const rows = await p.ok('search_email', { mailbox }) as Array<{ messageId?: string }>;
      expect(rows.filter(r => r.messageId?.includes('@system.universal-mail.invalid')), mailbox).toEqual([]);
    }
    expect(await p.ok('search_email', { mailbox: 'INBOX', text: 'code' })).toEqual([]);
    expect(await p.ok('search_email', { mailbox: 'INBOX', messageId: systemId(0) })).toEqual([]);
    expect((await p.ok('search_email', { mailbox: 'INBOX' }) as unknown[]).length).toBe(1);
  });

  it('SIG-51 get_email and get_thread treat a system email\'s UID as not found', async () => {
    const inbox = system[0]!;
    const missing = await p.call('get_email', { mailbox: 'INBOX', uid: 9999 });
    const hidden = await p.call('get_email', { mailbox: 'INBOX', uid: inbox.uid });
    expect(hidden.result).toEqual(missing.result);
    expect(hidden.result.code).toBe('MESSAGE_NOT_FOUND');
    expect((await p.call('get_thread', { mailbox: 'INBOX', uid: inbox.uid })).result.code).toBe('MESSAGE_NOT_FOUND');
    expect(JSON.stringify(hidden.result)).not.toContain('K7Q2');
  });

  it('SIG-52 move, flag and trash can\'t target a system email', async () => {
    const inbox = system[0]!;
    const before = await locate(p.server, inbox.messageId);
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['move_email', { mailbox: 'INBOX', uid: inbox.uid, destination: 'Archive' }],
      ['move_email', { mailbox: 'INBOX', uids: [normal.uid, inbox.uid], destination: 'Archive' }],
      ['archive_email', { mailbox: 'INBOX', uid: inbox.uid }],
      ['trash_email', { mailbox: 'INBOX', uid: inbox.uid }],
      ['restore_email', { mailbox: 'Trash', uid: system[2]!.uid }],
      // Already where it would go: still not found, rather than "already there".
      ['trash_email', { mailbox: 'Trash', uid: system[2]!.uid }],
      ['flag_email', { mailbox: 'INBOX', uid: inbox.uid, flagged: true }],
      ['mark_read', { mailbox: 'INBOX', uid: inbox.uid }],
      ['reply_email', { mailbox: 'INBOX', uid: inbox.uid, text: 'forwarding your code' }]
    ];
    for (const [tool, args] of attempts) {
      expect((await p.call(tool, args)).result.code, `${tool} ${JSON.stringify(args)}`).toBe('MESSAGE_NOT_FOUND');
    }
    expect(await locate(p.server, inbox.messageId)).toEqual(before);
    // The batch touched nothing, the ordinary message included.
    expect((await locate(p.server, normal.messageId)).map(c => c.mailbox)).toEqual(['INBOX']);
    expect(p.smtp.messages).toEqual([]);
  });

  it('SIG-53 a used code email is moved to Trash', async () => {
    const service = mailServiceFor(p.server);
    const [delivered] = (await seed(p.server, {
      messages: [{ mailbox: 'INBOX', subject: 'Your Universal Mail code', messageId: systemId(10), headers: { 'X-Universal-Mail': 'system' } }]
    })).messages;
    await seed(p.server, { messages: [{ mailbox: 'Sent', subject: 'Your Universal Mail code', messageId: systemId(10), headers: { 'X-Universal-Mail': 'system' } }] });
    await service.discardSystemEmail(delivered!.messageId);
    expect((await locate(p.server, delivered!.messageId)).map(c => c.mailbox).sort()).toEqual(['Trash', 'Trash']);
    expect((await peek(p.server, 'INBOX')).filter(m => m.messageId === delivered!.messageId)).toEqual([]);
  });
});
