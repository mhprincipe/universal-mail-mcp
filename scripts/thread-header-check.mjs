import { readFileSync } from 'node:fs';
import { loadConfig } from '../dist/src/config.js';
import { MailService } from '../dist/src/yahoo/mailService.js';
process.loadEnvFile(new URL('../.env', import.meta.url));
const config = loadConfig();
const run = JSON.parse(readFileSync(new URL('../../main-integration-check.json', import.meta.url), 'utf8'));
const service = new MailService(config);
const summary = await service.imap.fetchSummary('INBOX', run.target.uid);
if (summary.messageId !== run.target.messageId) throw new Error('Identity mismatch');
const original = (await service.getEmail('INBOX', run.target.uid)).data;
const root = original.references[0];
await service.imap.read(async client => {
 const lock = await client.getMailboxLock('INBOX', {readOnly:true});
 try {
  for (const [label, header] of [
   ['message-id', {'Message-ID':run.target.messageId}],
   ['reply-in-reply-to', {'In-Reply-To':run.target.messageId}],
   ['reply-references', {'References':run.target.messageId}],
   ['root-references', {'References':root}],
   ['root-references-unbracketed', {'References':root.replace(/^<|>$/g,'')}]
  ]) {
   const hits = await client.search({ header }, {uid:true});
   console.log(JSON.stringify({ label, count: Array.isArray(hits) ? hits.length : 0, containsOriginal: Array.isArray(hits) && hits.includes(run.target.uid) }));
  }
 } finally { lock.release(); }
});
