// Explicitly authorized supervised integration. Never rerun an existing report.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/src/config.js';
import { MailService } from '../dist/src/yahoo/mailService.js';

const reportPath = fileURLToPath(new URL('../../main-integration-check.json', import.meta.url));
if (existsSync(reportPath)) throw new Error('An integration report already exists. Inspect it; do not repeat mutations automatically.');
const prior = JSON.parse(readFileSync(new URL('../../main-search-check.json', import.meta.url), 'utf8'));
const priorRead = JSON.parse(readFileSync(new URL('../../main-get-email-check.json', import.meta.url), 'utf8'));
process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const config = loadConfig();
assert(prior.passed && priorRead.passed && prior.exactMatchCount === 1);
assert.equal(createHash('sha256').update(config.YAHOO_EMAIL.toLowerCase()).digest('hex'), prior.accountFingerprint);
assert.equal(config.IMAP_HOST, 'imap.mail.yahoo.com'); assert.equal(config.IMAP_PORT, 993);
assert.equal(config.SMTP_HOST, 'smtp.mail.yahoo.com'); assert([465, 587].includes(config.SMTP_PORT));
assert.equal(config.SENT_COPY_MODE, 'unverified');
const original = prior.message;
assert.equal(original.subject, 'MCP-TEST-20260918-01'); assert.equal(original.mailbox, 'INBOX');
assert(original.messageId && Number.isSafeInteger(original.uid));
const runId = randomUUID();
const testFolder = `MCP-Test-${runId.slice(0, 8)}`;
const testSubject = `${original.subject} integration ${runId.slice(0, 8)}`;
const report = { runId, startedAt: new Date().toISOString(), passed: false, phase: 'preflight',
  passedTools: ['list_folders', 'search_email', 'get_email'], checks: [], smtpAttempts: [],
  target: { ...original }, testFolder, configChanged: false, liveFaultInjection: false,
  note: 'Main-account substitute plan authorized by user; disposable-account gate is not claimed.' };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const allowedIds = new Set([original.messageId]);
