import { profiles } from '../providers.js';
import { CHECK_CODES, type CheckCode } from './codes.js';

// Runs the check stages in order and builds the report (design §7). The report
// is built only from typed fields: a stage's error is never copied into it,
// only its code, so provider or Google text (which may quote mail) can't leak.

export type StageName = 'google' | 'server' | 'signin' | 'apps' | `${'account' | 'tools' | 'live' | 'sent'}:${string}`;
export type Stage = { name: StageName; after?: StageName[]; run(): Promise<void> };

export type StageResult =
  | { stage: StageName; status: 'PASS' }
  | { stage: StageName; status: 'FAIL'; code: CheckCode; cause: string; fix: string }
  | { stage: StageName; status: 'NOT_RUN'; after: StageName };

export type Facts = { accounts: number; providers: string[]; trial?: boolean };

export type Report = {
  report: 'universal-mail-check';
  schema: 1;
  readme: string;
  version: string;
  at: string;
  result: 'PASS' | 'FAIL';
  stages: StageResult[];
  facts: Facts;
};

export const README = 'Stages run in order; NOT_RUN means an earlier stage failed. Each failure has a code, cause and fix. Contains no mail content, passwords, tokens or claim values.';

// A known failure. values.provider is a provider id or name; anything else is
// shown as "your provider". detail goes to the server's log, never the report.
export class CheckFailure extends Error {
  constructor(readonly code: CheckCode, readonly values: { provider?: string } = {}, detail?: string) { super(detail ?? code); this.name = 'CheckFailure'; }
}

function providerName(value: string | undefined): string {
  const known = profiles.find(p => p.id === value || p.name === value);
  return known?.name ?? 'your provider';
}

// Fills {provider}; a sentence that starts with it starts with a capital.
const fill = (text: string, provider: string) => {
  const filled = text.replace('{provider}', provider);
  return filled.charAt(0).toUpperCase() + filled.slice(1);
};

function failed(stage: StageName, error: unknown): StageResult {
  const known = error instanceof CheckFailure && Object.hasOwn(CHECK_CODES, error.code);
  const code: CheckCode = known ? error.code : 'CHECK-UNEXPECTED';
  const entry = CHECK_CODES[code];
  const provider = providerName(known ? error.values.provider : undefined);
  return { stage, status: 'FAIL', code, cause: fill(entry.cause, provider), fix: fill(entry.fix, provider) };
}

// A plain label (an engine code, an error's name), or nothing: never free text.
const label = (value: unknown) => typeof value === 'string' && /^[\w .:-]{1,60}$/.test(value) ? value : undefined;

// The server's log line for a failed stage, to diagnose it: the code, the
// error's name and, for the unexpected, where it happened (stack frames only,
// which hold no message text). The error's own words are never written.
export type FailureEvent = { event: 'check_stage_failed'; stage: StageName; code: CheckCode; error: string; detail?: string; at?: string[] };
export function failureEvent(stage: StageName, error: unknown): FailureEvent {
  const known = error instanceof CheckFailure && Object.hasOwn(CHECK_CODES, error.code);
  const base = { event: 'check_stage_failed' as const, stage, code: known ? error.code : 'CHECK-UNEXPECTED' as CheckCode, error: (error instanceof Error && label(error.name)) || typeof error };
  if (known) return { ...base, ...(label(error.message) ? { detail: error.message } : {}) };
  const frames = error instanceof Error ? (error.stack ?? '').split('\n').map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 10) : [];
  return { ...base, at: frames };
}

export async function runChecks(stages: Stage[], options: { version: string; clock: { now(): number }; facts: Facts; onError?: (stage: StageName, error: unknown) => void }): Promise<Report> {
  const results: StageResult[] = [];
  // For each stage that didn't pass, the failed stage at its root.
  const blockedBy = new Map<StageName, StageName>();
  for (const stage of stages) {
    const blocker = (stage.after ?? []).map(name => blockedBy.get(name)).find(Boolean);
    if (blocker) {
      blockedBy.set(stage.name, blocker);
      results.push({ stage: stage.name, status: 'NOT_RUN', after: blocker });
      continue;
    }
    try {
      await stage.run();
      results.push({ stage: stage.name, status: 'PASS' });
    } catch (error) {
      options.onError?.(stage.name, error);
      blockedBy.set(stage.name, stage.name);
      results.push(failed(stage.name, error));
    }
  }
  const known = new Set(profiles.map(p => p.id));
  return {
    report: 'universal-mail-check',
    schema: 1,
    readme: README,
    version: options.version,
    at: new Date(options.clock.now()).toISOString(),
    result: results.some(r => r.status === 'FAIL') ? 'FAIL' : 'PASS',
    stages: results,
    facts: {
      accounts: options.facts.accounts,
      providers: options.facts.providers.map(p => known.has(p) ? p : 'other'),
      ...(options.facts.trial === undefined ? {} : { trial: options.facts.trial })
    }
  };
}
