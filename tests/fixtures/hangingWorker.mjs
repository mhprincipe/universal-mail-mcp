// Stands in for a parse that never finishes: starts, accepts jobs, never answers.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => {});
parentPort.postMessage({ ready: true });
