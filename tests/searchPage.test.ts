import { describe, expect, it } from 'vitest';
import { ImapGateway } from '../src/yahoo/imap.js';

// SIG-82 (added: found live, 2026-09-28): a search counted hidden system
// emails (sign-in codes) toward its limit, then dropped them, so "the 5
// newest" came back as 3. Here, against a stand-in server: the limit counts
// only what the AI sees, and the cursor never skips or repeats.
function folder(uids: number[], system: number[]) {
  let fetches = 0;
  const client = {
    usable: true,
    connect: async () => undefined, logout: async () => undefined, close: () => undefined, noop: async () => undefined,
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async (query: { uid?: string }) => {
      const below = query.uid ? Number(query.uid.split(':')[1]) : Infinity;
      return uids.filter(u => u <= below);
    },
    fetchAll: async (wanted: number[]) => {
      fetches++;
      return wanted.map(uid => ({ uid, envelope: { messageId: system.includes(uid) ? `<s${uid}@system.universal-mail.invalid>` : `<m${uid}@example.invalid>` }, flags: new Set<string>(), size: 10 }));
    }
  };
  const gateway = new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never });
  const page = (limit: number, beforeUid?: number) => gateway.searchPage({ mailbox: 'INBOX', limit, ...(beforeUid ? { beforeUid } : {}) });
  return { page, fetches: () => fetches };
}
const uidsOf = (r: { messages: Array<{ uid: number }> }) => r.messages.map(m => m.uid);

describe('a page of search results', () => {
  it('SIG-82 the limit counts only visible messages: hidden ones are skipped and older ones fill the page (added: found live)', async () => {
    const f = folder([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [9, 10]);
    const five = await f.page(5);
    expect(uidsOf(five)).toEqual([8, 7, 6, 5, 4]);
    expect(five.next).toBe(4);
    const three = await f.page(3);
    expect(uidsOf(three)).toEqual([8, 7, 6]);
    expect(three.next).toBe(6);
  });

  it('SIG-82 paging covers every visible message exactly once, with hidden ones anywhere', async () => {
    const f = folder([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [12, 7, 6, 2]);
    const seen: number[] = [];
    let cursor: number | undefined;
    do {
      const page = await f.page(3, cursor);
      seen.push(...uidsOf(page));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual([11, 10, 9, 8, 5, 4, 3, 1]);
  });

  it('SIG-82 when fewer visible messages exist than the limit, all of them come back and there is no cursor', async () => {
    const f = folder([1, 2, 3, 4], [3, 4]);
    const page = await f.page(5);
    expect(uidsOf(page)).toEqual([2, 1]);
    expect(page.next).toBeUndefined();
    expect(uidsOf(await folder([1, 2], [1, 2]).page(5))).toEqual([]);
  });

  it('SIG-82 an ordinary page still takes one fetch', async () => {
    const f = folder([1, 2, 3, 4, 5, 6], []);
    expect(uidsOf(await f.page(3))).toEqual([6, 5, 4]);
    expect(f.fetches()).toBe(1);
  });
});
