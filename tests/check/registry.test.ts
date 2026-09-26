import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECK_CODES } from '../../src/check/codes.js';
import { MESSAGES } from '../../src/setup/messages.js';

// DIA-04: every code used in the source is in its registry, and every
// registry code is used (a static scan). Tool codes: POL-07.
const src = fileURLToPath(new URL('../../src', import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
const sources = files(src).map(file => ({ file, text: readFileSync(file, 'utf8') }));
const outside = (registry: string) => sources.filter(s => !s.file.endsWith(registry));

describe('the code registries', () => {
  it('DIA-04 setup: every message code the source uses is registered, and every registered one is used', () => {
    const registered = new Set(Object.keys(MESSAGES));
    const setupSources = outside(join('setup', 'messages.ts')).filter(s => s.file.includes(`${join('src', 'setup')}`));
    // Codes appear as quoted literals: ui.say('X'), d.ask('X'), new Stop('X'), code maps.
    const used = new Set(setupSources.flatMap(s => [...s.text.matchAll(/'((?:SETUP|GOOGLE|MAIL|SIGNIN|SENT|ASK|STEP|ACCOUNT|WELCOME|CHECKS|SENT|ALL|DONE|WAITING|SIGNED|PERSONAL|BILLING|ACCOUNTS|WHERE|PASSWORD|STUCK|USAGE|INSTALLED|MENU|CHECKING|FIX|FIXED|UP|UPDATING|UPDATED|ADDRESSES|REMOVED|KEPT|CONVERTED|REPAIRED)(?:-[A-Z0-9]+)*)'/g)].map(m => m[1]!)));
    // Setup also reads the server's check report, so check codes appear in it too.
    for (const code of used) expect([...registered, ...Object.keys(CHECK_CODES)], `used but not registered: ${code}`).toContain(code);
    const all = setupSources.map(s => s.text).join('\n');
    for (const code of registered) {
      // STEP-1 to STEP-8 are reached as `STEP-${n}`.
      const reached = all.includes(`'${code}'`) || (/^STEP-\d$/.test(code) && all.includes('`STEP-${'));
      expect(reached, `registered but never used: ${code}`).toBe(true);
    }
  });

  it('DIA-04 checks: every check code the source uses is registered, and every registered one is used', () => {
    const registered = new Set(Object.keys(CHECK_CODES));
    const checkSources = outside(join('check', 'codes.ts'));
    const used = new Set(checkSources.flatMap(s => [...s.text.matchAll(/new CheckFailure\(\s*'([A-Z0-9-]+)'/g)].map(m => m[1]!)));
    used.add('CHECK-UNEXPECTED');
    for (const code of used) expect(registered, `used but not registered: ${code}`).toContain(code);
    for (const code of registered) expect(used, `registered but never used: ${code}`).toContain(code);
  });
});
