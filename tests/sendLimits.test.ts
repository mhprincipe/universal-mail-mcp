import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAccounts } from '../src/accountsConfig.js';
import { loadConfig } from '../src/config.js';
import { createSendLog } from '../src/sendLimits.js';
import { MailService } from '../src/mail/mailService.js';
import { startPage } from './page/pageHarness.js';

// Send limits (added 2026-09-29, principle 4: it can't be turned into a spam
// or harassment tool). Per account, a cap on messages an hour and a day;
// defaults 30 and 200, changed on your page. At the cap a send is refused
// before anything leaves, and says why.
const base = { YAHOO_EMAIL: 'me@example.invalid', YAHOO_APP_PASSWORD: 'dummy-password', MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars', SENT_COPY_MODE: 'append', IMAP_HOST: '127.0.0.1', SMTP_HOST: '127.0.0.1' };

function service(limits: { perHour?: string; perDay?: string } = {}) {
  let now = Date.parse('2026-09-29T20:00:00Z');
  const s = new MailService(loadConfig({ ...base, ...(limits.perHour ? { SEND_LIMIT_PER_HOUR: limits.perHour } : {}), ...(limits.perDay ? { SEND_LIMIT_PER_DAY: limits.perDay } : {}) }),
    { sendLog: createSendLog(), clock: { now: () => now } });
  const send = vi.spyOn((s as any).smtp, 'sendMail').mockResolvedValue({ accepted: ['friend@example.invalid'], rejected: [] });
  vi.spyOn(s.imap, 'specialFolders').mockResolvedValue({ sent: 'Sent' } as any);
  vi.spyOn(s.imap, 'findByMessageId').mockResolvedValue([]);
  vi.spyOn(s.imap, 'append').mockResolvedValue(9);
  return { s, send, advance: (ms: number) => { now += ms; } };
}
const mail = { to: ['friend@example.invalid'], subject: 's', text: 't', newRecipientsConfirmed: true };
const MINUTE = 60_000;

afterEach(() => vi.restoreAllMocks());

describe('send limits', () => {
  it('LIM-01 at the hourly cap a send is refused before anything leaves, and allowed again once the hour has passed (added: send limits)', async () => {
    const { s, send, advance } = service({ perHour: '2', perDay: '10' });
    await s.sendEmail(mail);
    await s.sendEmail(mail);
    await expect(s.sendEmail(mail)).rejects.toMatchObject({ code: 'MAIL-SEND-LIMIT', status: 'FAILED', message: expect.stringMatching(/2 an hour/) });
    expect(send).toHaveBeenCalledTimes(2);
    advance(61 * MINUTE);
    await s.sendEmail(mail);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('LIM-01 the daily cap holds across hours; a reply counts too', async () => {
    const { s, send, advance } = service({ perHour: '10', perDay: '3' });
    vi.spyOn(s.imap, 'fetchReplyHeaders').mockResolvedValue({ messageId: '<q@x>', subject: 'Q', from: [{ address: 'friend@example.invalid' }], replyTo: [], to: [], cc: [], references: [] });
    await s.sendEmail(mail);
    advance(2 * 60 * MINUTE);
    await s.replyEmail({ mailbox: 'INBOX', uid: 1, text: 'r', newRecipientsConfirmed: true });
    advance(2 * 60 * MINUTE);
    await s.sendEmail(mail);
    advance(2 * 60 * MINUTE);
    await expect(s.sendEmail(mail)).rejects.toMatchObject({ code: 'MAIL-SEND-LIMIT', message: expect.stringMatching(/3 a day/) });
    expect(send).toHaveBeenCalledTimes(3);
    advance(24 * 60 * MINUTE);
    await s.sendEmail(mail);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('LIM-01 defaults are 30 an hour and 200 a day; a refused send (the provider said no) isn\'t counted', async () => {
    expect(loadConfig(base)).toMatchObject({ SEND_LIMIT_PER_HOUR: 30, SEND_LIMIT_PER_DAY: 200 });
    const { s, send } = service({ perHour: '1' });
    send.mockRejectedValueOnce({ command: 'RCPT TO', responseCode: 550 });
    await expect(s.sendEmail(mail)).rejects.toMatchObject({ code: 'SMTP_REJECTED' });
    await s.sendEmail(mail);
    await expect(s.sendEmail(mail)).rejects.toMatchObject({ code: 'MAIL-SEND-LIMIT' });
  });

  it('LIM-04 sends fired together can\'t get past the limit: each takes its place before it goes, and gives it back only if the provider refused it (added: security review, 2.4)', async () => {
    const { s, send } = service({ perHour: '2' });
    send.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ accepted: ['friend@example.invalid'], rejected: [] }), 30)) as never);
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => s.sendEmail(mail)));
    expect(send).toHaveBeenCalledTimes(2);
    expect(outcomes.filter(o => o.status === 'rejected').map(o => (o as PromiseRejectedResult).reason.code)).toEqual(['MAIL-SEND-LIMIT', 'MAIL-SEND-LIMIT', 'MAIL-SEND-LIMIT']);
  });

  it('LIM-03 an account\'s saved limits reach its mail service; accounts saved before limits existed get the defaults', () => {
    const accounts = loadAccounts({
      AUTH_MODE: 'builtin',
      MAIL_ACCOUNTS: JSON.stringify([
        { name: 'me', email: 'me@example.invalid', imap: { host: '127.0.0.1', port: 1, tls: 'none' }, smtp: { host: '127.0.0.1', port: 2, tls: 'none' }, sendLimits: { perHour: 5, perDay: 20 } },
        { name: 'old', email: 'old@example.invalid', imap: { host: '127.0.0.1', port: 1, tls: 'none' }, smtp: { host: '127.0.0.1', port: 2, tls: 'none' } }
      ]),
      MAIL_PASSWORDS: JSON.stringify({ me: 'me-app-password', old: 'old-app-password' })
    });
    expect(accounts[0]!.config).toMatchObject({ SEND_LIMIT_PER_HOUR: 5, SEND_LIMIT_PER_DAY: 20 });
    expect(accounts[1]!.config).toMatchObject({ SEND_LIMIT_PER_HOUR: 30, SEND_LIMIT_PER_DAY: 200 });
  });
});

describe('send limits on your page', () => {
  let p: Awaited<ReturnType<typeof startPage>> | undefined;
  afterEach(async () => { await p?.close(); p = undefined; });
  const last = (list: string[]) => JSON.parse(list.at(-1)!);

  it('LIM-02 each account shows its limits and they can be changed; nonsense is refused; you are told (added: send limits)', async () => {
    p = await startPage();
    await p.signIn();
    expect((await p.get()).html).toMatch(/id="account-work">[\s\S]*?Up to 30 an hour and 200 a day/);
    for (const [perHour, perDay] of [['0', '10'], ['abc', '10'], ['10', '100000'], ['50', '10']]) {
      const refused = await p.act('/accounts/limits', { name: 'work', perHour: perHour!, perDay: perDay! });
      expect(refused.html, `${perHour}/${perDay}`).toContain('Limits are whole numbers');
    }
    const page = await p.act('/accounts/limits', { name: 'work', perHour: '10', perDay: '50' });
    expect(page.html).toContain('work can now send up to 10 an hour and 50 a day');
    expect(last(p.saves.state).accounts.find((a: { name: string }) => a.name === 'work').sendLimits).toEqual({ perHour: 10, perDay: 50 });
    expect(p.sent.at(-1)!.subject).toBe('Sending limits changed for work');
  });
});
