import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createFakeGcloud, type FakeGcloud } from '../src/fakeGcloud.js';

// Invoked by name from PATH, exactly as the setup program will invoke it.
// Windows finds gcloud.cmd only through its shell, which takes one command
// line (Node deprecates a shell with separate arguments: DEP0190); these
// arguments have no spaces or quotes to escape.
const run = (fake: FakeGcloud, args: string[]) => {
  const result = process.platform === 'win32'
    ? spawnSync(['gcloud', ...args].join(' '), { env: fake.env, encoding: 'utf8', shell: true })
    : spawnSync('gcloud', args, { env: fake.env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('TK-09 fake gcloud', () => {
  // Starts several real processes through the Windows shell, which can take
  // longer than Vitest's default 5 s when the whole suite runs at once.
  it('replays its script, records every call, and fails loudly on an unscripted call', { timeout: 30_000 }, () => {
    const fake = createFakeGcloud([
      { args: ['config', 'get-value', 'account'], stdout: 'you@gmail.com\n' },
      { args: ['projects', 'list', '--format=json'], stdout: '[]\n' },
      { args: ['services', 'enable', 'run.googleapis.com'], stderr: 'not ready yet\n', exitCode: 1 }
    ]);
    try {
      expect(run(fake, ['projects', 'list', '--format=json'])).toMatchObject({ status: 0, stdout: '[]\n' });
      expect(run(fake, ['config', 'get-value', 'account'])).toMatchObject({ status: 0, stdout: 'you@gmail.com\n' });
      expect(run(fake, ['services', 'enable', 'run.googleapis.com'])).toMatchObject({ status: 1, stderr: 'not ready yet\n' });

      const unplanned = run(fake, ['run', 'deploy', 'mail']);
      expect(unplanned.status).toBe(97);
      expect(unplanned.stderr).toContain('unscripted call: gcloud run deploy mail');

      // Each step answers once; asking again is a call nobody planned for.
      expect(run(fake, ['projects', 'list', '--format=json']).status).toBe(97);

      expect(fake.calls()).toEqual([
        ['projects', 'list', '--format=json'],
        ['config', 'get-value', 'account'],
        ['services', 'enable', 'run.googleapis.com'],
        ['run', 'deploy', 'mail'],
        ['projects', 'list', '--format=json']
      ]);
      expect(fake.unscripted()).toEqual([['run', 'deploy', 'mail'], ['projects', 'list', '--format=json']]);
    } finally {
      fake.cleanup();
    }
  });
});
