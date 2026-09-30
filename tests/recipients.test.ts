import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createSendLog } from '../src/sendLimits.js';
import { ImapGateway } from '../src/yahoo/imap.js';
import { MailService } from '../src/yahoo/mailService.js';

// First-time recipients (added 2026-09-29, principles 1 and 3): a send or reply
// to an address this account has never written to is held, nothing sent, and
// names them, so the AI confirms with the owner and sends again with
// newRecipientsConfirmed. Catches a mistyped address, and an email that tries
// to talk the AI into sending something to a stranger.
const config = loadConfig({ AUTH_MODE: 'builtin', YAHOO_EMAIL: 'me@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', SENT_COPY_MODE: 'append', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' });

function service(known: string[], options: { searchFails?: boolean; noSent?: boolean } = {}) {
  const s = new MailService(config, { sendLog: createSendLog() });
  const send = vi.spyOn((s as any).smtp, 'sendMail').mockResolvedValue({ accepted: ['x'], rejected: [] });
  vi.spyOn(s.imap, 'specialFolders').mockResolvedValue((options.noSent ? {} : { sent: 'Sent' }) as any);
  vi.spyOn(s.imap, 'findByMessageId').mockResolvedValue([]);
  vi.spyOn(s.imap, 'append').mockResolvedValue(9);
  const asked = vi.spyOn(s.imap, 'hasSentTo').mockImplementation(async (_folder, address) => {
    if (options.searchFails) throw new Error('search failed');
    return known.includes(address.toLowerCase());
  });
  return { s, send, asked };
}
afterEach(() => vi.restoreAllMocks());

describe('who counts as written to before', () => {
  // The server's search matches parts of addresses, and Sent can hold mail
  // someone else wrote (an AI can move any message there). So a match only
  // counts when the message is from this account and names the address exactly.
  function gateway(rows: Array<{ uid: number; from: string; to?: string[]; cc?: string[] }>) {
    const g = new ImapGateway(config);
    const client = {
      getMailboxLock: async () => ({ release: () => undefined }),
      search: async () => rows.map(r => r.uid),
      fetchAll: async () => rows.map(r => ({ uid: r.uid, envelope: { from: [{ address: r.from }], to: (r.to ?? []).map(address => ({ address })), cc: (r.cc ?? []).map(address => ({ address })) } }))
    };
    vi.spyOn(g, 'run').mockImplementation(fn => fn(client as never));
    return g;
  }

  it('RCP-05 only this account\'s own sent mail counts, and only an exact address (added: security review, 2.4)', async () => {
    // Planted: someone else's message, moved into Sent, copying the attacker.
    expect(await gateway([{ uid: 1, from: 'attacker@evil.example', cc: ['attacker@evil.example'] }]).hasSentTo('Sent', 'attacker@evil.example')).toBe(false);
    // A longer address that merely contains it.
    expect(await gateway([{ uid: 2, from: 'me@example.invalid', to: ['john.smith@x.example'] }]).hasSentTo('Sent', 'smith@x.example')).toBe(false);
    // The real thing, whatever the case.
    expect(await gateway([{ uid: 3, from: 'ME@example.invalid', to: ['Friend@Example.invalid'] }]).hasSentTo('Sent', 'friend@example.invalid')).toBe(true);
    expect(await gateway([{ uid: 4, from: 'me@example.invalid', cc: ['friend@example.invalid'] }]).hasSentTo('Sent', 'friend@example.invalid')).toBe(true);
  });
});

describe('first-time recipients', () => {
  it('RCP-01 a send to someone never written to is held, nothing sent, naming them; confirmed, it goes (added: first-time recipients)', async () => {
    const { s, send } = service(['friend@example.invalid']);
    const mail = { to: ['friend@example.invalid', 'Stranger@Elsewhere.example'], cc: ['new@elsewhere.example'], subject: 's', text: 't' };
    await expect(s.sendEmail(mail)).rejects.toMatchObject({
      code: 'MAIL-NEW-RECIPIENT', status: 'FAILED',
      message: expect.stringMatching(/first message to Stranger@Elsewhere\.example, new@elsewhere\.example/),
      details: { newRecipients: ['Stranger@Elsewhere.example', 'new@elsewhere.example'] }
    });
    expect(send).not.toHaveBeenCalled();
    await s.sendEmail({ ...mail, newRecipientsConfirmed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('RCP-01 people already written to, and the account itself, go straight through (bcc checked too)', async () => {
    const { s, send, asked } = service(['friend@example.invalid']);
    await s.sendEmail({ to: ['friend@example.invalid', 'ME@example.invalid'], subject: 's', text: 't' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls.map(c => c[1])).toEqual(['friend@example.invalid']);
    await expect(s.sendEmail({ to: ['friend@example.invalid'], bcc: ['hidden@elsewhere.example'], subject: 's', text: 't' })).rejects.toMatchObject({ code: 'MAIL-NEW-RECIPIENT' });
  });

  it('RCP-02 a reply to a sender never written to is held too (a scam\'s first reply)', async () => {
    const { s, send } = service([]);
    vi.spyOn(s.imap, 'fetchReplyHeaders').mockResolvedValue({ messageId: '<q@x>', subject: 'Invoice', from: [{ address: 'billing@unknown.example' }], replyTo: [], to: [], cc: [], references: [] });
    await expect(s.replyEmail({ mailbox: 'INBOX', uid: 1, text: 'paid' })).rejects.toMatchObject({ code: 'MAIL-NEW-RECIPIENT', details: { newRecipients: ['billing@unknown.example'] } });
    expect(send).not.toHaveBeenCalled();
    await s.replyEmail({ mailbox: 'INBOX', uid: 1, text: 'paid', newRecipientsConfirmed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('RCP-03 when the check can\'t be made (no Sent folder, a failed search), it asks rather than guessing', async () => {
    for (const trouble of [{ searchFails: true }, { noSent: true }]) {
      const { s, send } = service(['friend@example.invalid'], trouble);
      await expect(s.sendEmail({ to: ['friend@example.invalid'], subject: 's', text: 't' }), JSON.stringify(trouble)).rejects.toMatchObject({ code: 'MAIL-NEW-RECIPIENT', message: expect.stringMatching(/couldn't check/i) });
      expect(send).not.toHaveBeenCalled();
    }
  });
});
