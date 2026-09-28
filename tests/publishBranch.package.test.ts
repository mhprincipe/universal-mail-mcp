import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// REL-07 (added: found on the first live install, 2026-09-27). Each release
// was published as a fresh, force-pushed release branch, so the owner's copy
// (made with git clone) refused `git pull` ("divergent branches") and kept
// running the old setup. scripts/publish-branch.sh adds each release on top of
// the last; here with real git, a local "GitHub", and a person's clone.
const root = fileURLToPath(new URL('..', import.meta.url));
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function release(folder: string, files: Record<string, string>) {
  rmSync(folder, { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(folder, path, '..'), { recursive: true }); writeFileSync(join(folder, path), text); }
}
const publish = (folder: string, remote: string, version: string) => spawnSync(bash, [join(root, 'scripts', 'publish-branch.sh'), folder, remote, version], {
  encoding: 'utf8', env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }
});

describe('publishing the release branch', () => {
  it.skipIf(!existsSync(bash) && process.platform === 'win32')('REL-07 each release goes on top of the last, so a person\'s copy takes it with a plain git pull (added: found live)', () => {
    dir = mkdtempSync(join(tmpdir(), 'publish-'));
    const remote = join(dir, 'github.git');
    git(dir, 'init', '-q', '--bare', remote);
    const folder = join(dir, 'publish');

    release(folder, { 'setup.js': 'v1\n', 'release.json': '{"version":"2.0.1"}\n', 'dist/old.js': 'gone next time\n' });
    const first = publish(folder, remote, '2.0.1');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);

    // The person: "Open in Cloud Shell" clones the release branch.
    const mine = join(dir, 'mine');
    // As in Cloud Shell: files as published, whatever this machine converts.
    git(dir, 'clone', '-q', '--config', 'core.autocrlf=false', '--branch', 'release', remote, mine);
    expect(readFileSync(join(mine, 'setup.js'), 'utf8')).toBe('v1\n');

    release(folder, { 'setup.js': 'v2\n', 'release.json': '{"version":"2.0.2"}\n' });
    expect(publish(folder, remote, '2.0.2').status).toBe(0);

    // What the owner typed, with no pull settings of their own.
    const pulled = spawnSync('git', ['-c', 'safe.directory=*', 'pull'], { cwd: mine, encoding: 'utf8' });
    expect(pulled.stderr).not.toMatch(/divergent|fatal/);
    expect(pulled.status).toBe(0);
    expect(readFileSync(join(mine, 'setup.js'), 'utf8')).toBe('v2\n');
    expect(readFileSync(join(mine, 'release.json'), 'utf8')).toContain('2.0.2');
    // Exactly the new release: what it no longer has is gone from the copy too.
    expect(existsSync(join(mine, 'dist', 'old.js'))).toBe(false);
    expect(git(mine, 'log', '--format=%s')).toBe('Release 2.0.2\nRelease 2.0.1');
  }, 60_000);

  it('REL-07 the release workflow publishes through publish-branch.sh and never force-pushes', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(workflow).toContain('bash scripts/publish-branch.sh publish ');
    expect(workflow).not.toMatch(/push\s+(-f|--force)/);
  });
});
