import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSetupLog } from '../../src/setup/log.js';
import { checkAccount } from '../../src/setup/mailcheck.js';
import { startImapServer, type ImapServer } from '../../testkit/src/imapServer.js';
import { startSmtpCapture, type SmtpCapture } from '../../testkit/src/smtpCapture.js';

// SET-69 (added): the built-ins-only check against a real IMAP server (Dovecot),
// not just the tiny one in mailcheck.test.ts.
let yahooLike: ImapServer;
let hostile: ImapServer;
let smtp: SmtpCapture;
let home: string;

beforeAll(async () => {
  [yahooLike, hostile] = await Promise.all([startImapServer('yahoo-like'), startImapServer('hostile')]);
  smtp = await startSmtpCapture({ password: yahooLike.password });
  home = mkdtempSync(join(tmpdir(), 'mailcheck-protocol-'));
});
afterAll(async () => {
  await smtp?.stop();
  await Promise.all([yahooLike, hostile].map(s => s?.stop()));
  rmSync(home, { recursive: true, force: true });
});

const endpoints = (server: ImapServer) => ({
  imap: { host: server.host, port: server.port, tls: 'none' as const },
  smtp: { host: smtp.host, port: smtp.port, tls: 'none' as const }
});

describe('the email password check on a real server', () => {
  it('SET-69 signs in, counts the real folders, sees safe moves; a wrong password is rejected (added)', async () => {
    const log = createSetupLog(home, Date);
    expect(await checkAccount(yahooLike.user, yahooLike.password, endpoints(yahooLike), { log })).toEqual({ ok: true, folders: 6, safeMove: true });
    expect(await checkAccount(yahooLike.user, 'not-the-password', endpoints(yahooLike), { log })).toEqual({ ok: false, reason: 'rejected' });
  });

  it('SET-69 a real server without MOVE or UIDPLUS is reported as unable to move safely', async () => {
    const log = createSetupLog(home, Date);
    // The SMTP capture accepts the yahoo-like server's password; the hostile server has its own.
    const loose = await startSmtpCapture();
    try {
      const result = await checkAccount(hostile.user, hostile.password, { imap: endpoints(hostile).imap, smtp: { host: loose.host, port: loose.port, tls: 'none' } }, { log });
      expect(result).toEqual({ ok: true, folders: 6, safeMove: false });
    } finally { await loose.stop(); }
  });
});
