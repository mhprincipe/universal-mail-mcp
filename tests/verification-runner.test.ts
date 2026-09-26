import { afterEach, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(join(resolve(tmpdir()), 'yahoo-verify-'))) throw new Error('Unexpected cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});
function run(failStage = '') {
  const root = mkdtempSync(join(tmpdir(), 'yahoo-verify-')); dirs.push(root);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'dist/scripts'), { recursive: true });
  copyFileSync(new URL('../scripts/verify.mjs', import.meta.url), join(root, 'scripts/verify.mjs'));
  writeFileSync(join(root, 'fake-npm.mjs'), `
    import { appendFileSync } from 'node:fs';
    const stage = process.argv.slice(2).join(' ');
    appendFileSync('invocations.jsonl', JSON.stringify({stage, hasSecret: !!process.env.MCP_ACCESS_SECRET, hasYahoo: !!process.env.YAHOO_APP_PASSWORD, hasNodeOptions: !!process.env.NODE_OPTIONS})+'\\n');
    if (stage === process.env.TEST_FAIL_STAGE) process.exit(7);
  `);
  writeFileSync(join(root, 'dist/scripts/local-smoke.js'), '// Compiled smoke stand-in: orchestrator test only.\n');
  const child = spawnSync(process.execPath, [join(root, 'scripts/verify.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_execpath')), npm_execpath: join(root, 'fake-npm.mjs'), TEST_FAIL_STAGE: failStage, MCP_ACCESS_SECRET: 'must-not-reach-child', YAHOO_APP_PASSWORD: 'must-not-reach-child', NODE_OPTIONS: '' }
  });
  if (!child.stdout.includes('VERIFY:')) throw new Error(child.stderr);
  const report = JSON.parse(readFileSync(join(root, 'verification/local-latest.json'), 'utf8'));
  if (report.stages[0].exitCode === null) throw new Error(child.stderr);
  if (!existsSync(join(root, 'invocations.jsonl'))) throw new Error(JSON.stringify(report) + child.stdout + child.stderr);
  const invocations = readFileSync(join(root, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { child, report, invocations };
}
it('runner stops at the first failed stage, saves failure, and exits nonzero', () => {
  const { child, report, invocations } = run('run typecheck');
  expect(child.status).toBe(1);
  expect(report.passed).toBe(false);
  expect(report.stages).toHaveLength(1);
  expect(report.stages[0]).toMatchObject({ passed: false, exitCode: 7 });
  expect(invocations).toHaveLength(1);
});
it('runner cannot claim success after a failed test stage', () => {
  const { child, report, invocations } = run('test');
  expect(child.status).toBe(1);
  expect(report.passed).toBe(false);
  expect(report.stages).toHaveLength(2);
  expect(invocations.map(x => x.stage)).toEqual(['run typecheck', 'test']);
});
it('runner executes every stage and removes real mail credentials from children', () => {
  const { child, report, invocations } = run();
  expect(child.status).toBe(0);
  expect(report.passed).toBe(true);
  expect(report.stages).toHaveLength(4);
  expect(invocations.map(x => x.stage)).toEqual(['run typecheck', 'test', 'run build']);
  expect(invocations.every(x => !x.hasSecret && !x.hasYahoo && !x.hasNodeOptions)).toBe(true);
  expect(child.stdout + child.stderr).not.toContain('must-not-reach-child');
});
