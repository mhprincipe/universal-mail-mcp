import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityFor, createActivityLog } from '../src/activity.js';
import { activityLine } from '../src/page/activity.js';
import { success, MailError } from '../src/errors.js';
import { MailService } from '../src/mail/mailService.js';
import { createCanary } from '../testkit/src/canary.js';
import { startPage } from './page/pageHarness.js';

// The activity log (added 2026-09-29, principle 1: the person stays in charge).
// What each app did in your mail (action, account, folders, how many, when;
// never content), for 30 days, on your page, with undo for moves and marks.
const DAY = 24 * 60 * 60 * 1000;

describe('the activity log', () => {
  it('ACT-01 newest first; at most 100; nothing older than 30 days; saved in one go, not per action (added: activity log)', async () => {
    let now = Date.parse('2026-09-29T20:00:00Z');
    const saves: unknown[] = [];
    const log = createActivityLog({ clock: { now: () => now }, save: entries => { saves.push(entries); }, debounceMs: 60_000 });
    for (let i = 0; i < 105; i++) { log.record({ app: 'Claude', account: 'me', action: 'trashed', count: 1 }); now += 1000; }
    expect(log.list()).toHaveLength(100);
    expect(log.list()[0]!.at).toBeGreaterThan(log.list()[1]!.at);
    expect(saves).toHaveLength(0);
    await log.flush();
    expect(saves).toHaveLength(1);
    now += 31 * DAY;
    log.record({ app: 'Claude', account: 'me', action: 'flagged', count: 1 });
    expect(log.list().map(e => e.action)).toEqual(['flagged']);
    // Read back from what was saved, ignoring anything malformed.
    // Recent but malformed: dropped, not shown.
    const again = createActivityLog({ clock: { now: () => now }, saved: [...(saves[0] as object[]), { at: now - 1000, nonsense: true }, { id: 'x', at: now - 1000, app: 'A', account: 'me', action: 7, count: 1 }] });
    expect(again.list()).toHaveLength(0);
    const fresh = createActivityLog({ clock: { now: () => now }, saved: log.list() });
    expect(fresh.list().map(e => e.action)).toEqual(['flagged']);
  });

  it('ACT-01 what each organize or send tool did, in plain words, with what undo needs; reads, no-ops and failures leave nothing', () => {
    expect(activityFor('trash_email', { mailbox: 'INBOX', uid: 5 }, success({ sourceMailbox: 'INBOX', sourceUid: 5, destination: 'Trash', destinationUid: 91 }))).toMatchObject({
      action: 'trashed', count: 1, from: 'INBOX', to: 'Trash', undo: { kind: 'move', mailbox: 'Trash', uids: [91], destination: 'INBOX' }
    });
    expect(activityFor('move_email', { mailbox: 'INBOX', uids: [1, 2] }, success({ sourceMailbox: 'INBOX', destination: 'Receipts', moved: [{ sourceUid: 1, destinationUid: 7 }, { sourceUid: 2 }] }))).toMatchObject({
      action: 'moved', count: 2, undo: { kind: 'move', mailbox: 'Receipts', uids: [7], destination: 'INBOX' }
    });
    expect(activityFor('mark_read', { mailbox: 'INBOX', uids: [1, 2] }, success({ mailbox: 'INBOX', uids: [1, 2], read: true }))).toMatchObject({
      action: 'marked read', count: 2, undo: { kind: 'flag', mailbox: 'INBOX', uids: [1, 2], flag: 'read', value: false }
    });
    expect(activityFor('flag_email', { mailbox: 'INBOX', uid: 3, flagged: true }, success({ mailbox: 'INBOX', uid: 3, flagged: true }))).toMatchObject({
      action: 'flagged', undo: { kind: 'flag', flag: 'flagged', value: false }
    });
    expect(activityFor('send_email', { to: ['a@x.example', 'b@x.example'], cc: ['c@x.example'] }, success({ messageId: '<m>' }, 'ok', 'SENT'))).toEqual({ action: 'sent', count: 1, recipients: 3 });
    // Sent to someone new because the AI said the owner confirmed: shown, so the owner sees it (security review).
    expect(activityFor('reply_email', { mailbox: 'INBOX', uid: 1, newRecipientsConfirmed: true }, success({ messageId: '<m>' }, 'ok', 'SENT'))).toEqual({ action: 'replied', count: 1, newRecipients: true });
    expect(activityFor('create_folder', { path: 'Receipts' }, success({ path: 'Receipts', created: true }))).toMatchObject({ action: 'created folder', to: 'Receipts' });
    expect(activityFor('create_folder', { path: 'Receipts' }, success({ path: 'Receipts', created: false }))).toBeUndefined();
    expect(activityFor('move_email', { mailbox: 'INBOX', uid: 1 }, success({ sourceMailbox: 'INBOX' }, 'already', 'ALREADY_THERE'))).toBeUndefined();
    expect(activityFor('search_email', {}, success([]))).toBeUndefined();
    expect(activityFor('trash_email', { mailbox: 'INBOX', uid: 5 }, { ok: false, status: 'FAILED', code: 'X', message: 'no' } as never)).toBeUndefined();
  });
});

