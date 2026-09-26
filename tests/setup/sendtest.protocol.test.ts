import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSetupLog } from '../../src/setup/log.js';
import { sendTestEmail } from '../../src/setup/mailcheck.js';
import { isSystemMessageId } from '../../src/systemMail.js';
import { createCanary } from '../../testkit/src/canary.js';
import { startImapServer, type ImapServer } from '../../testkit/src/imapServer.js';
import { peek, seed } from '../../testkit/src/seed.js';
import { startSmtpCapture, type CaptureOptions } from '../../testkit/src/smtpCapture.js';

// SET-73 (added): step 7's sending test, against a real IMAP server. One test
// email to the account itself, then Sent is opened read-only and its newest
// messages are counted by Message-ID (not header search: Yahoo's is unreliable).
let yahooLike: ImapServer;
let gmailLike: ImapServer;
let home: string;
const stops: Array<() => Promise<void>> = [];

beforeAll(async () => {
  [yahooLike, gmailLike] = await Promise.all([startImapServer('yahoo-like'), startImapServer('gmail-like')]);
  home = mkdtempSync(join(tmpdir(), 'sendtest-'));
  // Older mail already in Sent: the count must find the new one among it.
  await seed(yahooLike, { messages: Array.from({ length: 12 }, (_, i) => ({ mailbox: 'Sent', subject: `Earlier ${i}` })) });
});
afterAll(async () => {
  for (const stop of stops) await stop();
  await Promise.all([yahooLike, gmailLike].map(s => s?.stop()));
  rmSync(home, { recursive: true, force: true });
});

async function sendingTo(server: ImapServer, capture: CaptureOptions) {
  const smtp = await startSmtpCapture(capture);
  stops.push(smtp.stop);
  return {
    smtp,
    endpoints: { imap: { host: server.host, port: server.port, tls: 'none' as const }, smtp: { host: smtp.host, port: smtp.port, tls: 'none' as const } }
  };
}
const quick = { tries: 3, everyMs: 50 };

describe('the sending test on a real server', () => {
  it('SET-73 the provider files the copy: one found in Sent, among older mail (added)', async () => {
    const { smtp, endpoints } = await sendingTo(yahooLike, { saveTo: { server: yahooLike, mailbox: 'Sent' } });
    const log = createSetupLog(home, Date);
    const before = await peek(yahooLike, 'Sent');
    expect(await sendTestEmail(yahooLike.user, yahooLike.password, endpoints, { log, poll: quick })).toEqual({ copies: 1 });

    // One email, from the account to itself, marked as a system email.
    expect(smtp.messages).toHaveLength(1);
    const sent = smtp.messages[0]!;
    expect(sent.from).toBe(yahooLike.user);
    expect(sent.to).toEqual([yahooLike.user]);
    const headers = sent.raw.toString('utf8').split('\r\n\r\n')[0]!;
    expect(isSystemMessageId(/^Message-ID: (.+)$/mi.exec(headers)?.[1]?.trim())).toBe(true);
    expect(headers).toMatch(/^X-Universal-Mail: system$/m);
    expect(headers).toMatch(/^Subject: Universal Mail test$/m);

    // Sent was only looked at: nothing older was marked read or changed.
    const after = await peek(yahooLike, 'Sent');
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('SET-73 the provider files nothing: none found, after waiting', async () => {
    const { endpoints } = await sendingTo(yahooLike, {});
    const log = createSetupLog(home, Date);
    const started = Date.now();
    expect(await sendTestEmail(yahooLike.user, yahooLike.password, endpoints, { log, poll: quick })).toEqual({ copies: 0 });
    // Three looks, two waits of 50ms between them (timers may fire a little early).
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('SET-73 the provider files two copies: both counted', async () => {
    const { endpoints } = await sendingTo(yahooLike, { saveTo: { server: yahooLike, mailbox: 'Sent', times: 2 } });
    const log = createSetupLog(home, Date);
    expect(await sendTestEmail(yahooLike.user, yahooLike.password, endpoints, { log, poll: quick })).toEqual({ copies: 2 });
  });

  it('SET-73 Gmail\'s Sent is "[Gmail]/Sent Mail", found by its special-use flag', async () => {
    const { endpoints } = await sendingTo(gmailLike, { saveTo: { server: gmailLike, mailbox: '[Gmail]/Sent Mail' } });
    const log = createSetupLog(home, Date);
    expect(await sendTestEmail(gmailLike.user, gmailLike.password, endpoints, { log, poll: quick })).toEqual({ copies: 1 });
  });

  it('SET-73 the log shows each stage and the Sent folder used, and never the password', async () => {
    const password = createCanary('send-test-password');
    const own = mkdtempSync(join(tmpdir(), 'sendtest-log-'));
    try {
      const { endpoints } = await sendingTo(yahooLike, { saveTo: { server: yahooLike, mailbox: 'Sent' } });
      const log = createSetupLog(own, Date);
      log.secret(password);
      // The capture accepts any password; the IMAP server wants its own, so this one fails at the count.
      await expect(sendTestEmail(yahooLike.user, password, endpoints, { log, poll: quick })).rejects.toThrow('the Sent folder could not be read: rejected');
      const text = readFileSync(join(own, '.universal-mail', 'setup-log.jsonl'), 'utf8');
      expect(text).not.toContain(password);
      const detail = text.trim().split('\n').map(l => JSON.parse(l)).find(e => e.op === 'send-test-detail');
      expect(detail).toMatchObject({ type: 'mail', sending: 'ok', counting: 'rejected' });

      const ok = createSetupLog(own, Date);
      await sendTestEmail(yahooLike.user, yahooLike.password, endpoints, { log: ok, poll: quick });
      const last = readFileSync(join(own, '.universal-mail', 'setup-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'send-test-detail').at(-1);
      expect(last).toMatchObject({ sending: 'ok', counting: 'ok', sentFolder: 'Sent', copies: 1 });
      expect(last.polls).toBeGreaterThanOrEqual(1);
    } finally { rmSync(own, { recursive: true, force: true }); }
  });
});
