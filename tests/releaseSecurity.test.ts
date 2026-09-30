import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// REL-09 (added: found releasing 2.4.0): whether a release is a security
// release comes from the tag's own message, never the commit's. On GitHub's
// checkout an annotated tag arrived as a plain pointer to the commit, so the
// commit's subject ("…the security review…") marked 2.4.0 a security release.
const script = new URL('../scripts/release-security.mjs', import.meta.url);
let repo: string | undefined;
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); repo = undefined; });

function repoWith(commitSubject: string) {
  repo = mkdtempSync(join(tmpdir(), 'rel-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo });
  git('init', '-q');
  writeFileSync(join(repo, 'f'), 'x');
  git('add', 'f');
  git('commit', '-q', '-m', commitSubject);
  return git;
}
const decide = (tag: string) => spawnSync(process.execPath, [fileURLToPath(script), tag], { cwd: repo, encoding: 'utf8' });

describe('the security mark on a release', () => {
  it('REL-09 comes from the tag\'s own first line, not the commit\'s (added: found releasing 2.4.0)', () => {
    const git = repoWith('Docs: the security review');
    git('tag', '-a', 'v1.0.0', '-m', 'Features and docs');
    expect(decide('v1.0.0')).toMatchObject({ status: 0, stdout: 'security=false\n' });
    git('tag', '-a', 'v1.0.1', '-m', 'Security: a fix');
    expect(decide('v1.0.1')).toMatchObject({ status: 0, stdout: 'security=true\n' });
  });

  it('REL-09 a tag that is only a pointer to the commit stops the release rather than guessing', () => {
    const git = repoWith('Docs: the security review');
    git('tag', 'v1.0.0');
    const result = decide('v1.0.0');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not an annotated tag');
  });

  it('REL-09 the workflow fetches the real tag before deciding, and decides with the script', () => {
    const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
    const fetch = workflow.indexOf('git fetch --force origin "refs/tags/$GITHUB_REF_NAME:refs/tags/$GITHUB_REF_NAME"');
    const decideAt = workflow.indexOf('node scripts/release-security.mjs "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"');
    expect(fetch).toBeGreaterThan(-1);
    expect(decideAt).toBeGreaterThan(fetch);
    expect(workflow).not.toContain('%(contents:subject)');
  });
});
