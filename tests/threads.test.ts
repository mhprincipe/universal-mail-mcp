import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { FolderInfo, MessageDetail } from '../src/types.js';
import { MailService } from '../src/mail/mailService.js';

const config = loadConfig({ YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });

const detail = (mailbox: string, uid: number, messageId: string, date: string, references: string[] = []): MessageDetail => ({
  mailbox, uid, messageId, date, subject: 'plans', from: [], to: [], cc: [], bcc: [], replyTo: [], references,
  attachments: [], read: false, flagged: false, untrustedContent: true
});
const folder = (path: string, specialUse?: string): FolderInfo => ({ path, specialUse, selectable: true });

// A Gmail-shaped mailbox: every message lives once in All Mail, and again
// under each label (Inbox, Sent, Work...).
function gmail(service: MailService, members: Record<string, MessageDetail>) {
  const client = {
    capabilities: new Map<string, boolean>([['IMAP4REV1', true], ['X-GM-EXT-1', true]]),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    fetchOne: vi.fn(async (uid: number) => ({ uid, threadId: 'thread-42' })),
    search: vi.fn(async () => [11, 12, 13]),
    fetchAll: vi.fn(async () => [])
  };
  vi.spyOn(service.imap, 'listFolders').mockResolvedValue([
    folder('INBOX', '\\Inbox'), folder('[Gmail]/Sent Mail', '\\Sent'), folder('[Gmail]/All Mail', '\\All'), folder('Work')
  ]);
  vi.spyOn(service.imap, 'read').mockImplementation(fn => fn(client as any));
  vi.spyOn(service, 'getEmail').mockImplementation(async (mailbox, uid) => {
    const data = members[`${mailbox}:${uid}`];
    if (!data) throw new Error(`unexpected fetch ${mailbox}:${uid}`);
    return { ok: true, status: 'SUCCESS', code: 'OK', message: '', data };
  });
  return client;
}

describe('thread strategies', () => {
  it('THR-01 Gmail-like: a thread is found with a single thread-ID search', async () => {
    const service = new MailService(config);
    const client = gmail(service, {
      'INBOX:5': detail('INBOX', 5, '<seed@x>', '2026-09-02', ['<root@x>']),
      '[Gmail]/All Mail:11': detail('[Gmail]/All Mail', 11, '<root@x>', '2026-09-01'),
      '[Gmail]/All Mail:12': detail('[Gmail]/All Mail', 12, '<seed@x>', '2026-09-02', ['<root@x>']),
      '[Gmail]/All Mail:13': detail('[Gmail]/All Mail', 13, '<reply@x>', '2026-09-03', ['<root@x>', '<seed@x>'])
    });

    const result = await service.getThread('INBOX', 5);

    expect(client.fetchOne).toHaveBeenCalledWith(5, { threadId: true }, { uid: true });
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith({ threadId: 'thread-42' }, { uid: true });
    expect(result.data?.map(m => m.messageId)).toEqual(['<root@x>', '<seed@x>', '<reply@x>']);
  });

  it('THR-01 Gmail-like: if the thread search fails, the seed is kept and the gap is reported', async () => {
    const service = new MailService(config);
    const seed = detail('INBOX', 5, '<seed@x>', '2026-09-02', ['<root@x>']);
    const client = gmail(service, { 'INBOX:5': seed });
    client.search.mockRejectedValue(Object.assign(new Error('connection closed'), { code: 'ECONNRESET' }));

    const result = await service.getThread('INBOX', 5);

    expect(result.data).toEqual([seed]);
    expect(result.warnings).toContain('The thread could not be searched; it may be incomplete.');
  });

  it('THR-05 Gmail-like: a full scan skips All Mail, and a message under several labels appears once', async () => {
    const service = new MailService(config);
    const client = gmail(service, {
      'INBOX:5': detail('INBOX', 5, '<seed@x>', '2026-09-02', ['<root@x>']),
      '[Gmail]/Sent Mail:3': detail('[Gmail]/Sent Mail', 3, '<root@x>', '2026-09-01'),
      'INBOX:6': detail('INBOX', 6, '<reply@x>', '2026-09-03', ['<root@x>']),
      'Work:7': detail('Work', 7, '<reply@x>', '2026-09-03', ['<root@x>'])
    });
    // Without Gmail's extension, threads fall back to scanning folders.
    client.capabilities.delete('X-GM-EXT-1');
    const hits: Record<string, number[]> = { 'INBOX': [5, 6], '[Gmail]/Sent Mail': [3], 'Work': [7], '[Gmail]/All Mail': [11, 12, 13] };
    const scan = vi.spyOn(service.imap, 'findThreadUids').mockImplementation(async folderPath => hits[folderPath] ?? []);

    const result = await service.getThread('INBOX', 5, { allFolders: true });

    expect(scan.mock.calls.map(([folderPath]) => folderPath)).not.toContain('[Gmail]/All Mail');
    expect(result.data?.map(m => m.messageId)).toEqual(['<root@x>', '<seed@x>', '<reply@x>']);
  });
});

describe('a conversation on Gmail', () => {
  it('THR-07 the answer says its messages come from All Mail, and that those places work for every tool (added: 2.4.4, found live: it could confuse a next step)', async () => {
    const service = new MailService(config);
    gmail(service, {
      'INBOX:5': detail('INBOX', 5, '<seed@x>', '2026-09-02', ['<root@x>']),
      '[Gmail]/All Mail:11': detail('[Gmail]/All Mail', 11, '<root@x>', '2026-09-01'),
      '[Gmail]/All Mail:12': detail('[Gmail]/All Mail', 12, '<seed@x>', '2026-09-02', ['<root@x>']),
      '[Gmail]/All Mail:13': detail('[Gmail]/All Mail', 13, '<reply@x>', '2026-09-03', ['<root@x>', '<seed@x>'])
    });
    const result = await service.getThread('INBOX', 5);
    expect(result.message).toMatch(/All Mail.*mailbox and uid.*work/);
  });
});
