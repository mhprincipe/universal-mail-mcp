import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MailService } from '../src/mail/mailService.js';
import { startToolFixture } from '../testkit/src/toolFixture.js';

// Junk (added 2.4.1): "this is spam". A move to the folder the provider
// marks as Junk (Gmail's Spam), which is how providers learn what spam looks
// like; never a folder guessed from its name. Undone like any move.
let f: Awaited<ReturnType<typeof startToolFixture>> | undefined;
afterEach(async () => { await f?.stop(); f = undefined; vi.restoreAllMocks(); });

describe('junk', () => {
  it('JNK-01 one message or many go to the provider\'s Junk folder; restore_email brings one back', async () => {
    f = await startToolFixture();
    const a = await f.seed('INBOX', { subject: 'Win a prize' });
    const b = await f.seed('INBOX', { subject: 'Win another' });
    const c = await f.seed('INBOX', { subject: 'Cheap watches' });
    const one = await f.call('junk_email', { mailbox: 'INBOX', uid: a.uid });
    expect(one.result).toMatchObject({ ok: true, data: { destination: 'Junk' } });
    const many = await f.call('junk_email', { mailbox: 'INBOX', uids: [b.uid, c.uid] });
    expect(many.result).toMatchObject({ ok: true, data: { destination: 'Junk' } });
    expect([...f.rows.values()].filter(r => r.mailbox === 'Junk').map(r => r.messageId).sort()).toEqual([a.messageId, b.messageId, c.messageId].sort());
    const back = await f.call('restore_email', { mailbox: 'Junk', uid: one.result.data.destinationUid });
    expect(back.result).toMatchObject({ ok: true, data: { destination: 'INBOX' } });
  });

  it('JNK-02 an account whose provider marks no Junk folder: refused, nothing moved, never a guess', async () => {
    const config = loadConfig({ AUTH_MODE: 'builtin', MAIL_ADDRESS: 'me@example.invalid', MAIL_APP_PASSWORD: 'dummy-password', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });
    const s = new MailService(config);
    vi.spyOn(s.imap, 'specialFolders').mockResolvedValue({ inbox: 'INBOX' } as any);
    const move = vi.spyOn(s.imap, 'move');
    await expect(s.junkEmail('INBOX', 4)).rejects.toMatchObject({ code: 'SPECIAL_FOLDER_NOT_FOUND' });
    expect(move).not.toHaveBeenCalled();
  });
});
