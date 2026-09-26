import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// REL-04 (added): what "Open in Cloud Shell" clones is the release branch,
// assembled by scripts/publish-setup.mjs. Assembled here the same way, from
// a fresh build, then run as a person would: in a folder of its own.
const root = fileURLToPath(new URL('..', import.meta.url));
const digest = `sha256:${'d1'.repeat(32)}`;
let out: string;
let home: string;

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'pipe' });
  out = mkdtempSync(join(tmpdir(), 'publish-'));
  home = mkdtempSync(join(tmpdir(), 'publish-home-'));
  execFileSync(process.execPath, [join(root, 'scripts', 'publish-setup.mjs'), out, '2.0.0-dev', digest, 'false', 'https://example.invalid/latest.json'], { cwd: root, stdio: 'pipe' });
}, 180_000);
afterAll(() => { rmSync(out, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const run = (args: string[]) => spawnSync(process.execPath, [join(out, 'setup.js'), ...args], {
  cwd: out, encoding: 'utf8', input: '', timeout: 60_000,
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home }
});

describe('the published setup', () => {
  it('REL-04 runs on its own, from the release folder alone: no install, no build (added)', () => {
    const r = run(['report']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Universal Mail setup report');
    // Nothing from the project's own folder was needed: no node_modules there.
    expect(existsSync(join(out, 'node_modules'))).toBe(false);
  });

  it('REL-04 it installs the image this release pinned, and carries the update feed', () => {
    expect(run(['--which-image']).stdout.trim()).toMatch(new RegExp(`@${digest}$`));
    expect(JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8'))).toEqual({ version: '2.0.0-dev', security: false });
  });

  it('REL-04 the published folder says its files are ES modules (Node before 22.7 would read setup.js as CommonJS and fail)', () => {
    // Node 22.7+ (this machine) detects module syntax by itself, so leaving the
    // file out can't be shown failing here; Cloud Shell's Node may be older.
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))).toMatchObject({ type: 'module', private: true });
  });
});
