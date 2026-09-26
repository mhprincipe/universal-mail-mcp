import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Everything a live install does, for diagnosing it afterwards (SET-60): steps,
// every Google call with its outcome, time and Google's own words, every
// password check's outcome, and anything unexpected with its full trace.
// Secrets are removed before anything is written (SET-61).

export type SetupLog = {
  // A value that must never be written: a password, a key.
  secret(value: string): void;
  event(event: Record<string, unknown>): void;
};

const logFile = (home: string) => join(home, '.universal-mail', 'setup-log.jsonl');

export function createSetupLog(home: string, clock: { now(): number }): SetupLog {
  const secrets = new Set<string>();
  const run = randomBytes(4).toString('hex');
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of secrets) text = text.split(secret).join('[removed]');
      return text;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    return value;
  };
  return {
    secret(value) { if (value && value.length >= 6) secrets.add(value); },
    event(event) {
      mkdirSync(join(home, '.universal-mail'), { recursive: true });
      appendFileSync(logFile(home), `${JSON.stringify(scrub({ at: new Date(clock.now()).toISOString(), run, ...event }))}\n`);
    }
  };
}

// node setup.js report (SET-62): one block, safe to paste into a chat.
export function buildReport(home: string, info: { version: string }, recent = 80): string {
  const lines = ['Universal Mail setup report', 'Safe to paste: contains no passwords or keys.', `Setup version: ${info.version}`];
  if (!existsSync(logFile(home))) return [...lines, 'No setup has been run on this machine yet.'].join('\n');
  const events = readFileSync(logFile(home), 'utf8').trim().split('\n').filter(Boolean);
  const parsed = events.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } });
  const start = [...parsed].reverse().find(e => e.type === 'run-start');
  const end = [...parsed].reverse().find(e => e.type === 'run-end');
  let progress: Record<string, unknown> = {};
  try { progress = JSON.parse(readFileSync(join(home, '.universal-mail', 'progress.json'), 'utf8')); } catch { /* none yet */ }
  const accounts = (progress.accounts as Array<{ name: string; providerId: string }> | undefined) ?? [];
  lines.push(
    `Node: ${start?.node ?? 'unknown'}   Platform: ${start?.platform ?? 'unknown'}   Cloud Shell: ${start?.cloudShell ?? 'unknown'}`,
    `Last step completed: ${progress.step ?? 0} of 8`,
    `Result of the last run: ${end?.outcome ?? 'unfinished'}`,
    ...(end?.code ? [`Stopped with: ${end.code}`] : []),
    `Accounts: ${accounts.map(a => `${a.name} (${a.providerId})`).join(', ') || 'none yet'}`,
    `Project: ${progress.project ?? 'not created yet'}`,
    '',
    `Recent log (last ${recent} entries; repeats collapsed, ${events.length} events in all):`,
    ...collapse(parsed, events).slice(-recent)
  );
  return lines.join('\n');
}

// Waiting on Google polls every few seconds: a run of identical events (same
// type, operation and outcome) becomes one line and a count, so the report
// shows what happened rather than 120 identical checks.
function collapse(parsed: Array<Record<string, unknown>>, raw: string[]): string[] {
  const out: string[] = [];
  let previousKey = '';
  let count = 0;
  const flush = () => { if (count > 1) out[out.length - 1] += `   ×${count}`; };
  parsed.forEach((event, i) => {
    const { at: _at, ms: _ms, ...rest } = event;
    const key = JSON.stringify(rest);
    if (key === previousKey) { count++; return; }
    flush();
    out.push(raw[i]!);
    previousKey = key;
    count = 1;
  });
  flush();
  return out;
}
