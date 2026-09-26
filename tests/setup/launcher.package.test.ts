import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// SET-78 (added): the file a person actually runs. Built as the release
// builds it, then run as `node setup.js`, in a process of its own.
const root = fileURLToPath(new URL('../..', import.meta.url));
let home: string;
beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'pipe' });
  home = mkdtempSync(join(tmpdir(), 'launcher-'));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const setup = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(root, 'setup.js'), ...args], {
  cwd: root, encoding: 'utf8', input: '', timeout: 60_000,
  // A clean environment: only what Cloud Shell would give, plus a fresh home.
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, ...env }
});

describe('the setup.js launcher', () => {
  it('SET-78 `node setup.js report` runs as its own process and prints the report (added)', () => {
    const r = setup(['report']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Universal Mail setup report');
    expect(r.stdout).toContain('Setup version: 2.0.0');
  });

  it('SET-78 outside Cloud Shell it stops with the plain message and exit code 1', () => {
    const r = setup([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('This needs to run in Google Cloud Shell.');
    expect(r.stderr).toBe('');
  });

  it('SET-78 it installs the image this release names, pinned by digest', () => {
    const r = setup(['--which-image']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^us-docker\.pkg\.dev\/universal-mail-rel-zqrw\/release\/server@sha256:[0-9a-f]{64}$/);
  });
});
