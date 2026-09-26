import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProduct, type Product } from '../testkit/src/product.js';
import { peek, seed } from '../testkit/src/seed.js';

// Phase 5, everyday polish, on a real mail server (Dovecot, Yahoo layout),
// with a proxy in between that sees every IMAP command.
let p: Product;
beforeAll(async () => {
  p = await startProduct('yahoo-like', { imapFault: {}, env: { SEARCH_TIMEOUT_MS: '1500' } });
  await seed(p.server, { folders: ['Flags', 'Paging', 'Work', 'Other1', 'Other2', 'Sorting', 'Clients', 'Family', 'Newsletters', 'Receipts'] });
}, 180_000);
afterAll(async () => { await p?.stop(); });

const between = async <T>(act: () => Promise<T>) => {
  const before = p.proxy!.commands().length;
  const value = await act();
  return { value, commands: p.proxy!.commands().slice(before), lines: p.proxy!.lines().slice(before) };
};
const uidsIn = async (mailbox: string) => (await p.ok('search_email', { mailbox, limit: 100 })).map((m: { uid: number }) => m.uid);

describe('everyday polish on a real server', () => {
  it('POL-05 mark_read, mark_unread and flag_email accept uids and send one command', async () => {
    await seed(p.server, { messages: Array.from({ length: 10 }, (_, i) => ({ mailbox: 'Flags', subject: `Flag me ${i}` })) });
    const uids = await uidsIn('Flags');
    expect(uids).toHaveLength(10);
    for (const [tool, extra, check] of [
      ['mark_read', {}, (m: { seen: boolean }) => m.seen],
      ['mark_unread', {}, (m: { seen: boolean }) => !m.seen],
      ['flag_email', { flagged: true }, (m: { flagged: boolean }) => m.flagged]
    ] as const) {
      const { commands } = await between(() => p.ok(tool, { mailbox: 'Flags', uids, ...extra }));
      expect(commands.filter(c => c === 'UID STORE'), tool).toHaveLength(1);
      expect((await peek(p.server, 'Flags')).every(check as (m: unknown) => boolean), tool).toBe(true);
    }
  });

  it('POL-06 the search cursor pages through more than 100 results with no gaps or repeats', async () => {
    await seed(p.server, { messages: Array.from({ length: 130 }, (_, i) => ({ mailbox: 'Paging', subject: `Page item ${i}` })) });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { result } = await p.call('search_email', { mailbox: 'Paging', limit: 50, ...(cursor ? { cursor } : {}) });
      seen.push(...result.data.map((m: { messageId: string }) => m.messageId));
      cursor = result.cursor;
      pages++;
      // New mail arriving between pages changes nothing about the pages after.
      if (pages === 1) await seed(p.server, { messages: [{ mailbox: 'Paging', subject: 'Arrived meanwhile' }] });
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    const all = (await peek(p.server, 'Paging')).filter(m => m.subject !== 'Arrived meanwhile').map(m => m.messageId);
    expect([...seen].sort()).toEqual([...all].sort());
  });

  it('POL-09 a slow full-text search ends with the "narrow your search" remedy, and the next search works', async () => {
    p.proxy!.setRules({ delay: { command: 'UID SEARCH', ms: 4_000 } });
    const started = Date.now();
    const { result, isError } = await p.call('search_email', { mailbox: 'Paging', text: 'needle' });
    p.proxy!.setRules({});
    expect(isError).toBe(true);
    expect(result).toMatchObject({ code: 'SEARCH_TOO_SLOW', remedy: expect.stringContaining('Narrow your search') });
    expect(Date.now() - started).toBeLessThan(3_500);
    expect((await p.call('search_email', { mailbox: 'Paging', limit: 1 })).result.ok).toBe(true);
  });

  it('POL-10 get_thread\'s full-folder scan happens only when asked for', async () => {
    const seeded = await seed(p.server, { messages: [
      { mailbox: 'Work', subject: 'Plan', messageId: '<plan@example.invalid>' },
      { mailbox: 'Other1', subject: 'Re: Plan', headers: { 'In-Reply-To': '<plan@example.invalid>', References: '<plan@example.invalid>' } }
    ] });
    const start = seeded.messages[0]!;
    const opened = (lines: string[]) => lines.filter(l => /^(EXAMINE|SELECT) /i.test(l)).map(l => l.replace(/^(EXAMINE|SELECT) "?([^"]*)"?.*$/i, '$2'));
    const narrow = await between(() => p.ok('get_thread', { mailbox: 'Work', uid: start.uid }));
    expect(narrow.value).toHaveLength(1);
    expect(opened(narrow.lines)).not.toContain('Other1');
    expect(opened(narrow.lines)).not.toContain('Other2');
    const wide = await between(() => p.ok('get_thread', { mailbox: 'Work', uid: start.uid, allFolders: true }));
    expect(wide.value).toHaveLength(2);
    expect(opened(wide.lines)).toContain('Other1');
  });

  it('POL-11 sorting 100 messages across several folders takes 10 or fewer tool calls', async () => {
    const senders = ['client@acme.invalid', 'mum@family.invalid', 'news@letters.invalid', 'shop@receipts.invalid'];
    await seed(p.server, { messages: Array.from({ length: 100 }, (_, i) => ({ mailbox: 'Sorting', subject: `Sort ${i}`, from: senders[i % 4] })) });
    const destination: Record<string, string> = {
      'client@acme.invalid': 'Clients', 'mum@family.invalid': 'Family', 'news@letters.invalid': 'Newsletters', 'shop@receipts.invalid': 'Receipts'
    };
    let calls = 0;
    const tool = (name: string, args: Record<string, unknown>) => { calls++; return p.ok(name, args); };

    // What an AI does: look once, then one batch per destination.
    const found = await tool('search_email', { mailbox: 'Sorting', limit: 100 }) as Array<{ uid: number; from: Array<{ address: string }> }>;
    const groups = new Map<string, number[]>();
    for (const m of found) groups.set(destination[m.from[0]!.address]!, [...(groups.get(destination[m.from[0]!.address]!) ?? []), m.uid]);
    const { commands } = await between(async () => { for (const [folder, uids] of groups) await tool('move_email', { mailbox: 'Sorting', uids, destination: folder }); });

    expect(calls).toBeLessThanOrEqual(10);
    expect(commands.filter(c => c === 'UID MOVE')).toHaveLength(4);
    expect(await peek(p.server, 'Sorting')).toHaveLength(0);
    for (const folder of Object.values(destination)) expect(await peek(p.server, folder), folder).toHaveLength(25);
  });
});
