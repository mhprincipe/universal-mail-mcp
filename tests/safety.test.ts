import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/yahoo/imap.js';
import { MailService } from '../src/yahoo/mailService.js';
import { composeRaw } from '../src/yahoo/mime.js';
import { simpleParser } from 'mailparser';

const config = loadConfig({ YAHOO_EMAIL: 'test@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', SENT_COPY_MODE: 'append', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
const reset = () => Object.assign(new Error('connection closed'), { code: 'ECONNRESET' });
const auth = () => Object.assign(new Error('authentication timeout'), { code: 'EAUTH' });
const folder = (path: string, specialUse?: string) => ({ path, specialUse, selectable: true });
const detail = (uid = 1, messageId = '<seed@test>') => ({ mailbox: 'Drafts', uid, messageId, subject: 'Test', from: [], to: [{ address: 'test@example.invalid' }], cc: [], bcc: [], replyTo: [], references: [], attachments: [], text: 'original', untrustedContent: true as const, read: false, flagged: false });
afterEach(() => vi.restoreAllMocks());

describe('IMAP recovery invariants', () => {
  it('retries a transient read at most once', async () => {
    const gateway = new ImapGateway(config);
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(reset());
    await expect(gateway.listFolders()).rejects.toMatchObject({ code: 'TRANSIENT_NETWORK' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('never retries authentication even when it mentions timeout', async () => {
    const gateway = new ImapGateway(config);
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(auth());
    await expect(gateway.listFolders()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('retries move only after checking both folders and the original UID', async () => {
    const gateway = new ImapGateway(config);
    vi.spyOn(gateway, 'fetchSummary').mockResolvedValue(detail());
    const events: string[] = [];
    let attempts = 0;
    vi.spyOn(gateway, 'run').mockImplementation(async () => { events.push('move'); if (++attempts === 1) throw reset(); return 9 as any; });
    vi.spyOn(gateway, 'findByMessageId').mockImplementation(async path => { events.push(path); return path === 'Drafts' ? [1] : []; });
    expect(await gateway.move('Drafts', 1, 'Target')).toBe(9);
    expect(events).toEqual(['move', 'Drafts', 'Target', 'move']);
  });
  it.each(['source-failed', 'destination-failed', 'both-present', 'different-uid', 'both-absent'])('does not retry an inconclusive move: %s', async scenario => {
    const gateway = new ImapGateway(config);
    vi.spyOn(gateway, 'fetchSummary').mockResolvedValue(detail());
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(reset());
    vi.spyOn(gateway, 'findByMessageId').mockImplementation(async path => {
      if ((scenario === 'source-failed' && path === 'Drafts') || (scenario === 'destination-failed' && path === 'Target')) throw reset();
      if (scenario === 'both-present') return [1];
      if (scenario === 'both-absent') return [];
      return path === 'Drafts' ? [scenario === 'different-uid' ? 2 : 1] : [];
    });
    await expect(gateway.move('Drafts', 1, 'Target')).rejects.toMatchObject({ status: 'UNKNOWN' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('recovers a confirmed completed move without retry', async () => {
    const gateway = new ImapGateway(config);
    vi.spyOn(gateway, 'fetchSummary').mockResolvedValue(detail());
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(reset());
    vi.spyOn(gateway, 'findByMessageId').mockImplementation(async path => path === 'Drafts' ? [] : [7]);
    expect(await gateway.move('Drafts', 1, 'Target')).toBe(7);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('append failure is UNKNOWN and is never retried', async () => {
    const gateway = new ImapGateway(config);
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(reset());
    await expect(gateway.append('Drafts', Buffer.from('test'))).rejects.toMatchObject({ status: 'UNKNOWN', retryable: false });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('reuses a recent folder listing instead of re-listing for every operation', async () => {
    // archive_email listed folders twice for identical data: once to resolve the
    // special folder, once to validate the destination. On a bulk cleanup that
    // is hundreds of redundant logins against a provider that throttles them.
    const gateway = new ImapGateway(config);
    let lists = 0;
    const client = { list: async () => { lists++; return [{ path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>(), delimiter: '/' }]; } };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    await gateway.listFolders();
    await gateway.listFolders();
    await gateway.specialFolders();
    expect(lists).toBe(1);
  });
  it('a newly created folder invalidates the cached listing', async () => {
    const gateway = new ImapGateway(config);
    let lists = 0;
    const paths = [{ path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>(), delimiter: '/' }];
    const client = { list: async () => { lists++; return [...paths]; }, mailboxCreate: async (path: string) => { paths.push({ path, specialUse: '', flags: new Set<string>(), delimiter: '/' }); return { path, created: true }; } };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    expect(await gateway.listFolders()).toHaveLength(1);
    await gateway.createFolder('New');
    expect(await gateway.listFolders()).toHaveLength(2);
    // The first listing, the fresh check before creating (ENG-23), and the one after.
    expect(lists).toBe(3);
  });
  it('uses SPECIAL-USE, excludes unselectable folders, and never invents a folder', async () => {
    const gateway = new ImapGateway(config);
    vi.spyOn(gateway, 'listFolders').mockResolvedValue([folder('Drafts'), folder('Localized', '\\Sent'), { ...folder('No', '\\Trash'), selectable: false }]);
    expect(await gateway.specialFolders()).toEqual({ inbox: undefined, sent: 'Localized', drafts: undefined, trash: undefined, archive: undefined, junk: undefined });
  });
  it('existing create_folder is success without another create attempt', async () => {
    const gateway = new ImapGateway(config);
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(new Error('already exists'));
    vi.spyOn(gateway, 'listFolders').mockResolvedValue([folder('MCP-Test')]);
    expect(await gateway.createFolder('MCP-Test')).toEqual({ path: 'MCP-Test', created: false });
    // Not even one attempt: the fresh listing already shows it (ENG-23).
    expect(run).not.toHaveBeenCalled();
  });
  it('a folder created elsewhere between the check and the create is still success', async () => {
    const gateway = new ImapGateway(config);
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(new Error('already exists'));
    vi.spyOn(gateway, 'listFolders').mockResolvedValueOnce([]).mockResolvedValue([folder('MCP-Test')]);
    expect(await gateway.createFolder('MCP-Test')).toEqual({ path: 'MCP-Test', created: false });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('search_email can filter by the stable Message-ID key', async () => {
    // Message-ID survives moves while UIDs do not, so it is the only reliable
    // handle for re-resolving a message after a write.
    const gateway = new ImapGateway(config);
    let query: any;
    const client = {
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      search: vi.fn(async (q: any) => { query = q; return [7]; }),
      fetchAll: vi.fn(async () => [{ uid: 7, envelope: { messageId: '<m@test>' }, flags: new Set<string>(), size: 10 }])
    };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    const rows = await gateway.search({ mailbox: 'Sent', messageId: '<m@test>', limit: 25 });
    expect(query.header).toEqual({ 'Message-ID': '<m@test>' });
    expect(rows[0]?.messageId).toBe('<m@test>');
    expect(client.getMailboxLock).toHaveBeenCalledWith('Sent', { readOnly: true });
  });
  it('fetches raw message under read-only lock and never changes Seen', async () => {
    const gateway = new ImapGateway(config);
    const flags = new Set<string>();
    const client = { getMailboxLock: vi.fn(async () => ({ release: vi.fn() })), fetchOne: vi.fn(async () => ({ uid: 1, flags, size: 10, source: Buffer.from('Subject: test\r\n\r\nbody') })) };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    const result = await gateway.fetchRaw('INBOX', 1);
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(client.fetchOne).toHaveBeenLastCalledWith(1, { envelope: true, flags: true, size: true, source: true }, { uid: true });
    expect(result.summary.read).toBe(false);
    expect(flags.has('\\Seen')).toBe(false);
  });
  it('rejects an oversized message before fetching its body', async () => {
    const gateway = new ImapGateway(config);
    const client = { getMailboxLock: vi.fn(async () => ({ release: vi.fn() })), fetchOne: vi.fn(async () => ({ size: config.MAX_MESSAGE_BYTES + 1 })) };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    await expect(gateway.fetchRaw('INBOX', 1)).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
    expect(client.fetchOne).toHaveBeenCalledTimes(1);
  });
  it('requires UIDPLUS for targeted draft cleanup', async () => {
    const gateway = new ImapGateway(config);
    const client = { capabilities: new Map(), getMailboxLock: vi.fn(async () => ({ release: vi.fn() })), messageDelete: vi.fn() };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    await expect(gateway.deleteMessage('Drafts', 1)).rejects.toMatchObject({ code: 'SAFE_DELETE_UNAVAILABLE' });
    expect(client.messageDelete).not.toHaveBeenCalled();
  });
  it('moves a batch in a single IMAP connection and maps every new UID', async () => {
    // One message per call meant 100 logins for a 100-message cleanup. IMAP
    // UID MOVE takes a sequence set, so the whole batch is one command.
    const gateway = new ImapGateway(config);
    let connections = 0;
    const client = {
      capabilities: new Map([['MOVE', true]]),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      // Envelopes: in the source, for the check that none is a system email;
      // in the destination (UIDs 11-13), the same messages, so the same
      // Message-IDs, for the check of each pair (ENG-20).
      fetchAll: vi.fn(async (set: string) => set.split(',').map(uid => ({ uid: Number(uid), envelope: { messageId: `<${Number(uid) > 10 ? Number(uid) - 10 : Number(uid)}@test>` } }))),
      messageMove: vi.fn(async () => ({ uidMap: new Map([[1, 11], [2, 12], [3, 13]]) }))
    };
    vi.spyOn(gateway, 'run').mockImplementation(async fn => { connections++; return fn(client as any); });
    const map = await gateway.moveMany('INBOX', [1, 2, 3], 'Archive');
    expect(connections).toBe(1);
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect([...map.entries()]).toEqual([[1, 11], [2, 12], [3, 13]]);
  });
  it('a batch move without MOVE or UIDPLUS refuses rather than expunging', async () => {
    const gateway = new ImapGateway(config);
    const client = { capabilities: new Map(), getMailboxLock: vi.fn(async () => ({ release: vi.fn() })), messageMove: vi.fn() };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    await expect(gateway.moveMany('INBOX', [1, 2], 'Archive')).rejects.toMatchObject({ code: 'SAFE_MOVE_UNAVAILABLE' });
    expect(client.messageMove).not.toHaveBeenCalled();
  });
  it('an unconfirmed batch move is UNKNOWN and is never retried', async () => {
    const gateway = new ImapGateway(config);
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(reset());
    await expect(gateway.moveMany('INBOX', [1, 2], 'Archive')).rejects.toMatchObject({ status: 'UNKNOWN' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('refuses an unsafe MOVE fallback before touching the source', async () => {
    const gateway = new ImapGateway(config);
    vi.spyOn(gateway, 'fetchSummary').mockResolvedValue(detail());
    const client = { capabilities: new Map(), getMailboxLock: vi.fn(async () => ({ release: vi.fn() })), messageMove: vi.fn() };
    vi.spyOn(gateway, 'run').mockImplementation(fn => fn(client as any));
    await expect(gateway.move('INBOX', 1, 'Target')).rejects.toMatchObject({ code: 'SAFE_MOVE_UNAVAILABLE' });
    expect(client.messageMove).not.toHaveBeenCalled();
  });
  it('repeated mark_read and mark_unread set the same state safely', async () => {
    const service = new MailService(config);
    const flags = new Set<string>();
    const client = { getMailboxLock: vi.fn(async () => ({ release: vi.fn() })), fetchAll: vi.fn(async () => [{ uid: 1, envelope: { messageId: '<1@test>' } }]), messageFlagsAdd: vi.fn(async () => { flags.add('\\Seen'); return true; }), messageFlagsRemove: vi.fn(async () => { flags.delete('\\Seen'); return true; }) };
    vi.spyOn(service.imap, 'run').mockImplementation(fn => fn(client as any));
    await service.markRead('INBOX', 1); await service.markRead('INBOX', 1);
    expect(flags.has('\\Seen')).toBe(true);
    await service.markUnread('INBOX', 1); await service.markUnread('INBOX', 1);
    expect(flags.has('\\Seen')).toBe(false);
  });
  it('failed flag reconciliation returns UNKNOWN, not NOT_FOUND', async () => {
    const gateway = new ImapGateway(config);
    const run = vi.spyOn(gateway, 'run').mockRejectedValue(reset());
    vi.spyOn(gateway, 'read').mockRejectedValue(reset());
    await expect(gateway.setFlag('INBOX', 1, '\\Seen', true)).rejects.toMatchObject({ status: 'UNKNOWN' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('draft and mailbox safety', () => {
  function setup() {
    const service = new MailService(config);
    vi.spyOn(service.imap, 'specialFolders').mockResolvedValue({ drafts: 'Drafts' } as any);
    vi.spyOn(service, 'getEmail').mockResolvedValue({ ok: true, status: 'SUCCESS', code: 'OK', message: '', data: detail() });
    return service;
  }
  it.each(['Typo', 'target'])('missing or case-mismatched destination %s never guesses', async destination => {
    const service = setup();
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([folder('Target')]);
    const move = vi.spyOn(service.imap, 'move');
    await expect(service.moveEmail('INBOX', 1, destination)).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(move).not.toHaveBeenCalled();
  });
  it.each(['INBOX', 'drafts'])('refuses update_draft in %s', async mailbox => {
    const service = setup();
    const append = vi.spyOn(service.imap, 'append');
    await expect(service.updateDraft({ mailbox, uid: 1 })).rejects.toMatchObject({ code: 'NOT_A_DRAFT_MAILBOX' });
    expect(append).not.toHaveBeenCalled();
  });
  it('creates replacement before cleanup, preserving new draft on cleanup failure', async () => {
    const service = setup(); const events: string[] = [];
    vi.spyOn(service.imap, 'append').mockImplementation(async () => { events.push('append'); return 2; });
    vi.spyOn(service.imap, 'deleteMessage').mockImplementation(async (_mailbox, uid) => { events.push(`delete:${uid}`); throw reset(); });
    const result = await service.updateDraft({ mailbox: 'Drafts', uid: 1, text: 'replacement' });
    expect(events).toEqual(['append', 'delete:1']);
    expect(result).toMatchObject({ status: 'SUCCESS', data: { uid: 2 } });
    expect(result.warnings).toHaveLength(1);
  });
  it('never removes old draft after ambiguous replacement append', async () => {
    const service = setup();
    vi.spyOn(service.imap, 'append').mockRejectedValue(reset());
    const remove = vi.spyOn(service.imap, 'deleteMessage');
    await expect(service.updateDraft({ mailbox: 'Drafts', uid: 1 })).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
  it('preserves Bcc in drafts but excludes it from transmitted MIME', async () => {
    const input = { from: config.YAHOO_EMAIL, to: ['to@example.invalid'], bcc: ['hidden@example.invalid'], subject: 'test', text: 'body' };
    expect((await simpleParser((await composeRaw(input, true)).raw)).bcc).toBeDefined();
    expect((await simpleParser((await composeRaw(input)).raw)).bcc).toBeUndefined();
  });
  it('reuses one IMAP connection for the whole thread instead of one per message', async () => {
    // Yahoo throttles rapid logins and a connect/logout cycle per thread member
    // already exceeded the deployed Cloud Run request timeout.
    const service = new MailService(config);
    let connections = 0;
    const client = {
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      fetchOne: vi.fn(async (uid: number, query: any) => query.source
        ? { uid, size: 64, flags: new Set<string>(), envelope: {}, source: Buffer.from(`Message-ID: <m${uid}@test>\r\nSubject: thread\r\n\r\nbody`) }
        : { uid, size: 64 })
    };
    vi.spyOn(service.imap, 'run').mockImplementation(async fn => { connections++; return fn(client as any); });
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([folder('INBOX')]);
    vi.spyOn(service.imap, 'findThreadUids').mockResolvedValue(Array.from({ length: 40 }, (_, i) => i + 1));
    const result = await service.getThread('INBOX', 1);
    expect(result.data).toHaveLength(40);
    expect(connections).toBeLessThanOrEqual(3);
  });
  it('get_thread deduplicates by Message-ID and caps message fetches', async () => {
    const service = setup();
    vi.spyOn(service.imap, 'read').mockImplementation(fn => fn({} as any));
    vi.spyOn(service.imap, 'listFolders').mockResolvedValue([folder('INBOX'), folder('Sent')]);
    vi.spyOn(service.imap, 'findThreadUids').mockResolvedValue(Array.from({ length: 150 }, (_, i) => i + 1));
    const get = vi.mocked(service.getEmail).mockImplementation(async (_mailbox, uid) => ({ ok: true, status: 'SUCCESS', code: 'OK', message: '', data: detail(uid, `<${uid % 5}@test>`) }));
    const result = await service.getThread('INBOX', 1);
    expect(result.data).toHaveLength(5);
    expect(get).toHaveBeenCalledTimes(100);
  });
});

describe('SMTP no-duplicate delivery', () => {
  function setup(mode: 'append'|'yahoo'|'unverified' = 'append') {
    const service = new MailService({ ...config, SENT_COPY_MODE: mode });
    const smtp = (service as any).smtp;
    const send = vi.spyOn(smtp, 'sendMail').mockResolvedValue({ accepted: ['test@example.invalid'], rejected: [] });
    vi.spyOn(service.imap, 'specialFolders').mockResolvedValue({ sent: 'Sent' } as any);
    const find = vi.spyOn(service.imap, 'findByMessageId').mockResolvedValue([]);
    const append = vi.spyOn(service.imap, 'append').mockResolvedValue(9);
    return { service, send, find, append };
  }
  const input = { to: ['test@example.invalid'], subject: 'test', text: 'body' };
  it.each([450, 550])('explicit SMTP %i rejection is FAILED with no retry', async responseCode => {
    const { service, send, append } = setup();
    send.mockRejectedValue({ command: 'DATA', responseCode });
    await expect(service.sendEmail(input)).rejects.toMatchObject({ status: 'FAILED', code: 'SMTP_REJECTED' });
    expect(send).toHaveBeenCalledTimes(1); expect(append).not.toHaveBeenCalled();
  });
  it('connection loss after delivery may begin is UNKNOWN and never retried', async () => {
    const { service, send, append } = setup();
    send.mockRejectedValue({ command: 'DATA', code: 'ECONNRESET' });
    await expect(service.sendEmail(input)).rejects.toMatchObject({ status: 'UNKNOWN', code: 'SEND_STATUS_UNKNOWN', retryable: false });
    expect(send).toHaveBeenCalledTimes(1); expect(append).not.toHaveBeenCalled();
  });
  it('Sent append failure preserves SMTP success and never resends', async () => {
    const { service, send, append } = setup(); append.mockRejectedValue(reset());
    const result = await service.sendEmail(input);
    expect(result.status).toBe('SUCCESS'); expect(result.warnings).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1); expect(append).toHaveBeenCalledTimes(1);
  });
  it('Sent lookup failure never appends or resends', async () => {
    const { service, send, find, append } = setup(); find.mockRejectedValue(reset());
    const result = await service.sendEmail(input);
    expect(result.status).toBe('SUCCESS'); expect(result.warnings).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1); expect(append).not.toHaveBeenCalled();
  });
  it('appends the exact transmitted MIME once only when verified append mode needs a copy', async () => {
    const { service, send, append } = setup();
    await service.sendEmail(input);
    expect(append).toHaveBeenCalledWith('Sent', (send.mock.calls[0]![0] as any).raw, ['\\Seen']);
    expect(append).toHaveBeenCalledTimes(1);
  });
  it.each(['append', 'yahoo'] as const)('never duplicates an existing Sent copy in %s mode', async mode => {
    const { service, find, append } = setup(mode); find.mockResolvedValue([9]);
    await service.sendEmail(input); expect(append).not.toHaveBeenCalled();
  });
  it('does not append on a delayed Yahoo automatic Sent copy', async () => {
    const { service, append, find } = setup('yahoo');
    const result = await service.sendEmail(input);
    expect(result.warnings).toHaveLength(1); expect(append).not.toHaveBeenCalled();
    // Nor looks for it: it appears a minute or so later (ENG-24).
    expect(find).not.toHaveBeenCalled();
    expect(result.warnings?.[0]).toMatch(/files its own Sent copy.*minute.*do not resend/i);
  });
  it('POL-14 the answer says when the provider accepted it, by the server\'s clock (added: asked for in the live runs)', async () => {
    // The AIs stamped test subjects with a guessed time, up to two hours out.
    const { service } = setup('yahoo');
    const before = Date.now();
    const result = await service.sendEmail(input);
    const sentAt = (result.data as { sentAt?: string }).sentAt!;
    expect(sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Date.parse(sentAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(sentAt)).toBeLessThanOrEqual(Date.now());
  });
  it('blocks sends until Sent behavior is verified', async () => {
    const { service, send } = setup('unverified');
    await expect(service.sendEmail(input)).rejects.toMatchObject({ code: 'SENT_POLICY_UNVERIFIED' });
    expect(send).not.toHaveBeenCalled();
  });
});
