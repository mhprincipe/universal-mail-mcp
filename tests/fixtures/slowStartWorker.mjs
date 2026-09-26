// The real parse worker, slow to start: stands in for loading the parser on a
// busy machine. It announces it is ready only after 1.5 seconds.
import { parentPort } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';

await sleep(1_500);
const { parseMessage } = await import('../../src/parseCore.ts');
parentPort.on('message', async ({ id, raw }) => {
  parentPort.postMessage({ id, ok: true, message: await parseMessage(Buffer.from(raw)) });
});
parentPort.postMessage({ ready: true });