describe('the activity log, safely', () => {
  it('ACT-07 what it keeps (and saves with your settings) stays under 16 KB, oldest dropped first: the settings record Google keeps has a 64 KB limit (added: security review, 2.4)', async () => {
    const now = Date.parse('2026-09-29T20:00:00Z');
    let tick = 0;
    const saves: unknown[] = [];
    const log = createActivityLog({ clock: { now: () => now + tick++ }, save: entries => { saves.push(entries); } });
    const uids = Array.from({ length: 100 }, (_, i) => 100_000 + i);
    let newest = '';
    for (let i = 0; i < 100; i++) newest = log.record({ app: 'Claude', account: 'me', action: 'marked read', count: 100, from: 'INBOX', undo: { kind: 'flag', mailbox: 'INBOX', uids, flag: 'read', value: false } }).id;
    expect(JSON.stringify(log.list()).length).toBeLessThanOrEqual(16_384);
    expect(log.list().length).toBeGreaterThan(5);
    expect(log.list()[0]!.id).toBe(newest);
    await log.flush();
    expect(JSON.stringify(saves.at(-1)).length).toBeLessThanOrEqual(16_384);
  });
});

describe('the activity log on your page', () => {
  let p: Awaited<ReturnType<typeof startPage>> | undefined;
  afterEach(async () => { await p?.close(); p = undefined; vi.restoreAllMocks(); });
  const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
  const tool = async (connection: number, name: string, args: Record<string, unknown>) => {
    const r = await p!.mcp(claude, connection, 'tools/call', { name, arguments: args });
    const line = r.body.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? r.body;
    return JSON.parse(JSON.parse(line.trim()).result.content[0].text);
  };
  const entryId = (html: string, text: RegExp) => {
    const at = html.search(text);
    return html.slice(at).match(/name="id" value="([^"]+)"/)![1]!;
  };

  it('ACT-02 what an app did shows on your page (app, action, account, count, folders; never content), and a move can be put back (added: activity log)', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize', 'send'] });
    const secretFolder = createCanary('folder');
    vi.spyOn(MailService.prototype, 'trashEmail').mockResolvedValue(success({ sourceMailbox: 'INBOX', sourceUid: 5, destination: 'Trash', destinationUid: 91 }) as never);
    vi.spyOn(MailService.prototype, 'markRead').mockResolvedValue(success({ mailbox: secretFolder, uids: [1, 2], read: true }) as never);
    const moveBack = vi.spyOn(MailService.prototype, 'moveEmail').mockResolvedValue(success({ sourceMailbox: 'Trash', sourceUid: 91, destination: 'INBOX', destinationUid: 12 }) as never);
    const unread = vi.spyOn(MailService.prototype, 'markUnread').mockResolvedValue(success({ mailbox: secretFolder, uids: [1, 2], read: false }) as never);
    expect((await tool(grant.connection, 'trash_email', { account: 'me', mailbox: 'INBOX', uid: 5 })).ok).toBe(true);
    expect((await tool(grant.connection, 'mark_read', { account: 'me', mailbox: secretFolder, uids: [1, 2] })).ok).toBe(true);
    await p.signIn();
    const html = (await p.get()).html;
    expect(html).toMatch(/Recent activity[\s\S]*Claude marked read 2 messages in me[\s\S]*Claude trashed 1 message in me/);

    const trashed = await p.act('/activity/undo', { id: entryId(html, /Claude trashed 1 message/) });
    expect(moveBack).toHaveBeenCalledWith('Trash', [91], 'INBOX');
    expect(trashed.html).toContain('Put back');
    const read = await p.act('/activity/undo', { id: entryId(trashed.html, /Claude marked read 2 messages/) });
    expect(unread).toHaveBeenCalledWith(secretFolder, [1, 2]);
    expect(read.html).toMatch(/Undone/);
    // Undone once; the page says so rather than doing it again.
    expect((await p.act('/activity/undo', { id: entryId(html, /Claude trashed 1 message/) })).html).toContain('already been undone');
    expect(moveBack).toHaveBeenCalledTimes(1);
  });

  it('ACT-03 a message that has moved since can\'t be put back: the page says so and marks nothing undone', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize'] });
    vi.spyOn(MailService.prototype, 'archiveEmail').mockResolvedValue(success({ sourceMailbox: 'INBOX', sourceUid: 5, destination: 'Archive', destinationUid: 40 }) as never);
    vi.spyOn(MailService.prototype, 'moveEmail').mockRejectedValue(new MailError('MESSAGE_NOT_FOUND', 'gone', 'NOT_FOUND'));
    await tool(grant.connection, 'archive_email', { account: 'me', mailbox: 'INBOX', uid: 5 });
    await p.signIn();
    const html = (await p.get()).html;
    const page = await p.act('/activity/undo', { id: entryId(html, /Claude archived 1 message/) });
    expect(page.html).toContain('moved since');
    expect(page.html).not.toMatch(/Undone/);
  });

  it('ACT-04 sends are listed, not undoable; reads and failed actions leave nothing', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize', 'send'] });
    vi.spyOn(MailService.prototype, 'sendEmail').mockResolvedValue(success({ messageId: '<m@x>' }, 'The mail provider accepted the message.', 'SENT') as never);
    vi.spyOn(MailService.prototype, 'trashEmail').mockRejectedValue(new MailError('FOLDER_NOT_FOUND', 'no trash', 'FAILED'));
    vi.spyOn(MailService.prototype, 'listFolders').mockResolvedValue(success([]) as never);
    await tool(grant.connection, 'send_email', { account: 'me', to: ['friend@example.invalid', 'other@example.invalid'], subject: createCanary('subject'), text: 'x', newRecipientsConfirmed: true });
    await tool(grant.connection, 'trash_email', { account: 'me', mailbox: 'INBOX', uid: 5 });
    await tool(grant.connection, 'list_folders', { account: 'me' });
    await p.signIn();
    const html = (await p.get()).html;
    expect(html).toMatch(/Claude sent 1 message \(2 recipients, someone new\) from me/);
    expect(html.match(/Claude [a-z ]+ \d+ message/g)).toHaveLength(1);
    expect(html.slice(html.indexOf('Recent activity'))).not.toMatch(/name="id"/);
    expect(html).not.toContain('subject-');
  });

  it('ACT-05 the log is saved with your settings, so it outlasts a restart', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize'] });
    vi.spyOn(MailService.prototype, 'flagEmail').mockResolvedValue(success({ mailbox: 'INBOX', uid: 3, flagged: true }) as never);
    await tool(grant.connection, 'flag_email', { account: 'me', mailbox: 'INBOX', uid: 3, flagged: true });
    await p.app.signin!.activity!.flush();
    const saved = JSON.parse(p.saves.state.at(-1)!);
    expect(saved.activity).toEqual([expect.objectContaining({ app: 'Claude', account: 'me', action: 'flagged', count: 1 })]);
  });

  it('ACT-08 undo finds the account by its address: after a rename it still works; if that address is gone (a new account took the name), it refuses (added: security review, 2.4)', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { work: ['read', 'organize'] });
    vi.spyOn(MailService.prototype, 'trashEmail').mockResolvedValue(success({ sourceMailbox: 'INBOX', sourceUid: 5, destination: 'Trash', destinationUid: 91 }) as never);
    const moveBack = vi.spyOn(MailService.prototype, 'moveEmail').mockResolvedValue(success({ sourceMailbox: 'Trash', sourceUid: 91, destination: 'INBOX', destinationUid: 12 }) as never);
    await tool(grant.connection, 'trash_email', { account: 'work', mailbox: 'INBOX', uid: 5 });
    await tool(grant.connection, 'trash_email', { account: 'work', mailbox: 'INBOX', uid: 6 });
    await p.signIn();
    await p.act('/accounts/rename', { name: 'work', to: 'office' });
    const html = (await p.get()).html;
    const ids = [...html.matchAll(/name="id" value="([^"]+)"/g)].map(m => m[1]!);
    expect(ids).toHaveLength(2);
    expect((await p.act('/activity/undo', { id: ids[0]! })).html).toContain('Put back');
    expect(moveBack).toHaveBeenCalledTimes(1);
    // The address goes; another account takes the old name.
    p.accepted['other@example.invalid'] = 'other-app-password';
    await p.act('/accounts/remove', { name: 'office', confirm: 'office' });
    await p.act('/accounts/add', { email: 'other@example.invalid', password: 'other-app-password', name: 'work' });
    expect((await p.act('/activity/undo', { id: ids[1]! })).html).toContain('That account isn&#39;t here any more.');
    expect(moveBack).toHaveBeenCalledTimes(1);
  });
});

