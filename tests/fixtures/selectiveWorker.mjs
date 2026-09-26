// The real parse worker, except that a message containing HANG never answers,
// BUSY freezes the worker's thread, and CRASH kills the worker, so tests can
// hurt a worker on cue.
import { parentPort } from 'node:worker_threads';
import { parseMessage } from '../../src/parseCore.ts';

parentPort.on('message', async ({ id, raw }) => {
  const text = Buffer.from(raw).toString('latin1');
  if (text.includes('HANG')) return;
  if (text.includes('BUSY')) for (;;);
  if (text.includes('CRASH')) process.exit(1);
  parentPort.postMessage({ id, ok: true, message: await parseMessage(Buffer.from(raw)) });
});
parentPort.postMessage({ ready: true });
