// The real parse worker, except that a message containing HANG never answers,
// BUSY freezes the worker's thread, and CRASH kills the worker, so tests can
// hurt a worker on cue. STUCKATTACHMENT hangs only when one of the message's
// attachments is read, never when the message itself is.
import { parentPort } from 'node:worker_threads';
import { readAttachment } from '../../src/attachmentCore.ts';
import { parseMessage } from '../../src/parseCore.ts';

parentPort.on('message', async ({ id, raw, attachment }) => {
  const text = Buffer.from(raw).toString('latin1');
  if (attachment !== undefined) {
    if (text.includes('STUCKATTACHMENT')) return;
    parentPort.postMessage({ id, ok: true, attachment: (await readAttachment(Buffer.from(raw), attachment)) ?? null });
    return;
  }
  if (text.includes('HANG')) return;
  if (text.includes('BUSY')) for (;;);
  if (text.includes('CRASH')) process.exit(1);
  parentPort.postMessage({ id, ok: true, message: await parseMessage(Buffer.from(raw)) });
});
parentPort.postMessage({ ready: true });