const rawById = new Map();
let bodyGuardFailures = 0;
let threadSearchFailures = 0;
let deadline;
function finishCheck(label, tool) {
  report.checks.push({ label, passed: true, at: new Date().toISOString() });
  if (tool && !report.passedTools.includes(tool)) report.passedTools.push(tool);
  save(); console.log(`PASS: ${label}`);
}
async function step(label, action, tool) {
  report.phase = label; report.phaseStartedAt = new Date().toISOString(); save();
  console.log(`RUN: ${label}`);
  deadline = setTimeout(() => {
    report.phase = 'STOPPED_UNKNOWN'; report.failure = `Timeout during ${label}. Do not repeat an operation without reconciliation.`;
    report.finishedAt = new Date().toISOString(); save(); console.error(report.failure); process.exit(1);
  }, 300000);
  try { await action(); finishCheck(label, tool); }
  finally { clearTimeout(deadline); }
}
function ownSummary(message, id, subject) {
  assert.equal(message.messageId, id, 'Test Message-ID mismatch');
  if (subject) assert.equal(message.subject, subject, 'Test subject mismatch');
  assert(message.from.some(a => a.address.toLowerCase() === config.YAHOO_EMAIL.toLowerCase()), 'Sender not self');
  assert(message.to.some(a => a.address.toLowerCase() === config.YAHOO_EMAIL.toLowerCase()), 'Recipient not self');
}
function guardedService(mode = 'unverified') {
  const service = new MailService({ ...config, SENT_COPY_MODE: mode });
  const get = service.getEmail.bind(service);
  service.getEmail = async (mailbox, uid) => {
    const summary = await service.imap.fetchSummary(mailbox, uid);
    if (!allowedIds.has(summary.messageId)) { bodyGuardFailures++; throw new Error('Body retrieval outside test allowlist blocked'); }
    ownSummary(summary, summary.messageId);
    return get(mailbox, uid);
  };
  const findThread = service.imap.findThreadUids.bind(service.imap);
  service.imap.findThreadUids = async (...args) => {
    try { return await findThread(...args); } catch (e) { threadSearchFailures++; throw e; }
  };
  // Exercise the actual service send logic, adding a harness-only recipient guard
  // and retaining exact transmitted MIME in memory for the Sent observation gate.
  const send = service.smtp.sendMail.bind(service.smtp);
  service.smtp.sendMail = async options => {
    const envelope = options.envelope;
    assert.equal(envelope.from.toLowerCase(), config.YAHOO_EMAIL.toLowerCase());
    assert(Array.isArray(envelope.to) && envelope.to.length === 1 && envelope.to[0].toLowerCase() === config.YAHOO_EMAIL.toLowerCase(), 'Only self-addressed mail allowed');
    assert(Buffer.isBuffer(options.raw));
    const id = options.raw.toString('utf8').match(/^Message-ID:\s*(<[^>\r\n]+>)/im)?.[1];
    assert(id && !rawById.has(id) && report.smtpAttempts.length < 2, 'Duplicate or excess send prevented');
    rawById.set(id, options.raw); allowedIds.add(id);
    report.smtpAttempts.push({ messageId: id, attemptedAt: new Date().toISOString(), mimeSha256: createHash('sha256').update(options.raw).digest('hex') });
    save();
    return send(options);
  };
  return service;
}
const service = guardedService();
let roles;
let initial;
let draft;
let sentTest;
let replyTest;
let policy;
async function assertTarget() {
  const current = report.target;
  const hits = await service.imap.findByMessageId(current.mailbox, original.messageId);
  assert(hits.length === 1 && hits[0] === current.uid, 'Current test UID is not uniquely verified');
  const summary = await service.imap.fetchSummary(current.mailbox, current.uid);
  ownSummary(summary, original.messageId, original.subject);
  return summary;
}
async function assertDraft(current) {
  assert.equal(current.mailbox, roles.drafts);
  const hits = await service.imap.findByMessageId(current.mailbox, current.messageId);
  assert.equal(hits.length, 1);
  if (current.uid !== undefined) assert.equal(hits[0], current.uid);
  current.uid = hits[0];
  ownSummary(await service.imap.fetchSummary(current.mailbox, current.uid), current.messageId, testSubject);
  save();
}
async function relocated(destination, action) {
  await assertTarget();
  assert.equal((await service.imap.findByMessageId(destination, original.messageId)).length, 0, 'Destination already has this test Message-ID');
  const source = { ...report.target };
  const result = await action(source);
  assert(result.ok && result.status === 'SUCCESS');
  const destHits = await service.imap.findByMessageId(destination, original.messageId);
  const sourceHits = await service.imap.findByMessageId(source.mailbox, original.messageId);
  assert.equal(destHits.length, 1); assert.equal(sourceHits.length, 0);
  report.target = { ...original, mailbox: destination, uid: destHits[0] }; save();
  await assertTarget();
}
async function visible(mailbox, id) {
  for (let i = 0; i < 7; i++) {
    const hits = await service.imap.findByMessageId(mailbox, id);
    assert(hits.length <= 1, 'Duplicate test Message-ID found');
    if (hits.length) return hits;
    if (i < 6) await delay(5000);
  }
  return [];
}
const heartbeat = setInterval(() => console.log(`Still running: ${report.phase}`), 30000);
try {
  await step('Verify target and special folders', async () => {
    initial = await assertTarget();
    assert.equal(initial.read, false, 'Test email is no longer unread');
    roles = await service.imap.specialFolders();
    for (const role of ['inbox', 'drafts', 'sent', 'archive', 'trash']) assert(roles[role], `Missing ${role} role`);
    assert.equal(roles.inbox.toUpperCase(), 'INBOX');
    assert.equal(new Set([roles.inbox, roles.drafts, roles.sent, roles.archive, roles.trash]).size, 5);
    const message = (await service.getEmail(original.mailbox, original.uid)).data;
    assert(message && !message.inReplyTo, 'Seed must not be a reply');
    report.seedReferenceCount = message.references.length;
    assert(message.replyTo.length === 0 || message.replyTo.every(a => a.address.toLowerCase() === config.YAHOO_EMAIL.toLowerCase()));
    assert.equal((await assertTarget()).read, false);
  });
  await step('Verify initial test thread stays inside the body allowlist', async () => {
    const result = await service.getThread(original.mailbox, original.uid);
    assert(result.ok && result.data.length === 1 && result.data[0].messageId === original.messageId);
    assert.equal(bodyGuardFailures, 0); assert.equal(threadSearchFailures, 0);
  }, 'get_thread');
  await step('Create isolated test folder', async () => {
    assert(!(await service.imap.listFolders()).some(f => f.path === testFolder));
    const result = await service.createFolder(testFolder); assert(result.ok);
    assert((await service.imap.listFolders()).some(f => f.path === testFolder && f.selectable));
  }, 'create_folder');
  await step('Existing test folder is safe to request again', async () => {
    const result = await service.createFolder(testFolder); assert(result.ok); assert.equal(result.data.created, false);
  });
  await step('Create self-addressed test draft', async () => {
    const result = await service.createDraft({ to: [config.YAHOO_EMAIL], subject: testSubject, text: 'Automated integration test draft. Harmless test content.' });
    assert(result.ok && !result.warnings?.length); draft = result.data; allowedIds.add(draft.messageId);
    report.draft = draft; save(); await assertDraft(draft);
  }, 'create_draft');
  await step('Replace only the newly created test draft', async () => {
    await assertDraft(draft); const old = { ...draft };
    const result = await service.updateDraft({ mailbox: draft.mailbox, uid: draft.uid, text: 'Updated harmless integration test draft.' });
    assert(result.ok); draft = result.data; allowedIds.add(draft.messageId); report.draft = draft; save();
    await assertDraft(draft);
    assert(!result.warnings?.length, 'Draft cleanup warning; inspect before continuing');
    assert.equal((await service.imap.findByMessageId(old.mailbox, old.messageId)).length, 0);
    const newBody = (await service.getEmail(draft.mailbox, draft.uid)).data;
    assert(newBody?.text?.includes('Updated harmless integration test draft.'));
  }, 'update_draft');
  await step('Reject updating the Inbox test message as a draft', async () => {
    await assertTarget();
    await assert.rejects(service.updateDraft({ mailbox: report.target.mailbox, uid: report.target.uid, text: 'Must never apply' }), error => error.code === 'NOT_A_DRAFT_MAILBOX');
  });
  await step('Mark test message read twice safely', async () => {
    for (let i = 0; i < 2; i++) { await assertTarget(); await service.markRead(report.target.mailbox, report.target.uid); assert.equal((await assertTarget()).read, true); }
  }, 'mark_read');
  await step('Mark test message unread twice safely', async () => {
    for (let i = 0; i < 2; i++) { await assertTarget(); await service.markUnread(report.target.mailbox, report.target.uid); assert.equal((await assertTarget()).read, false); }
  }, 'mark_unread');
  await step('Flag and restore the test message flag', async () => {
    await assertTarget(); await service.flagEmail(report.target.mailbox, report.target.uid, !initial.flagged);
    assert.equal((await assertTarget()).flagged, !initial.flagged);
    await service.flagEmail(report.target.mailbox, report.target.uid, initial.flagged);
    assert.equal((await assertTarget()).flagged, initial.flagged);
  }, 'flag_email');
  await step('Reject a missing destination without guessing', async () => {
    await assertTarget();
    await assert.rejects(service.moveEmail(report.target.mailbox, report.target.uid, `${testFolder}-does-not-exist`), error => error.code === 'FOLDER_NOT_FOUND');
    await assertTarget();
  });
  await step('Move test email into the test folder', async () => {
    await relocated(testFolder, target => service.moveEmail(target.mailbox, target.uid, testFolder));
  }, 'move_email');
  await step('Restore test email to Inbox', async () => {
    await relocated(roles.inbox, target => service.restoreEmail(target.mailbox, target.uid));
  }, 'restore_email');
  await step('Archive only the test email', async () => {
    await relocated(roles.archive, target => service.archiveEmail(target.mailbox, target.uid));
  }, 'archive_email');
  await step('Restore archived test email', async () => {
    await relocated(roles.inbox, target => service.restoreEmail(target.mailbox, target.uid));
  });
  await step('Trash only the test email', async () => {
    await relocated(roles.trash, target => service.trashEmail(target.mailbox, target.uid));
  }, 'trash_email');
  await step('Restore trashed test email', async () => {
    await relocated(roles.inbox, target => service.restoreEmail(target.mailbox, target.uid));
    const restored = await assertTarget(); assert.equal(restored.read, initial.read); assert.equal(restored.flagged, initial.flagged);
  });
  await step('Send exactly one self-addressed message and observe Sent behavior', async () => {
    // Observation-only yahoo mode never appends a copy. This is scoped to this
    // diagnostic instance; the saved server configuration remains unverified.
    const observer = guardedService('yahoo');
    const result = await observer.sendEmail({ to: [config.YAHOO_EMAIL], subject: `${testSubject} send`, text: 'Self-addressed Yahoo MCP integration test. No action needed.' });
    assert(result.ok && result.code === 'SENT'); assert.equal(result.data.rejected?.length ?? 0, 0);
    sentTest = result.data; report.sentTest = { messageId: sentTest.messageId, smtpAccepted: true }; save();
    let hits = await visible(roles.sent, sentTest.messageId);
    if (hits.length === 1) policy = 'yahoo';
    else {
      policy = 'append'; report.sentAppendAttempted = true; save();
      const raw = rawById.get(sentTest.messageId); assert(raw);
      await service.imap.append(roles.sent, raw, ['\\Seen']);
      hits = await visible(roles.sent, sentTest.messageId);
    }
    assert.equal(hits.length, 1);
    assert.equal((await visible(roles.inbox, sentTest.messageId)).length, 1);
    report.sentCopyModeObserved = policy; save();
    await delay(30000);
    assert.equal((await service.imap.findByMessageId(roles.sent, sentTest.messageId)).length, 1, 'Delayed duplicate Sent copy');
  }, 'send_email');
  await step('Reply once to the original test email, to self only', async () => {
    await assertTarget();
    const responder = guardedService(policy);
    const result = await responder.replyEmail({ mailbox: report.target.mailbox, uid: report.target.uid, replyAll: false, text: 'Self-addressed test reply for Yahoo MCP verification.' });
    assert(result.ok && result.code === 'SENT'); assert.equal(result.data.rejected?.length ?? 0, 0);
    replyTest = result.data; report.replyTest = { messageId: replyTest.messageId, smtpAccepted: true }; save();
    const inbox = await visible(roles.inbox, replyTest.messageId);
    assert.equal(inbox.length, 1); assert.equal((await visible(roles.sent, replyTest.messageId)).length, 1);
    const reply = (await responder.getEmail(roles.inbox, inbox[0])).data;
    assert.equal(reply.inReplyTo, original.messageId); assert(reply.references.includes(original.messageId));
    assert(reply.to.length === 1 && reply.cc.length === 0 && reply.bcc.length === 0);
    ownSummary(reply, replyTest.messageId);
  }, 'reply_email');
  await step('Reconstruct only the test thread across folders', async () => {
    await assertTarget();
    const result = await service.getThread(report.target.mailbox, report.target.uid);
    assert(result.ok && result.data.length <= 100);
    const ids = result.data.map(message => message.messageId);
    assert(ids.includes(original.messageId) && ids.includes(replyTest.messageId));
    assert.equal(new Set(ids).size, ids.length);
    assert(ids.every(id => id === original.messageId || id === replyTest.messageId));
    assert.equal(bodyGuardFailures, 0); assert.equal(threadSearchFailures, 0);
    report.threadMessageCount = ids.length;
    assert.equal((await assertTarget()).read, false);
  }, 'get_thread');
  await step('Final test-message state and delayed Sent-copy check', async () => {
    const final = await assertTarget(); assert.equal(final.mailbox, original.mailbox);
    assert.equal(final.read, initial.read); assert.equal(final.flagged, initial.flagged);
    assert.equal((await service.imap.findByMessageId(roles.sent, sentTest.messageId)).length, 1);
    assert.equal((await service.imap.findByMessageId(roles.sent, replyTest.messageId)).length, 1);
    assert.equal(report.smtpAttempts.length, 2);
    report.originalStateRestored = true; report.uniqueSentCopies = true;
  });
  assert.equal(report.passedTools.length, 16);
  report.passed = true; report.phase = 'complete';
  console.log('PASS: all 16 tool operations verified across saved and current checks. Original test email restored.');
} catch (error) {
  report.phaseAtFailure = report.phase; report.phase = 'stopped';
  report.assertion = error instanceof assert.AssertionError ? error.message.split('\n')[0].slice(0, 180) : undefined;
  report.failureCode = error?.code === 'SEND_STATUS_UNKNOWN' ? 'SEND_STATUS_UNKNOWN' : 'REVIEW_REQUIRED';
  report.failure = 'Sequence stopped. Inspect the current test-item state before any repeat; raw errors and message bodies are omitted.';
  console.error(report.failure); process.exitCode = 1;
} finally {
  clearTimeout(deadline); clearInterval(heartbeat); rawById.clear();
  report.finishedAt = new Date().toISOString(); save();
  console.log(`Results: ${reportPath}`);
}
