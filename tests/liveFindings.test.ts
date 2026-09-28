import { describe, expect, it } from 'vitest';
import { parseMessage } from '../src/parseCore.js';
import { ImapGateway } from '../src/yahoo/imap.js';

// Found in the owner's full live run (2026-09-28, 2.2.1, Yahoo), against a
// stand-in server that behaves the way Yahoo did.
type Row = { uid: number; messageId?: string; date?: Date; subject?: string };

// scrambleMoves: the report pairs source UIDs, sorted, with the new UIDs in the order they were given (Yahoo).
// misreport: the report pairs them in reverse, whatever the order (a server no one should trust).
// hideInDestination: a Message-ID the destination doesn't show yet (an index lagging).
function server(options: { folders: Record<string, Row[]>; headerSearchWorks?: boolean; scrambleMoves?: boolean; misreport?: boolean; hideInDestination?: string }) {
  const folders = options.folders;
  let selected = '';
  const moves: string[] = [];
  let envelopeFetches = 0;
  const queries: Array<Record<string, unknown>> = [];
  const client = {
    usable: true, capabilities: new Set(['MOVE', 'UIDPLUS']),
    connect: async () => undefined, logout: async () => undefined, close: () => undefined, noop: async () => undefined,
    getMailboxLock: async (path: string) => { selected = path; return { release: () => undefined }; },
    get mailbox() { return { path: selected, exists: (folders[selected] ?? []).length }; },
    search: async (query: { uid?: string; header?: Record<string, string>; subject?: string }) => {
      queries.push(query);
      let rows = folders[selected] ?? [];
      // Yahoo's subject search ignores reply prefixes: "Re: X" also finds "X".
      if (query.subject) { const wanted = query.subject.replace(/^(re|fwd?):\s*/i, '').toLowerCase(); rows = rows.filter(r => (r.subject ?? '').toLowerCase().includes(wanted)); }
      if (query.header) rows = options.headerSearchWorks === false ? [] : rows.filter(r => r.messageId === query.header!['Message-ID']);
      const below = query.uid ? Number(query.uid.split(':')[1]) : Infinity;
      return rows.filter(r => r.uid <= below).map(r => r.uid);
    },
    fetchAll: async (set: number[] | string) => {
      envelopeFetches++;
      // "n:*" is by position (the newest, ENG-22); anything else is UIDs.
      const byUid = [...(folders[selected] ?? [])].sort((a, b) => a.uid - b.uid);
      const wanted = new Set(typeof set === 'string' && set.endsWith(':*') ? byUid.slice(Number(set.split(':')[0]) - 1).map(r => r.uid) : (Array.isArray(set) ? set : set.split(',')).map(Number));
      return (folders[selected] ?? []).filter(r => wanted.has(r.uid))
        .filter(r => !(selected !== 'INBOX' && options.hideInDestination && r.messageId === options.hideInDestination))
        .map(r => ({ uid: r.uid, envelope: { messageId: r.messageId, date: r.date, subject: r.subject }, flags: new Set<string>(), size: 10 }));
    },
    messageMove: async (set: string, destination: string) => {
      moves.push(set);
      const order = set.split(',').map(Number);
      const from = folders[selected]!;
      const to = folders[destination] ??= [];
      let next = Math.max(99, ...to.map(r => r.uid)) + 1;
      const assigned: Array<[number, number]> = [];
      for (const uid of order) {
        const row = from.find(r => r.uid === uid)!;
        folders[selected] = folders[selected]!.filter(r => r.uid !== uid);
        to.push({ ...row, uid: next });
        assigned.push([uid, next++]);
      }
      const sources = assigned.map(a => a[0]);
      const targets = assigned.map(a => a[1]);
      if (options.misreport) return { uidMap: new Map(sources.map((s, i) => [s, targets[targets.length - 1 - i]!])) };
      if (options.scrambleMoves) return { uidMap: new Map([...sources].sort((a, b) => a - b).map((s, i) => [s, targets[i]!])) };
      return { uidMap: new Map(assigned) };
    }
  };
  const gateway = (unreliable = true) => new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never, unreliableHeaderSearch: unreliable });
  return { folders, moves, gateway, queries, envelopeFetches: () => envelopeFetches };
}