describe('the 2.4.1 actions in the activity log', () => {
  const two = [{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 10 }, { filename: 'costs.csv', contentType: 'text/csv', size: 3 }];
  const entry = (fields: Record<string, unknown>) => ({ id: 'e', at: 0, app: 'Claude', account: 'me', count: 1, ...fields }) as never;

  it('ACT-09 forwards, unsubscribes and junk are listed; junk can be put back; attachments are counted, never named (added: 2.4.1)', () => {
    const sent = success({ messageId: '<m>', attachments: two }, 'ok', 'SENT');
    expect(activityFor('send_email', { to: ['a@x.example'] }, sent)).toEqual({ action: 'sent', count: 1, recipients: 1, attachments: 2 });
    expect(activityFor('forward_email', { mailbox: 'INBOX', uid: 4, to: ['a@x.example'], cc: ['b@x.example'], newRecipientsConfirmed: true }, sent))
      .toEqual({ action: 'forwarded', count: 1, recipients: 2, attachments: 2, newRecipients: true });
    expect(activityFor('reply_email', { mailbox: 'INBOX', uid: 4 }, sent)).toEqual({ action: 'replied', count: 1, attachments: 2 });
    expect(activityFor('create_draft', { to: ['a@x.example'] }, success({ uid: 3, attachments: two.slice(0, 1) }))).toEqual({ action: 'drafted', count: 1, attachments: 1 });
    expect(activityFor('junk_email', { mailbox: 'INBOX', uids: [1, 2] }, success({ sourceMailbox: 'INBOX', destination: 'Junk', moved: [{ sourceUid: 1, destinationUid: 8 }, { sourceUid: 2, destinationUid: 9 }] })))
      .toMatchObject({ action: 'moved to junk', count: 2, from: 'INBOX', to: 'Junk', undo: { kind: 'move', mailbox: 'Junk', uids: [8, 9], destination: 'INBOX' } });
    expect(activityFor('unsubscribe', { mailbox: 'INBOX', uid: 4 }, success({ mailbox: 'INBOX', uid: 4, unsubscribed: true, sender: 'news.example.com' }))).toEqual({ action: 'unsubscribed', count: 1 });
    expect(activityFor('summarize_senders', { mailbox: 'INBOX' }, success({ senders: [] }))).toBeUndefined();
    expect(JSON.stringify(activityFor('send_email', { to: ['a@x.example'] }, sent))).not.toContain('invoice');
  });

  it('ACT-09 in plain words on the page', () => {
    expect(activityLine(entry({ action: 'forwarded', recipients: 2, attachments: 2 }))).toBe('Claude forwarded 1 message (2 recipients, 2 attachments) from me');
    expect(activityLine(entry({ action: 'sent', recipients: 1, attachments: 1, newRecipients: true }))).toBe('Claude sent 1 message (1 recipient, 1 attachment, someone new) from me');
    expect(activityLine(entry({ action: 'replied', attachments: 1 }))).toBe('Claude replied to 1 message (1 attachment) from me');
    expect(activityLine(entry({ action: 'drafted', attachments: 3 }))).toBe('Claude drafted 1 message (3 attachments) in me');
    expect(activityLine(entry({ action: 'moved to junk', count: 2 }))).toBe('Claude moved 2 messages to junk in me');
    expect(activityLine(entry({ action: 'unsubscribed' }))).toBe('Claude unsubscribed from a mailing list in me');
    expect(activityLine(entry({ action: 'trashed', count: 1 }))).toBe('Claude trashed 1 message in me');
  });
});
