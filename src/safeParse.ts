import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { MailError } from './errors.js';
import type { AttachmentFile, AttachmentRead } from './attachmentCore.js';
import type { ParsedMessage } from './parseCore.js';

export type { ParsedMessage } from './parseCore.js';
export type { AttachmentFile, AttachmentRead } from './attachmentCore.js';
// attachment: one attachment by its position (undefined: there's none there),
// read in the same sandbox as the email. files: every attachment as it is, to send on.
export type SafeParser = {
  parse(raw: Buffer): Promise<ParsedMessage>; attachment(raw: Buffer, index: number): Promise<AttachmentRead | undefined>;
  files(raw: Buffer): Promise<AttachmentFile[]>; close(): Promise<void>;
};
// maxExternalMb: how much the process's memory may grow during one job. The
// worker's heap limit doesn't cover the buffers a PDF inflates into (ATT-08,
// security review), and those belong to the worker's thread, so it's the
// process's resident memory that shows them.
export type SafeParserOptions = { timeoutMs?: number; startupTimeoutMs?: number; memoryMb?: number; maxExternalMb?: number; workerFile?: URL };

// Under tests Node runs the TypeScript source directly; built, it runs the .js.
const defaultWorkerFile = new URL(import.meta.url.endsWith('.ts') ? './parseWorker.ts' : './parseWorker.js', import.meta.url);

type Reply = { ready: true } | { id: number; ok: true; message?: ParsedMessage; attachment?: AttachmentRead | null; files?: AttachmentFile[] } | { id: number; ok: false; reason: string };
// attachment: one attachment by position, or 'files' for all of them as they are.
type Job = { raw: Buffer; attachment?: number | 'files'; fingerprint: string; resolve(result: unknown): void; reject(error: MailError): void };
type Running = { id: number; job: Job; worker: Worker; timer?: NodeJS.Timeout; watch?: NodeJS.Timeout };
type Outcome = { result: unknown } | { reason: string } | { unavailable: string };

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
  // The server has 512 MB in all (Cloud Run's default).
  const maxGrowthBytes = (options.maxExternalMb ?? 160) * 1024 * 1024;
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
    clearInterval(done.watch);
    if ('result' in outcome) {
      done.job.resolve(outcome.result);
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
    // Checked often while a job runs: growth since it started.
    const before = process.memoryUsage.rss();
    run.watch = setInterval(() => {
      if (process.memoryUsage.rss() - before <= maxGrowthBytes) return;
      retire(run.worker, 'memory limit');
      void run.worker.terminate();
    }, 25);
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
      finish(reply.ok ? { result: 'files' in reply ? reply.files : 'attachment' in reply ? reply.attachment ?? undefined : reply.message } : { reason: reply.reason });
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
    current.postMessage({ id: running.id, raw: job.raw, ...(job.attachment === 'files' ? { files: true } : job.attachment !== undefined ? { attachment: job.attachment } : {}) });
  }

  // An attachment that failed is remembered by the email and its position, so
  // it never stops the email itself from opening.
  const submit = <T>(raw: Buffer, attachment?: number | 'files') => {
    const fingerprint = createHash('sha256').update(raw).digest('hex') + (attachment === undefined ? '' : `#${attachment}`);
    if (failed.has(fingerprint)) return Promise.reject(unsafe('failed before'));
    return new Promise<T>((resolve, reject) => {
      queue.push({ raw, ...(attachment === undefined ? {} : { attachment }), fingerprint, resolve: resolve as (result: unknown) => void, reject });
      pump();
    });
  };

  return {
    parse: raw => submit<ParsedMessage>(raw),
    attachment: (raw, index) => submit<AttachmentRead | undefined>(raw, index),
    files: raw => submit<AttachmentFile[]>(raw, 'files'),
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
