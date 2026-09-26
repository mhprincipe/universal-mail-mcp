import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../dist/src/config.js';
import { MailService } from '../dist/src/yahoo/mailService.js';
const run = JSON.parse(readFileSync(new URL('../../main-integration-check.json', import.meta.url), 'utf8'));
const prior = JSON.parse(readFileSync(new URL('../../main-search-check.json', import.meta.url), 'utf8'));
process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const config = loadConfig();
if (createHash('sha256').update(config.YAHOO_EMAIL.toLowerCase()).digest('hex') !== prior.accountFingerprint) throw new Error('Account mismatch');
const service = new MailService(config);
const labels = new Map([[run.target.messageId, 'original'], [run.replyTest.messageId, 'reply'], [run.sentTest.messageId, 'new-send']]);
const report = { startedAt: new Date().toISOString(), stage: 'state-check', readOnly: true, fetches: [], searches: [], errors: [] };
const path = fileURLToPath(new URL('../../main-thread-diagnosis.json', import.meta.url));
const save = () => writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
const timer = setTimeout(() => { report.stage = 'timeout'; save(); process.exit(1); }, 360000);
const heartbeat = setInterval(() => console.log(`Read-only thread check: ${report.stage}; folders searched: ${report.searches.length}`), 20000);
try {
 const roles = await service.imap.specialFolders();
 const before = await service.imap.fetchSummary(run.target.mailbox, run.target.uid);
 if (before.messageId !== run.target.messageId) throw new Error('Identity mismatch');
 report.originalInInbox = run.target.mailbox.toUpperCase() === 'INBOX';
 report.originalUnread = !before.read; report.originalUnflagged = !before.flagged;
 report.sentCopies = { newSend: (await service.imap.findByMessageId(roles.sent, run.sentTest.messageId)).length, reply: (await service.imap.findByMessageId(roles.sent, run.replyTest.messageId)).length };
 console.log(JSON.stringify({ originalInInbox: report.originalInInbox, originalUnread: report.originalUnread, originalUnflagged: report.originalUnflagged, sentCopies: report.sentCopies }));
 const get = service.getEmail.bind(service);
 service.getEmail = async (mailbox, uid) => {
   const summary = await service.imap.fetchSummary(mailbox, uid);
   const label = labels.get(summary.messageId);
   if (!label) { report.errors.push('Out-of-scope body blocked'); save(); throw new Error('blocked'); }
   const data = await get(mailbox, uid);
   report.fetches.push({ label, uid, read: data.data.read, parsedIdMatches: data.data.messageId === summary.messageId, referenceCount: data.data.references.length, referencesOriginal: data.data.references.includes(run.target.messageId), inReplyToOriginal: data.data.inReplyTo === run.target.messageId });
   save(); return data;
 };
 const seed = (await service.getEmail(run.target.mailbox, run.target.uid)).data;
 const replyUids = await service.imap.findByMessageId(roles.inbox, run.replyTest.messageId);
 if (replyUids.length !== 1) throw new Error('Reply is not unique');
 const reply = (await service.getEmail(roles.inbox, replyUids[0])).data;
 const root = seed.references[0] ?? seed.inReplyTo ?? seed.messageId;
 report.rootEqualsOriginal = root === run.target.messageId;
 report.replyReferencesRoot = reply.references.includes(root);
 console.log(JSON.stringify({ rootEqualsOriginal: report.rootEqualsOriginal, replyReferencesRoot: report.replyReferencesRoot }));
 const find = service.imap.findThreadUids.bind(service.imap);
 service.imap.findThreadUids = async (mailbox, id, options) => {
   try { const hits = await find(mailbox, id, options); report.searches.push({ index: report.searches.length + 1, hits: hits.length }); save(); return hits; }
   catch (error) { report.errors.push('Thread folder search failed'); save(); throw error; }
 };
 report.stage = 'get_thread'; save();
 const thread = await service.getThread(run.target.mailbox, run.target.uid);
 report.threadLabels = thread.data.map(message => labels.get(message.messageId) ?? 'unknown');
 report.returnedCount = thread.data.length;
 report.warnings = thread.warnings;
 const after = await service.imap.fetchSummary(run.target.mailbox, run.target.uid);
 report.passed = report.threadLabels.includes('original') && report.threadLabels.includes('reply') && report.returnedCount === 2 && report.errors.length === 0 && !after.read && !after.flagged && report.sentCopies.newSend === 1 && report.sentCopies.reply === 1;
 if (!report.passed) throw new Error('Verification failed');
 report.stage = 'complete';
 console.log(JSON.stringify({ threadLabels: report.threadLabels, returnedCount: report.returnedCount, errors: report.errors }));
} catch { report.stage = 'failed'; report.failure = 'Read-only diagnosis failed; no mutation or send attempted.'; process.exitCode = 1; }
finally { clearTimeout(timer); clearInterval(heartbeat); report.finishedAt = new Date().toISOString(); save(); }
