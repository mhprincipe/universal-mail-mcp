import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/yahoo/imap.js';
import { MailService } from '../src/yahoo/mailService.js';
const config = loadConfig({ YAHOO_EMAIL: 'dummy@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
const root = '<root@test.invalid>';
describe('Yahoo thread header-search fallback', () => {
  it('finds a reply from threading headers when Yahoo returns no HEADER search hits', async () => {
    const gateway = new ImapGateway(config);
    const release = vi.fn();
    const client = {
      getMailboxLock: vi.fn(async () => ({ release })),
      mailbox: { exists: 3 },
      search: vi.fn().mockResolvedValueOnce([]),
      fetchAll: vi.fn(async () => [
        { uid: 1, headers: Buffer.from(`Message-ID: <seed@test.invalid>\r\nReferences: ${root}\r\n`) },
        { uid: 2, headers: Buffer.from(`Message-ID: <reply@test.invalid>\r\nReferences:\r\n ${root} <seed@test.invalid>\r\n`) },
        { uid: 3, headers: Buffer.from('Message-ID: <other@test.invalid>\r\nReferences: <root@test.invalid.extra>\r\n') }
      ])
    };
    vi.spyOn(gateway, 'read').mockImplementation(fn => fn(client as any));
    expect(await gateway.findThreadUids('INBOX', root, { relatedMessageId: '<seed@test.invalid>' })).toEqual([1, 2]);
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(client.fetchAll).toHaveBeenCalledWith('1:*', { headers: ['Message-ID', 'References', 'In-Reply-To'] });
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('limits fallback metadata fetches to 200 recent UIDs and retains older indexed hits', async () => {
    const gateway = new ImapGateway(config);
    const client = {
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      mailbox: { exists: 300 },
      search: vi.fn().mockResolvedValueOnce([1]),
      fetchAll: vi.fn(async (range: string, query: unknown) => [])
    };
    expect(await gateway.findThreadUids('INBOX', root, { client: client as any })).toEqual([1]);
    expect(client.fetchAll.mock.calls[0]?.[0]).toBe('101:*');
    expect(client.search).toHaveBeenCalledTimes(1);
  });
  it('keeps the seed and reports incomplete scans instead of silently hiding errors', async () => {
    const service = new MailService(config);
    const seed = { mailbox: 'INBOX', uid: 1, messageId: root, subject: 'test', from: [], to: [], cc: [], bcc: [], replyTo: [], references: [], attachments: [], read: false, flagged: false, untrustedContent: true as const };
    vi.spyOn(service, 'getEmail').mockResolvedValue({ ok: true, status: 'SUCCESS', code: 'OK', message: '', data: seed });
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([{ path: 'INBOX', selectable: true }]);
    vi.spyOn(service.imap, 'read').mockImplementation(fn => fn({} as any));
    vi.spyOn(service.imap, 'findThreadUids').mockRejectedValue(new Error('network failure'));
    const result = await service.getThread('INBOX', 1);
    expect(result.data).toEqual([seed]);
    expect(result.warnings).toContain('A folder could not be searched; the thread may be incomplete.');
  });
});