describe('batch moves', () => {
  it('ENG-20 a batch move pairs each old UID with its own new UID, even when the server reports them mispaired (added: found live)', async () => {
    const s = server({ scrambleMoves: true, folders: {
      INBOX: [{ uid: 7, messageId: '<m7@x>' }, { uid: 8, messageId: '<m8@x>' }, { uid: 9, messageId: '<m9@x>' }], Trash: []
    } });
    const map = await s.gateway().moveMany('INBOX', [9, 7, 8], 'Trash');
    const newUidOf = (id: string) => s.folders.Trash!.find(r => r.messageId === id)!.uid;
    expect(map.get(7)).toBe(newUidOf('<m7@x>'));
    expect(map.get(8)).toBe(newUidOf('<m8@x>'));
    expect(map.get(9)).toBe(newUidOf('<m9@x>'));
    // Sent in ascending order, as one command.
    expect(s.moves).toEqual(['7,8,9']);
  });

  it('ENG-20 the pairing is checked by Message-ID in the destination: a server that misreports even a sorted batch is corrected', async () => {
    const s = server({ misreport: true, folders: {
      INBOX: [{ uid: 1, messageId: '<a@x>' }, { uid: 2, messageId: '<b@x>' }, { uid: 3, messageId: '<c@x>' }], Trash: []
    } });
    const map = await s.gateway().moveMany('INBOX', [1, 2, 3], 'Trash');
    for (const [uid, id] of [[1, '<a@x>'], [2, '<b@x>'], [3, '<c@x>']] as const) expect(map.get(uid), id).toBe(s.folders.Trash!.find(r => r.messageId === id)!.uid);
  });

  it('ENG-20 two copies of one message (same Message-ID) are paired in order; one the destination doesn\'t show is left unmapped, never guessed', async () => {
    const s = server({ misreport: true, folders: {
      INBOX: [{ uid: 1, messageId: '<same@x>' }, { uid: 2, messageId: '<same@x>' }, { uid: 3, messageId: '<other@x>' }], Trash: []
    } });
    const map = await s.gateway().moveMany('INBOX', [3, 2, 1], 'Trash');
    const copies = s.folders.Trash!.filter(r => r.messageId === '<same@x>').map(r => r.uid).sort((a, b) => a - b);
    expect([map.get(1), map.get(2)]).toEqual(copies);
    expect(map.get(3)).toBe(s.folders.Trash!.find(r => r.messageId === '<other@x>')!.uid);
    const t = server({ misreport: true, hideInDestination: '<b@x>', folders: { INBOX: [{ uid: 5, messageId: '<a@x>' }, { uid: 6, messageId: '<b@x>' }], Trash: [] } });
    const result = await t.gateway().moveMany('INBOX', [5, 6], 'Trash');
    expect(result.get(5)).toBe(t.folders.Trash!.find(r => r.messageId === '<a@x>')!.uid);
    expect(result.get(6)).toBeUndefined();
  });
});

describe('re-finding a message by its Message-ID', () => {
  it('ENG-21 when the server\'s header search misses (Yahoo), the newest messages are checked directly (added: found live)', async () => {
    const s = server({ headerSearchWorks: false, folders: {
      'Universal Mail test': [{ uid: 1, messageId: '<moved@x>' }], INBOX: [{ uid: 10, messageId: '<a@x>' }]
    } });
    const g = s.gateway(true);
    expect(await g.findByMessageId('Universal Mail test', '<moved@x>')).toEqual([1]);
    const page = await g.searchPage({ mailbox: 'Universal Mail test', messageId: '<moved@x>', limit: 5 });
    expect(page.messages.map(m => m.uid)).toEqual([1]);
    // Not there at all: still nothing, and no error.
    expect(await g.findByMessageId('INBOX', '<nowhere@x>')).toEqual([]);
  });

  it('ENG-21 a provider whose header search is reliable is not second-guessed', async () => {
    const s = server({ headerSearchWorks: false, folders: { INBOX: [{ uid: 1, messageId: '<m@x>' }] } });
    expect(await s.gateway(false).findByMessageId('INBOX', '<m@x>')).toEqual([]);
    expect(s.envelopeFetches()).toBe(0);
  });

  it('ENG-22 the check of the newest messages keeps to the page asked for, and skips an empty folder (added: tuning)', async () => {
    // Two copies (a copy keeps its Message-ID); the page below UID 4 has one.
    const s = server({ headerSearchWorks: false, folders: {
      INBOX: [{ uid: 1, messageId: '<a@x>' }, { uid: 2, messageId: '<dup@x>' }, { uid: 3, messageId: '<b@x>' }, { uid: 4, messageId: '<dup@x>' }], Empty: []
    } });
    const g = s.gateway(true);
    expect((await g.searchPage({ mailbox: 'INBOX', messageId: '<dup@x>', limit: 5 })).messages.map(m => m.uid)).toEqual([4, 2]);
    expect((await g.searchPage({ mailbox: 'INBOX', messageId: '<dup@x>', limit: 5, beforeUid: 4 })).messages.map(m => m.uid)).toEqual([2]);
    // An empty folder has no "newest": a real server refuses the range 1:*.
    const before = s.envelopeFetches();
    expect(await g.findByMessageId('Empty', '<dup@x>')).toEqual([]);
    expect(s.envelopeFetches()).toBe(before);
  });
});

