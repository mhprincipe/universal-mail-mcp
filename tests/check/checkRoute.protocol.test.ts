import { generateKeyPairSync, randomBytes, type JsonWebKey } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mintCheckToken } from '../../src/setup/checkToken.js';
import { VERSION } from '../../src/version.js';
import { startImapServer, type ImapServer } from '../../testkit/src/imapServer.js';
import { peek, seed } from '../../testkit/src/seed.js';
import { startSmtpCapture, type SmtpCapture } from '../../testkit/src/smtpCapture.js';
import { issuer, startSignin, type Signin } from '../signin/harness.js';

// DIA-08 (added) against real servers: two accounts, a Yahoo-like one with
// mail and a Gmail-like one with an empty inbox. Every stage passes, and the
// check leaves the mail exactly as it was.
let yahooLike: ImapServer;
let gmailLike: ImapServer;
let smtp: SmtpCapture;
let signin: Signin | undefined;
beforeAll(async () => {
  [yahooLike, gmailLike] = await Promise.all([startImapServer('yahoo-like'), startImapServer('gmail-like')]);
  smtp = await startSmtpCapture();
  await seed(yahooLike, { messages: [{ mailbox: 'INBOX', subject: 'Unread and staying that way' }] });
});
afterAll(async () => { await smtp?.stop(); await Promise.all([yahooLike, gmailLike].map(s => s?.stop())); });
afterEach(async () => { await signin?.close(); signin = undefined; vi.restoreAllMocks(); });

async function checkWith(passwords: Record<string, string>) {
  const jwk: JsonWebKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  const account = (name: string, server: ImapServer, sentCopyMode: string) => ({
    name, email: server.user, sentCopyMode,
    imap: { host: server.host, port: server.port, tls: 'none' }, smtp: { host: smtp.host, port: smtp.port, tls: 'none' }
  });
  signin = await startSignin({
    SIGNIN_SIGNING_KEY: JSON.stringify(jwk), SIGNIN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    MAIL_ACCOUNTS: JSON.stringify([account('me', yahooLike, 'yahoo'), account('fleet', gmailLike, 'append')]),
    MAIL_PASSWORDS: JSON.stringify(passwords)
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const token = mintCheckToken(jwk, { issuer, audience: `${issuer}/${signin.key}/check`, now: Date.now() });
  const response = await fetch(`${signin.base}/${signin.key}/check`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ expectedVersion: VERSION })
  });
  const report = await response.json();
  return { report, summary: report.stages.map((s: { stage: string; status: string; code?: string }) => `${s.stage}=${s.status}${s.code ? `:${s.code}` : ''}`) };
}

describe('the check route on real servers', () => {
  it('DIA-08 every stage passes, and the mail is left exactly as it was (added)', async () => {
    const before = await peek(yahooLike, 'INBOX');
    const { report, summary } = await checkWith({ me: yahooLike.password, fleet: gmailLike.password });
    expect(summary).toEqual([
      'server=PASS', 'signin=PASS',
      'account:me=PASS', 'tools:me=PASS', 'live:me=PASS', 'sent:me=PASS',
      'account:fleet=PASS', 'tools:fleet=PASS', 'live:fleet=PASS', 'sent:fleet=PASS'
    ]);
    expect(report.result).toBe('PASS');
    expect(await peek(yahooLike, 'INBOX')).toEqual(before);
    expect(before.some(m => !m.seen)).toBe(true);
    // DIA-09 (added): the live check's test message went through every change
    // and ended in Trash; its folder is left empty. Yahoo's layout and Gmail's.
    for (const [server, trash] of [[yahooLike, 'Trash'], [gmailLike, '[Gmail]/Trash']] as const) {
      expect(await peek(server, 'Universal Mail check'), trash).toEqual([]);
      const binned = (await peek(server, trash)).filter(m => m.subject === 'Universal Mail check: you can delete this');
      expect(binned, trash).toHaveLength(1);
      expect(binned[0], trash).toMatchObject({ seen: false, flagged: false });
    }
  });

  it('DIA-08 a password the server no longer accepts is reported as exactly that; the other account still passes', async () => {
    const { summary, report } = await checkWith({ me: 'revoked-app-password', fleet: gmailLike.password });
    expect(summary).toEqual([
      'server=PASS', 'signin=PASS',
      'account:me=FAIL:MAIL-APP-PASSWORD-REJECTED', 'tools:me=NOT_RUN', 'live:me=NOT_RUN', 'sent:me=NOT_RUN',
      'account:fleet=PASS', 'tools:fleet=PASS', 'live:fleet=PASS', 'sent:fleet=PASS'
    ]);
    expect(JSON.stringify(report)).not.toContain('revoked-app-password');
  });
});
