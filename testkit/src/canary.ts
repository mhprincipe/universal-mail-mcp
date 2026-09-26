import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type Finding = { canary: string; where: string };
export type Sources = { logs?: string[]; reports?: unknown[]; html?: string[]; dirs?: string[] };

// Letters, digits and hyphens only: URL and HTML escaping leave it unchanged,
// so an escaped leak is still found. (A base64-encoded leak would not be.)
export function createCanary(label: string): string {
  return `CANARY-${label}-${randomBytes(6).toString('hex')}`;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

// Reports in order: logs, reports, HTML, then files; within each, by position.
export function scanForCanaries(canaries: string[], sources: Sources): Finding[] {
  const findings: Finding[] = [];
  const check = (text: string, where: string) => {
    for (const canary of canaries) if (text.includes(canary)) findings.push({ canary, where });
  };
  sources.logs?.forEach((line, i) => check(line, `log[${i}]`));
  sources.reports?.forEach((report, i) => check(JSON.stringify(report), `report[${i}]`));
  sources.html?.forEach((page, i) => check(page, `html[${i}]`));
  for (const dir of sources.dirs ?? []) {
    for (const file of filesUnder(dir)) check(readFileSync(file).toString('latin1'), relative(dir, file));
  }
  return findings;
}
