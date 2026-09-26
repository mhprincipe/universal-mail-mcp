import nodemailer from 'nodemailer';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { ImapGateway } from '../src/yahoo/imap.js';
import { composeRaw } from '../src/yahoo/mime.js';

// This is an operator-run integration gate, never a server tool or automatic retry.
if (process.env.DISPOSABLE_TEST_CONFIRMED !== 'yes') throw new Error('This probe sends one message. Set DISPOSABLE_TEST_CONFIRMED=yes only for a disposable Yahoo account.');
const config = loadConfig();
const imap = new ImapGateway(config);
const sent = (await imap.specialFolders()).sent;
if (!sent) throw new Error('No SPECIAL-USE Sent mailbox was advertised.');
const built = await composeRaw({ from: config.YAHOO_EMAIL, to: [config.YAHOO_EMAIL], subject: `MCP disposable Sent probe ${new Date().toISOString()}`, text: 'Disposable integration test.' });
const smtp = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465, requireTLS: config.SMTP_PORT === 587, auth: { user: config.YAHOO_EMAIL, pass: config.YAHOO_APP_PASSWORD }, logger: false, debug: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
console.log(JSON.stringify({ event: 'sent_probe_id', messageId: built.messageId }));
try {
  await smtp.sendMail({ envelope: { from: config.YAHOO_EMAIL, to: [config.YAHOO_EMAIL] }, raw: built.raw });
} catch {
  console.log(JSON.stringify({ status: 'UNKNOWN', messageId: built.messageId, instruction: 'Do not rerun or resend. Inspect the disposable mailbox manually.' }));
  process.exitCode = 1;
  process.exit();
}
try {
  // Observe a delayed automatic copy before considering an IMAP append.
  let hits: number[] = [];
  for (let i = 0; i < 7; i++) {
    if (i) await setTimeout(5000);
    hits = await imap.findByMessageId(sent, built.messageId);
    if (hits.length) break;
  }
  const observedMode = hits.length ? 'yahoo' : 'append';
  if (!hits.length) await imap.append(sent, built.raw, ['\\Seen']);
  await setTimeout(5000);
  hits = await imap.findByMessageId(sent, built.messageId);
  console.log(JSON.stringify({ smtpAccepted: true, messageId: built.messageId, sentCopies: hits.length, observedMode, passed: hits.length === 1, instruction: 'Recheck this Message-ID later for delayed duplicates before configuring SENT_COPY_MODE. No configuration was changed.' }));
  if (hits.length !== 1) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ smtpAccepted: true, messageId: built.messageId, sentStatus: 'UNKNOWN', instruction: 'Do not resend or re-append. Inspect Sent by Message-ID manually.' }));
  process.exitCode = 1;
} finally { smtp.close(); }
