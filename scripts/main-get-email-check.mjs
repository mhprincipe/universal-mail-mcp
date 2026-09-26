// One supervised get_email check with read-only identity and flag verification.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../dist/src/config.js';
import { MailService } from '../dist/src/yahoo/mailService.js';

const reportPath = fileURLToPath(new URL('../../main-get-email-check.json', import.meta.url));
const report = { operation: 'get_email', passed: false, startedAt: new Date().toISOString(), mutationCommandsIssued: false, smtpUsed: false, bodyLogged: false };
function save() { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
const deadline = setTimeout(() => {
  report.stage = 'timeout'; report.finishedAt = new Date().toISOString(); save();
  console.error('Read verification timed out. No mutation commands were issued.'); process.exit(1);
}, 60000);
try {
  const prior = JSON.parse(readFileSync(new URL('../../main-search-check.json', import.meta.url), 'utf8'));
  if (!prior.passed || prior.operation !== 'search_email' || prior.exactMatchCount !== 1 || prior.message?.subject !== 'MCP-TEST-20260918-01' || prior.message?.mailbox !== 'INBOX' || !Number.isSafeInteger(prior.message?.uid) || prior.message.uid <= 0 || !prior.message?.messageId) throw new Error('invalid-prior-report');
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  const config = loadConfig();
  const fingerprint = createHash('sha256').update(config.YAHOO_EMAIL.toLowerCase()).digest('hex');
  if (fingerprint !== prior.accountFingerprint || config.IMAP_HOST !== 'imap.mail.yahoo.com' || config.IMAP_PORT !== 993 || config.SENT_COPY_MODE !== 'unverified') throw new Error('configuration-mismatch');
  const service = new MailService(config);
  const target = prior.message;
  const assertIdentity = message => {
    if (!message || message.uid !== target.uid || message.mailbox !== target.mailbox || message.messageId !== target.messageId || message.subject !== target.subject
      || !message.from.some(address => address.address.toLowerCase() === config.YAHOO_EMAIL.toLowerCase())
      || !message.to.some(address => address.address.toLowerCase() === config.YAHOO_EMAIL.toLowerCase())) throw new Error('identity-mismatch');
  };
  report.stage = 'verifying-test-message'; save();
  console.log('Checking the recorded test message identity and unread flag.');
  const matches = await service.imap.findByMessageId(target.mailbox, target.messageId);
  if (matches.length !== 1 || matches[0] !== target.uid) throw new Error('identity-mismatch');
  const before = await service.imap.fetchSummary(target.mailbox, target.uid);
  assertIdentity(before);
  report.readBefore = before.read;
  if (before.read) throw new Error('already-read');
  report.stage = 'retrieving-test-message'; report.bodyRetrievalAttempted = true; save();
  const result = await service.getEmail(target.mailbox, target.uid);
  assertIdentity(result.data);
  if (!result.ok || result.data.untrustedContent !== true) throw new Error('invalid-result');
  report.bodyRetrieved = true;
  report.untrustedContent = true;
  report.bodyPresent = Boolean(result.data.text || result.data.html);
  // Discard parsed content without printing or persisting it.
  result.data = undefined;
  report.stage = 'checking-unread-after'; save();
  const after = await service.imap.fetchSummary(target.mailbox, target.uid);
  assertIdentity(after);
  report.readAfter = after.read;
  report.unreadPreserved = !before.read && !after.read;
  report.flagsUnchanged = before.read === after.read && before.flagged === after.flagged;
  if (!report.unreadPreserved || !report.flagsUnchanged) throw new Error('flags-changed');
  report.passed = true; report.stage = 'complete';
  console.log('PASS: retrieved only the test message; it remains unread. No body logged, mutation commands, or SMTP connection.');
} catch (error) {
  report.stage = 'failed';
  const safe = new Map([
    ['already-read', 'The test message was already read before retrieval. Stopped before fetching its body.'],
    ['identity-mismatch', 'The test-message identity did not match. Stopped without issuing mutations.'],
    ['flags-changed', 'The observed flags changed. No mutation commands were issued; review required.'],
    ['configuration-mismatch', 'Account or configuration differs from the verified search. Stopped.'],
    ['invalid-prior-report', 'A valid unique search result is required before this check.']
  ]);
  report.error = safe.get(error?.message) ?? 'Read verification failed. Credentials, email content and provider error text are omitted.';
  console.error(report.error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); report.finishedAt = new Date().toISOString(); save();
  console.log(`Report saved to ${reportPath}`);
}
