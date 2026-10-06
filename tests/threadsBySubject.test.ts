import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway, threadSubject } from '../src/mail/imap.js';
import { MailService } from '../src/mail/mailService.js';
import type { FolderInfo, MessageDetail } from '../src/types.js';

// THR-10 (added: 2.5.1, found live 2026-10-06): on Yahoo a conversation from
// a week earlier came back as 3 of its 9 messages. Yahoo's header search
// found nothing, the direct check reads only a folder's newest 200, and the
// 6 Inbox messages were 450 back. Its subject search does find them; each
// candidate is kept only if its own reply headers tie it to the conversation,
// following the ties from message to message (Outlook trims References, so the
// first emails aren't named by the last).
afterEach(() => { vi.restoreAllMocks(); });
const config = loadConfig({ YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
const folder = (path: string, specialUse?: string): FolderInfo => ({ path, specialUse, selectable: true });
const detail = (mailbox: string, uid: number, messageId: string, date: string, extra: Partial<MessageDetail> = {}): MessageDetail => ({
  mailbox, uid, messageId, date, subject: 'RE: Immediate hiring | Remote', from: [], to: [], cc: [], bcc: [], replyTo: [], references: [],
  attachments: [], read: false, flagged: false, untrustedContent: true, ...extra
});

describe('a conversation found by its subject', () => {
  it('THR-10 the subject without its Re:, Fwd: and RE: prefixes', () => {
    expect(threadSubject('RE: Re: Fwd:  Immediate hiring | Remote ')).toBe('Immediate hiring | Remote');
    expect(threadSubject('Fw: [External] Plans')).toBe('[External] Plans');
    expect(threadSubject('AW: SV: Hello')).toBe('Hello');
    expect(threadSubject('Re:')).toBe('');
    expect(threadSubject(undefined)).toBe('');
  });

  function yahoo(service: MailService, candidates: Record<string, Array<{ uid: number; messageId: string; references?: string[]; inReplyTo?: string }>>, members: Record<string, MessageDetail>) {
    const client = { capabilities: new Map<string, boolean>([['IMAP4REV1', true]]) };
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([folder('INBOX', '\\Inbox'), folder('Sent', '\\Sent'), folder('Archive', '\\Archive')]);
    vi.spyOn(service.imap, 'read').mockImplementation(fn => fn(client as any));
    // The header search and the newest-200 check: only the Sent copies.
    vi.spyOn(service.imap, 'findThreadUids').mockImplementation(async path => path === 'Sent' ? [21, 22] : []);
    const bySubject = vi.spyOn(service.imap, 'threadCandidates').mockImplementation(async path => (candidates[path] ?? []).map(c => ({ ...c, references: c.references ?? [] })));
    vi.spyOn(service, 'getEmail').mockImplementation(async (mailbox, uid) => {
      const data = members[`${mailbox}:${uid}`];
      if (!data) throw new Error(`unexpected fetch ${mailbox}:${uid}`);
      return { ok: true, status: 'SUCCESS', code: 'OK', message: '', data };
    });
    return bySubject;
  }

  it('THR-10 older Inbox messages tied to the conversation, directly or through each other, are found; one with the same subject and no tie is not (added: 2.5.1, found live)', async () => {
    const service = new MailService(config);
    // The chain: first (1) → my reply (s1) → their reply (2) → my reply (s2) → seed (3).
    const seed = detail('INBOX', 3, '<m3@x>', '2026-09-30T22:31:00Z', { inReplyTo: '<s2@x>', references: ['<m2@x>', '<s2@x>'] });
    const bySubject = yahoo(service, {
      INBOX: [
        { uid: 1, messageId: '<m1@x>' },
        { uid: 2, messageId: '<m2@x>', inReplyTo: '<s1@x>', references: ['<s1@x>'] },
        { uid: 3, messageId: '<m3@x>', inReplyTo: '<s2@x>', references: ['<m2@x>', '<s2@x>'] },
        { uid: 9, messageId: '<other@x>' }
      ],
      Sent: [
        { uid: 20, messageId: '<s1@x>', inReplyTo: '<m1@x>', references: ['<m1@x>'] },
        { uid: 21, messageId: '<s2@x>', inReplyTo: '<m2@x>', references: ['<m2@x>'] }
      ]
    }, {
      'INBOX:3': seed,
      'INBOX:1': detail('INBOX', 1, '<m1@x>', '2026-09-30T20:29:00Z', { subject: 'Immediate hiring | Remote' }),
      'INBOX:2': detail('INBOX', 2, '<m2@x>', '2026-09-30T22:14:00Z'),
      'Sent:20': detail('Sent', 20, '<s1@x>', '2026-09-30T21:00:00Z'),
      'Sent:21': detail('Sent', 21, '<s2@x>', '2026-09-30T22:20:00Z'),
      'Sent:22': detail('Sent', 22, '<s3@x>', '2026-10-01T13:31:00Z', { inReplyTo: '<m3@x>', references: ['<m2@x>', '<s2@x>', '<m3@x>'] }),
      // Same subject, no tie: it would show if it were fetched.
      'INBOX:9': detail('INBOX', 9, '<other@x>', '2026-09-29T10:00:00Z')
    });
    const result = await service.getThread('INBOX', 3);
    expect(result.data?.map(m => m.messageId)).toEqual(['<m1@x>', '<s1@x>', '<m2@x>', '<s2@x>', '<m3@x>', '<s3@x>']);
    // Each message read once: Sent:21 was found both ways.
    const reads = vi.mocked(service.getEmail).mock.calls.map(([box, n]) => `${box}:${n}`);
    expect(reads.length).toBe(new Set(reads).size);
    expect(bySubject.mock.calls.map(([path, subject]) => [path, subject])).toEqual([['INBOX', 'Immediate hiring | Remote'], ['Sent', 'Immediate hiring | Remote'], ['Archive', 'Immediate hiring | Remote']]);
  });

  it('THR-10 every folder: only the folders searched within the time limit are asked by subject too', async () => {
    const clock = { t: 0 };
    const service = new MailService(config, { clock: { now: () => clock.t } });
    const client = { capabilities: new Map<string, boolean>([['IMAP4REV1', true]]) };
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([folder('INBOX', '\\Inbox'), ...Array.from({ length: 20 }, (_, i) => folder(`F${i}`))]);
    vi.spyOn(service.imap, 'read').mockImplementation(fn => fn(client as any));
    vi.spyOn(service.imap, 'findThreadUids').mockImplementation(async () => { clock.t += 10_000; return []; });
    const bySubject = vi.spyOn(service.imap, 'threadCandidates').mockResolvedValue([]);
    vi.spyOn(service, 'getEmail').mockResolvedValue({ ok: true, status: 'SUCCESS', code: 'OK', message: '', data: detail('INBOX', 3, '<m3@x>', '2026-09-30', { references: ['<m2@x>'] }) });
    await service.getThread('INBOX', 3, { allFolders: true });
    const scanned = vi.mocked(service.imap.findThreadUids).mock.calls.map(([path]) => path);
    expect(bySubject.mock.calls.map(([path]) => path)).toEqual(scanned);
    expect(scanned.length).toBeLessThan(21);
  });

  it('THR-10 a subject that is only "Re:" leaves nothing to search by: no subject search', async () => {
    const service = new MailService(config);
    const bySubject = yahoo(service, {}, { 'INBOX:3': detail('INBOX', 3, '<m3@x>', '2026-09-30', { subject: 'Re:', references: ['<m2@x>'] }), 'Sent:21': detail('Sent', 21, '<s2@x>', '2026-09-30'), 'Sent:22': detail('Sent', 22, '<s3@x>', '2026-09-30') });
    await service.getThread('INBOX', 3);
    expect(bySubject).not.toHaveBeenCalled();
  });

  it('THR-10 not on Gmail, whose own conversation ids give the whole thread', async () => {
    const service = new MailService(config);
    const client = { capabilities: new Map<string, boolean>([['IMAP4REV1', true], ['X-GM-EXT-1', true]]) };
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([folder('INBOX', '\\Inbox'), folder('[Gmail]/All Mail', '\\All')]);
    vi.spyOn(service.imap, 'read').mockImplementation(fn => fn(client as any));
    vi.spyOn(service.imap, 'findGmailThread').mockResolvedValue([]);
    const bySubject = vi.spyOn(service.imap, 'threadCandidates');
    vi.spyOn(service, 'getEmail').mockResolvedValue({ ok: true, status: 'SUCCESS', code: 'OK', message: '', data: detail('INBOX', 3, '<m3@x>', '2026-09-30', { references: ['<m2@x>'] }) });
    await service.getThread('INBOX', 3);
    expect(bySubject).not.toHaveBeenCalled();
  });

  it('THR-10 a folder whose subject search fails is said, and the rest of the conversation still comes back', async () => {
    const service = new MailService(config);
    const seed = detail('INBOX', 3, '<m3@x>', '2026-09-30', { references: ['<s2@x>'] });
    yahoo(service, {}, { 'INBOX:3': seed, 'Sent:21': detail('Sent', 21, '<s2@x>', '2026-09-30'), 'Sent:22': detail('Sent', 22, '<s3@x>', '2026-09-30') });
    vi.mocked(service.imap.threadCandidates).mockRejectedValueOnce(new Error('connection reset'));
    const result = await service.getThread('INBOX', 3);
    expect(result.data!.length).toBe(3);
    expect(result.warnings).toContain('A folder could not be searched by subject; the thread may be incomplete.');
  });
});

describe('the subject search itself', () => {
  it('THR-10 asks the server by subject, reads only the newest 100 hits\' header blocks, and returns each one\'s ids', async () => {
    const searched: unknown[] = [];
    const fetched: unknown[] = [];
    const header = (id: string, refs = '') => Buffer.from(`Message-ID: ${id}\r\n${refs ? `References: ${refs}\r\nIn-Reply-To: ${refs.split(' ').at(-1)}\r\n` : ''}Subject: x\r\n\r\n`);
    const client = {
      usable: true, connect: async () => undefined, close: () => undefined, noop: async () => undefined,
      getMailboxLock: async () => ({ release: () => undefined }),
      search: async (query: unknown) => { searched.push(query); return Array.from({ length: 150 }, (_, i) => i + 1); },
      fetchAll: async (uids: number[], query: unknown) => { fetched.push([uids.length, query]); return uids.map(uid => ({ uid, headers: header(`<m${uid}@x>`, uid > 140 ? `<m${uid - 1}@x>` : '') })); }
    };
    const gateway = new ImapGateway({ SEARCH_TIMEOUT_MS: 5_000 } as never, { createClient: () => client as never });
    const found = await gateway.threadCandidates('INBOX', 'Immediate hiring');
    expect(searched).toEqual([{ subject: 'Immediate hiring' }]);
    expect(fetched).toEqual([[100, { headers: true }]]);
    expect(found).toHaveLength(100);
    expect(found.at(-1)).toEqual({ uid: 150, messageId: '<m150@x>', references: ['<m149@x>'], inReplyTo: '<m149@x>' });
    expect(found[0]).toEqual({ uid: 51, messageId: '<m51@x>', references: [] });
  });
});

describe('what the answer says', () => {
  it('THR-10 on a provider whose header search misses mail, the answer says how the conversation was found and what can still be missed', async () => {
    const service = new MailService(config);
    const client = { capabilities: new Map<string, boolean>([['IMAP4REV1', true]]) };
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([folder('INBOX', '\\Inbox')]);
    vi.spyOn(service.imap, 'read').mockImplementation(fn => fn(client as any));
    vi.spyOn(service.imap, 'findThreadUids').mockResolvedValue([]);
    vi.spyOn(service.imap, 'threadCandidates').mockResolvedValue([]);
    vi.spyOn(service, 'getEmail').mockResolvedValue({ ok: true, status: 'SUCCESS', code: 'OK', message: '', data: detail('INBOX', 3, '<m3@x>', '2026-09-30', { references: ['<m2@x>'] }) });
    const result = await service.getThread('INBOX', 3);
    expect(result.warnings).toContain('On this provider a conversation is found by its reply headers and by its subject; a message whose subject was changed, older than a folder\'s newest 200, may be missing.');
    expect(result.warnings!.some(w => /200 most recent/.test(w))).toBe(false);
  });
});
