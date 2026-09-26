// Stands in for a parse that eats memory until the worker's cap stops it.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => {
  const hoard = [];
  for (;;) hoard.push(new Array(1_000_000).fill(hoard.length));
});
parentPort.postMessage({ ready: true });
