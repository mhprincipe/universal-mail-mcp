import { describe, expect, it } from 'vitest';
import { loadAccounts } from '../src/accountsConfig.js';
import { createCanary } from '../testkit/src/canary.js';

const server = { MCP_ACCESS_SECRET: 'dummy-token-at-least-24-chars' };
const yahoo = { host: 'imap.mail.yahoo.com', port: 993, tls: 'implicit' };
const yahooSmtp = { host: 'smtp.mail.yahoo.com', port: 587 };

describe('account settings', () => {
  it('ENG-16 several accounts load from the stored account list, each with its own password', () => {
    const accounts = loadAccounts({
      ...server,
      MAIL_ACCOUNTS: JSON.stringify([
        { name: 'personal', email: 'me@yahoo.com', imap: yahoo, smtp: yahooSmtp, sentCopyMode: 'yahoo' },
        { name: 'work', email: 'me@fastmail.com', imap: { host: 'imap.fastmail.com', port: 993, tls: 'implicit' },
          smtp: { host: 'smtp.fastmail.com', port: 465 }, sentCopyMode: 'append', reliableHeaderSearch: true }
      ]),
      MAIL_PASSWORDS: JSON.stringify({ personal: 'personal-app-password', work: 'work-app-password' })
    });
    expect(accounts.map(a => ({
      name: a.name, email: a.config.YAHOO_EMAIL, password: a.config.YAHOO_APP_PASSWORD,
      imap: a.config.IMAP_HOST, smtp: `${a.config.SMTP_HOST}:${a.config.SMTP_PORT}`, sent: a.config.SENT_COPY_MODE,
      reliableHeaderSearch: a.reliableHeaderSearch
    }))).toEqual([
      { name: 'personal', email: 'me@yahoo.com', password: 'personal-app-password', imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com:587', sent: 'yahoo', reliableHeaderSearch: false },
      { name: 'work', email: 'me@fastmail.com', password: 'work-app-password', imap: 'imap.fastmail.com', smtp: 'smtp.fastmail.com:465', sent: 'append', reliableHeaderSearch: true }
    ]);
  });

  it('ENG-16 without an account list, v1\'s single-account settings become one account called main', () => {
    const accounts = loadAccounts({ ...server, YAHOO_EMAIL: 'me@yahoo.com', YAHOO_APP_PASSWORD: 'v1-app-password', SENT_COPY_MODE: 'yahoo' });
    expect(accounts.map(a => [a.name, a.config.YAHOO_EMAIL, a.config.SENT_COPY_MODE, a.reliableHeaderSearch])).toEqual([['main', 'me@yahoo.com', 'yahoo', false]]);
  });

  it('ENG-16 a bad account is named in the error, and its password never appears', () => {
    const password = createCanary('app-password');
    const load = (accounts: unknown[], passwords: Record<string, string>) => () =>
      loadAccounts({ ...server, MAIL_ACCOUNTS: JSON.stringify(accounts), MAIL_PASSWORDS: JSON.stringify(passwords) });
    const expectFailure = (run: () => unknown, pattern: RegExp) => {
      let message = '';
      try { run(); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(pattern);
      expect(message).not.toContain(password);
    };

    // Each account gets the same checks as a single account: unencrypted to a remote host is refused.
    expectFailure(load([{ name: 'work', email: 'me@example.com', imap: { host: 'imap.example.com', port: 143, tls: 'none' }, smtp: yahooSmtp }], { work: password }),
      /Account 'work'.*only to this machine/);
    expectFailure(load([{ name: 'work', email: 'not-an-address', imap: yahoo, smtp: yahooSmtp }], { work: password }), /Account 'work'/);
    expectFailure(load([{ name: 'work', email: 'me@example.com', imap: yahoo, smtp: yahooSmtp }], {}), /Account 'work' has no password saved/);
    expectFailure(load([
      { name: 'work', email: 'a@example.com', imap: yahoo, smtp: yahooSmtp },
      { name: 'work', email: 'b@example.com', imap: yahoo, smtp: yahooSmtp }
    ], { work: password }), /'work' is used twice/);
    expectFailure(load([], {}), /No email accounts/);
    // A password pasted where the list belongs. Node's JSON error would quote its
    // first characters, a partial leak a "whole password" check can't see, so
    // the message must be exactly the safe one.
    expect(() => loadAccounts({ ...server, MAIL_ACCOUNTS: '[]', MAIL_PASSWORDS: password })).toThrow(/^MAIL_PASSWORDS isn't valid JSON\.$/);
  });
});
