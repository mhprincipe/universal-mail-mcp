// The fake `gcloud` executable. Answers from script.json, logs every call to
// calls.jsonl, and refuses anything unscripted with exit code 97.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_GCLOUD_DIR;
const args = process.argv.slice(2);
const steps = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'));
const usedPath = join(dir, 'used.json');
const used = existsSync(usedPath) ? JSON.parse(readFileSync(usedPath, 'utf8')) : [];

// Each step answers once unless marked repeat, so a second, unplanned call to
// the same command is caught rather than silently answered again.
const key = JSON.stringify(args);
const index = steps.findIndex((step, i) => JSON.stringify(step.args) === key && (step.repeat || !used.includes(i)));
// What arrived on standard input (how secrets must travel), if anything.
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch { /* no input */ }
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ args, scripted: index >= 0, ...(stdin ? { stdin } : {}) }) + '\n');

if (index < 0) {
  process.stderr.write(`FAKE-GCLOUD: unscripted call: gcloud ${args.join(' ')}\n`);
  process.exitCode = 97;
} else {
  const step = steps[index];
  if (!step.repeat) writeFileSync(usedPath, JSON.stringify([...used, index]));
  if (step.stdout) process.stdout.write(step.stdout);
  if (step.stderr) process.stderr.write(step.stderr);
  process.exitCode = step.exitCode ?? 0;
}