describe('dates and times in a search', () => {
  it('POL-12 since and before honour the time of day, not just the date (added: found live)', async () => {
    const at = (t: string) => new Date(`2026-09-28T${t}:00Z`);
    const s = server({ folders: { INBOX: [
      { uid: 1, messageId: '<a@x>', date: at('15:48') }, { uid: 2, messageId: '<b@x>', date: at('16:37') },
      { uid: 3, messageId: '<c@x>', date: at('16:39') }, { uid: 4, messageId: '<d@x>', date: at('17:10') }
    ] } });
    const g = s.gateway();
    const since = await g.searchPage({ mailbox: 'INBOX', since: at('16:38'), limit: 10 });
    expect(since.messages.map(m => m.uid)).toEqual([4, 3]);
    const window = await g.searchPage({ mailbox: 'INBOX', since: at('16:00'), before: at('17:00'), limit: 10 });
    expect(window.messages.map(m => m.uid)).toEqual([3, 2]);
    // IMAP compares whole days only: "BEFORE today" would drop all of today.
    // The server is asked for a day either side; the exact times are applied here.
    const asked = s.queries.at(-1) as { since: Date; before: Date };
    expect(asked.since.getTime()).toBeLessThanOrEqual(at('16:00').getTime() - 24 * 3600_000);
    expect(asked.before.getTime()).toBeGreaterThanOrEqual(at('17:00').getTime() + 24 * 3600_000);
    // The limit still counts only what's shown.
    expect((await g.searchPage({ mailbox: 'INBOX', since: at('16:00'), limit: 2 })).messages.map(m => m.uid)).toEqual([4, 3]);
  });
});

describe('a subject search', () => {
  // Found live (2026-09-28, third run, confirmed read-only on the owner's
  // mailbox): Yahoo's subject search for "Re: X" also returned the originals
  // "X", so "find my reply" could pick the original.
  it('POL-13 only messages whose subject really contains what was asked come back, whatever the server matched (added: found live)', async () => {
    const s = server({ folders: { Sent: [
      { uid: 1, messageId: '<o@x>', subject: 'Universal Mail test 15:42' }, { uid: 2, messageId: '<r@x>', subject: 'Re: Universal Mail test 15:42' },
      { uid: 3, messageId: '<p@x>', subject: 'Something else' }
    ] } });
    const g = s.gateway();
    expect((await g.searchPage({ mailbox: 'Sent', subject: 'Re: Universal Mail test 15:42', limit: 10 })).messages.map(m => m.uid)).toEqual([2]);
    // Case and spacing don't matter; a plain subject still finds both.
    expect((await g.searchPage({ mailbox: 'Sent', subject: 're:  universal mail TEST 15:42', limit: 10 })).messages.map(m => m.uid)).toEqual([2]);
    expect((await g.searchPage({ mailbox: 'Sent', subject: 'Universal Mail test', limit: 10 })).messages.map(m => m.uid)).toEqual([2, 1]);
  });
});

describe('reading an HTML-only email as text', () => {
  const html = (body: string) => Buffer.from(['From: news@example.invalid', 'To: me@example.invalid', 'Subject: News', 'Message-ID: <n@example.invalid>', 'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8', '', body].join('\r\n'));

  it('PAR-08 an email with only HTML still has readable text: the words, without the tags (added: found live)', async () => {
    const parsed = await parseMessage(html('<html><body><h1>Big news</h1><p>The <b>article</b> is here.</p><style>p{color:red}</style></body></html>'));
    expect(parsed.text).toMatch(/BIG NEWS|Big news/);
    expect(parsed.text).toContain('article is here');
    expect(parsed.text).not.toMatch(/<\/?(p|b|h1|html|body)>/);
    expect(parsed.text).not.toContain('color:red');
    expect(parsed.html).toContain('<h1>Big news</h1>');
  });

  it('PAR-08 an email with its own text part keeps that text, not one made from its HTML', async () => {
    const both = Buffer.from(['From: a@example.invalid', 'To: b@example.invalid', 'Subject: s', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="q"', '',
      '--q', 'Content-Type: text/plain; charset=utf-8', '', 'The sender\'s own words.', '--q', 'Content-Type: text/html; charset=utf-8', '', '<p>Different <b>html</b></p>', '--q--', ''].join('\r\n'));
    expect((await parseMessage(both)).text?.trim()).toBe('The sender\'s own words.');
  });
});
