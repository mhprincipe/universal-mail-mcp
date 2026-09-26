import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type GcloudStep = { args: string[]; stdout?: string; stderr?: string; exitCode?: number; repeat?: boolean };
export type FakeGcloud = {
  env: NodeJS.ProcessEnv;
  // How to run it directly, without a shell: [node, the fake's script].
  command: string[];
  calls(): string[][];
  // Every call with what it received on standard input.
  inputs(): Array<{ args: string[]; stdin?: string }>;
  unscripted(): string[][];
  cleanup(): void;
};

const cli = fileURLToPath(new URL('./fakeGcloudCli.mjs', import.meta.url));

// Puts a `gcloud` (and `gcloud.cmd` for Windows) first on PATH, backed by a
// script of expected calls.
export function createFakeGcloud(steps: GcloudStep[]): FakeGcloud {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gcloud-'));
  writeFileSync(join(dir, 'script.json'), JSON.stringify(steps));
  writeFileSync(join(dir, 'gcloud'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  chmodSync(join(dir, 'gcloud'), 0o755);
  writeFileSync(join(dir, 'gcloud.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, [pathKey]: `${dir}${delimiter}${process.env[pathKey] ?? ''}`, FAKE_GCLOUD_DIR: dir };
  const log = (): Array<{ args: string[]; scripted: boolean; stdin?: string }> => {
    const file = join(dir, 'calls.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  return {
    env,
    command: [process.execPath, cli],
    calls: () => log().map(entry => entry.args),
    inputs: () => log().map(({ args, stdin }) => ({ args, ...(stdin ? { stdin } : {}) })),
    unscripted: () => log().filter(entry => !entry.scripted).map(entry => entry.args),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}
