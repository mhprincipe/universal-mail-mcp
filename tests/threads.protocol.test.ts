import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFaultProxy } from '../testkit/src/faultProxy.js';
import { startImapServer, type ImapServer } from '../testkit/src/imapServer.js';
import { mailServiceFor } from '../testkit/src/mailService.js';
import { seed } from '../testkit/src/seed.js';

// One conversation across folders, as in real mail: their email and their
// answer in the Inbox, your reply in Sent. Plus an unrelated email.
const root = '<root@thread.invalid>';
const mine = '<mine@thread.invalid>';
const theirs = '<theirs@thread.invalid>';
const day = (n: number) => new Date(`2026-09-0${n}T12:00:00Z`);

// A second conversation, spread wider: one reply archived, one filed by hand
// in a folder of the person's own.
const quote = '<quote@thread.invalid>';
const accepted = '<accepted@thread.invalid>';
const archived = '<archived@thread.invalid>';
const filed = '<filed@thread.invalid>';

let server: ImapServer;
let rootUid: number;
let quoteUid: number;
let filedUid: number;

beforeAll(async () => {
  server = await startImapServer('yahoo-like');
  const refs = (...ids: string[]) => ({ 'In-Reply-To': ids.at(-1)!, References: ids.join(' ') });
  const seeded = await seed(server, {
    folders: ['Projects'],
    messages: [
      { mailbox: 'INBOX', subject: 'Plans', messageId: root, date: day(1) },
      { mailbox: 'Sent', subject: 'Re: Plans', messageId: mine, date: day(2), headers: refs(root) },
      { mailbox: 'INBOX', subject: 'Re: Plans', messageId: theirs, date: day(3), headers: refs(root, mine) },
      { mailbox: 'INBOX', subject: 'Unrelated', date: day(4) },
      { mailbox: 'INBOX', subject: 'Quote', messageId: quote, date: day(5) },
      { mailbox: 'Sent', subject: 'Re: Quote', messageId: accepted, date: day(6), headers: refs(quote) },
      { mailbox: 'Archive', subject: 'Re: Quote', messageId: archived, date: day(7), headers: refs(quote, accepted) },
      { mailbox: 'Projects', subject: 'Re: Quote', messageId: filed, date: day(8), headers: refs(quote, accepted, archived) }
    ]
  });
  const uidOf = (id: string) => seeded.messages.find(m => m.messageId === id)!.uid;
  rootUid = uidOf(root);
  quoteUid = uidOf(quote);
  filedUid = uidOf(filed);
});
afterAll(async () => { await server?.stop(); });

const ids = (result: { data?: Array<{ messageId?: string }> }) => result.data?.map(m => m.messageId);

describe('thread strategies on a real mail server', () => {
  it('THR-02 when header search is reliable, it alone finds the thread: no scan of recent messages', async () => {
    const trusting = { unreliableHeaderSearch: false };

    const direct = await mailServiceFor(server, trusting).getThread('INBOX', rootUid);
    expect(ids(direct)).toEqual([root, mine, theirs]);
    expect(direct.warnings ?? []).not.toContainEqual(expect.stringMatching(/most recent/));

    // Through a proxy that blanks every header search: had any scan of recent
    // messages run, it would still have found the replies.
    const proxy = await startFaultProxy(server, { blankHeaderSearch: true });
    try {
      const blinded = await mailServiceFor({ ...server, host: proxy.host, port: proxy.port }, trusting).getThread('INBOX', rootUid);
      expect(ids(blinded)).toEqual([root]);
    } finally {
      await proxy.stop();
    }
  });

  it('THR-03 the Yahoo-like fallback scans only Inbox, Sent, Archive and the seed message\'s folder', async () => {
    const service = mailServiceFor(server);
    // From the Inbox: the reply filed in Projects is outside the limited scan.
    expect(ids(await service.getThread('INBOX', quoteUid))).toEqual([quote, accepted, archived]);
    // From Projects itself: the seed's own folder is always scanned.
    expect(ids(await service.getThread('Projects', filedUid))).toEqual([quote, accepted, archived, filed]);
  });

  it('THR-06 the fallback still finds a reply when HEADER search returns nothing', async () => {
    // Yahoo's behaviour, reproduced: every header search comes back empty.
    const proxy = await startFaultProxy(server, { blankHeaderSearch: true });
    try {
      const result = await mailServiceFor({ ...server, host: proxy.host, port: proxy.port }).getThread('INBOX', rootUid);
      expect(ids(result)).toEqual([root, mine, theirs]);
      expect(result.warnings).toContainEqual(expect.stringMatching(/most recent/));
    } finally {
      await proxy.stop();
    }
  });

  it('THR-04 allFolders: true scans every selectable folder', async () => {
    const result = await mailServiceFor(server).getThread('INBOX', quoteUid, { allFolders: true });
    expect(ids(result)).toEqual([quote, accepted, archived, filed]);
  });
});
