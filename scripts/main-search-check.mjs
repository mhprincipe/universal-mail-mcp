// One supervised read-only operation. No SMTP, message source fetch, or mutations.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../dist/src/config.js';
import { ImapGateway } from '../dist/src/yahoo/imap.js';

const subject = 'MCP-TEST-20260918-01';
const reportPath = fileURLToPath(new URL('../../main-search-check.json', import.meta.url));
const report = { operation: 'search_email', passed: false, subject, mailbox: 'INBOX', startedAt: new Date().toISOString(), messageBodiesRead: false, mailMutated: false, smtpUsed: false };
function save() { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
const deadline = setTimeout(() => {
  report.stage = 'timeout'; report.finishedAt = new Date().toISOString(); save();
  console.error('Search timed out; no messages were changed.'); process.exit(1);
}, 60000);
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  const config = loadConfig();
  if (config.IMAP_HOST !== 'imap.mail.yahoo.com' || config.IMAP_PORT !== 993 || config.SENT_COPY_MODE !== 'unverified') throw new Error('unexpected-configuration');
  report.accountFingerprint = createHash('sha256').update(config.YAHOO_EMAIL.toLowerCase()).digest('hex');
  report.stage = 'searching'; save();
  console.log('Searching INBOX for the exact test subject; metadata only.');
  const matches = await new ImapGateway(config).search({ mailbox: 'INBOX', subject, from: config.YAHOO_EMAIL, to: config.YAHOO_EMAIL, limit: 5 });
  const exact = matches.filter(message => message.subject === subject
    && message.from.some(address => address.address.toLowerCase() === config.YAHOO_EMAIL.toLowerCase())
    && message.to.some(address => address.address.toLowerCase() === config.YAHOO_EMAIL.toLowerCase()));
  report.exactMatchCount = exact.length;
  if (exact.length !== 1 || !exact[0].messageId) {
    report.stage = 'needs-review';
    console.log('No unique identifiable test message found. Stopping without further operations.');
    process.exitCode = 1;
  } else {
    const message = exact[0];
    report.message = { mailbox: message.mailbox, uid: message.uid, messageId: message.messageId, subject: message.subject, read: message.read, flagged: message.flagged };
    report.passed = true; report.stage = 'complete';
    console.log(`PASS: found exactly one test message. Unread: ${!message.read}. No body fetched or flags changed.`);
  }
} catch {
  report.stage = 'failed'; report.error = 'Search could not complete. Credentials and provider error text are omitted.';
  console.error(report.error); process.exitCode = 1;
} finally {
  clearTimeout(deadline); report.finishedAt = new Date().toISOString(); save();
  console.log(`Report saved to ${reportPath}`);
}
