import { parentPort } from 'node:worker_threads';
import { parseMessage } from './parseCore.ts';

// One job at a time: { id, raw } in, { id, ok, message | reason } out.
parentPort!.on('message', async ({ id, raw }: { id: number; raw: Uint8Array }) => {
  try {
    parentPort!.postMessage({ id, ok: true, message: await parseMessage(Buffer.from(raw)) });
  } catch (error) {
    parentPort!.postMessage({ id, ok: false, reason: error instanceof Error ? error.message : String(error) });
  }
});

// Loaded: from here on, the time taken is the email's.
parentPort!.postMessage({ ready: true });
