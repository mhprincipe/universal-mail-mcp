// The real parse worker, slow to answer but light: every email takes 800 ms,
// using almost no memory, so a test can do something else while it waits.
import { parentPort } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseMessage } from '../../src/parseCore.ts';

parentPort.on('message', async ({ id, raw }) => {
  await sleep(800);
  parentPort.postMessage({ id, ok: true, message: await parseMessage(Buffer.from(raw)) });
});
parentPort.postMessage({ ready: true });
