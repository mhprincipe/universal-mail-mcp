import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { MailError } from './errors.js';
import type { ParsedMessage } from './parseCore.js';

export type { ParsedMessage } from './parseCore.js';
export type SafeParser = { parse(raw: Buffer): Promise<ParsedMessage>; close(): Promise<void> };
export type SafeParserOptions = { timeoutMs?: number; startupTimeoutMs?: number; memoryMb?: number; workerFile?: URL };

// Under tests Node runs the TypeScript source directly; built, it runs the .js.
const defaultWorkerFile = new URL(import.meta.url.endsWith('.ts') ? './parseWorker.ts' : './parseWorker.js', import.meta.url);

type Reply = { ready: true } | { id: number; ok: true; message: ParsedMessage } | { id: number; ok: false; reason: string };
type Job = { raw: Buffer; fingerprint: string; resolve(message: ParsedMessage): void; reject(error: MailError): void };
type Running = { id: number; job: Job; worker: Worker; timer?: NodeJS.Timeout };
type Outcome = { message: ParsedMessage } | { reason: string } | { unavailable: string };

// The reason goes to the diagnostics log only; the person sees one plain sentence.
const unsafe = (reason: string) =>
  new MailError('MAIL-PARSE-UNSAFE', "This email couldn't be opened safely.", 'FAILED', false, { reason });
const unavailable = (reason: string) =>
  new MailError('MAIL-PARSER-UNAVAILABLE', "Emails can't be opened right now. Try again in a minute.", 'FAILED', true, { reason });

// The worker takes one email at a time; the rest wait in a queue. So when a
// worker is killed or crashes, the email it held is the culprit, and the
// queued ones go to a fresh worker untouched.
//
// A worker says when it has loaded. An email's time limit starts only then, and
// anything that goes wrong before it is the worker's fault, never the email's.
export function createSafeParser(options: SafeParserOptions = {}): SafeParser {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const memoryMb = options.memoryMb ?? 256;
  const workerFile = options.workerFile ?? defaultWorkerFile;
  const queue: Job[] = [];
  // Fingerprints of emails that failed, so they are refused at once next time.
  // Not Message-IDs: any sender can copy one, and so block a genuine email.
  const failed = new Set<string>();
  const ready = new WeakSet<Worker>();
  let worker: Worker | undefined;
  let running: Running | undefined;
  let nextId = 0;

  const finish = (outcome: Outcome) => {
    const done = running!;
    running = undefined;
    clearTimeout(done.timer);
    if ('message' in outcome) {
      done.job.resolve(outcome.message);
    } else if ('unavailable' in outcome) {
      done.job.reject(unavailable(outcome.unavailable));
    } else {
      failed.add(done.job.fingerprint);
      done.job.reject(unsafe(outcome.reason));
    }
    pump();
  };

  // Stop sending work to this worker at once. Its email, if any, fails: as
  // unsafe if the worker had started, as "unavailable" if it never did.
  const retire = (retired: Worker, reason: string) => {
    if (worker === retired) worker = undefined;
    if (running?.worker !== retired) return;
    finish(ready.has(retired) ? { reason } : { unavailable: reason });
  };

  const startClock = (run: Running) => {
    run.timer = setTimeout(() => {
      retire(run.worker, 'time limit');
      void run.worker.terminate();
    }, timeoutMs);
  };

  const start = () => {
    const created = new Worker(workerFile, { resourceLimits: { maxOldGenerationSizeMb: memoryMb } });
    const startup = setTimeout(() => {
      retire(created, 'worker did not start');
      void created.terminate();
    }, startupTimeoutMs);
    created.on('message', (reply: Reply) => {
      if ('ready' in reply) {
        clearTimeout(startup);
        ready.add(created);
        if (running?.worker === created) startClock(running);
        return;
      }
      if (running?.id !== reply.id) return;
      finish(reply.ok ? { message: reply.message } : { reason: reply.reason });
    });
    created.on('error', (error: Error & { code?: string }) =>
      retire(created, error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory limit' : `worker error: ${error.message}`));
    created.on('exit', () => {
      clearTimeout(startup);
      retire(created, 'worker stopped');
    });
    return created;
  };

  // The worker keeps the process alive only while it has work, so a script
  // awaiting a parse doesn't exit early and a finished one doesn't hang.
  function pump() {
    if (running) return;
    const job = queue.shift();
    if (!job) { worker?.unref(); return; }
    const current = worker ??= start();
    current.ref();
    running = { id: nextId++, job, worker: current };
    if (ready.has(current)) startClock(running);
    current.postMessage({ id: running.id, raw: job.raw });
  }

  return {
    parse(raw) {
      const fingerprint = createHash('sha256').update(raw).digest('hex');
      if (failed.has(fingerprint)) return Promise.reject(unsafe('failed before'));
      return new Promise<ParsedMessage>((resolve, reject) => {
        queue.push({ raw, fingerprint, resolve, reject });
        pump();
      });
    },
    async close() {
      await worker?.terminate();
      worker = undefined;
    }
  };
}

let shared: SafeParser | undefined;
// One parser for the whole server; every account's mail service uses it.
export function sharedParser(): SafeParser {
  return shared ??= createSafeParser();
}
