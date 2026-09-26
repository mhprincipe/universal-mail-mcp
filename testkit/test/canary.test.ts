import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanary, scanForCanaries } from '../src/canary.js';

// TK-12: secrets are tested by planting a known string and proving it never
// comes out anywhere — logs, reports, pages or disk.
describe('TK-12 canary scanner', () => {
  it('finds a planted canary in logs, reports, HTML and files, and nothing in clean sources', () => {
    const password = createCanary('app-password');
    const token = createCanary('token');
    // Escaping for URLs or HTML cannot disguise a canary.
    for (const canary of [password, token]) expect(encodeURIComponent(canary)).toBe(canary);

    const dirty = mkdtempSync(join(tmpdir(), 'canary-dirty-'));
    const clean = mkdtempSync(join(tmpdir(), 'canary-clean-'));
    try {
      mkdirSync(join(dirty, 'nested'));
      writeFileSync(join(dirty, 'nested', 'progress.json'), JSON.stringify({ step: 6, password }));
      writeFileSync(join(clean, 'progress.json'), JSON.stringify({ step: 6 }));

      expect(scanForCanaries([password, token], {
        logs: ['{"event":"server_started"}', `{"event":"token_rejected","token":"${token}"}`],
        reports: [{ stages: [] }, { stages: [{ fix: `paste ${password}` }] }],
        html: [`<input value="${password}">`],
        dirs: [dirty]
      })).toEqual([
        { canary: token, where: 'log[1]' },
        { canary: password, where: 'report[1]' },
        { canary: password, where: 'html[0]' },
        { canary: password, where: join('nested', 'progress.json') }
      ]);

      expect(scanForCanaries([password, token], {
        logs: ['{"event":"server_started"}'], reports: [{ ok: true }], html: ['<p>All done.</p>'], dirs: [clean]
      })).toEqual([]);
    } finally {
      rmSync(dirty, { recursive: true, force: true });
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
