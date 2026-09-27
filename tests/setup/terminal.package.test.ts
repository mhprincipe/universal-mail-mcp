import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// SET-82 (added: found live, 2026-09-27). The unit tests feed setup a fake
// input stream; the owner's first live run used a real terminal, where two
// defects showed that no fake could: readline's redraw erased each question's
// last line, and Ctrl+C left a question waiting on nothing, so Node quit with
// "Detected unsettled top-level await". Here the built launcher runs in a real
// pseudo-terminal (script) on Linux and Node 24, as in Cloud Shell, with a
// stand-in gcloud giving the live run's answers.
const root = fileURLToPath(new URL('../..', import.meta.url));
const fixtures = join(root, 'tests', 'setup', 'fixtures');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'pipe' });
}, 120_000);

// keys: [seconds to wait, what to type]. Afterwards the setup report is printed.
function inTerminal(keys: Array<[number, string]>) {
  const typing = keys.map(([wait, text]) => `sleep ${wait}; printf '${text}'`).join('; ');
  const script = [
    "mkdir -p /b && tr -d '\\r' < /f/gcloud-stand-in.sh > /b/gcloud && chmod +x /b/gcloud",
    'export PATH=/b:$PATH HOME=/tmp/h && mkdir -p /tmp/h && cd /app',
    `(${typing}; sleep 3) | script -qfec 'node setup.js' /dev/null`,
    'echo; echo ===REPORT===; node setup.js report'
  ].join(' && ');
  const out = execFileSync('docker', ['run', '--rm', '-v', `${root}:/app:ro`, '-v', `${fixtures}:/f:ro`, '-e', 'CLOUD_SHELL=true', 'node:24-slim', 'bash', '-c', script],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const [screen, report] = out.split('===REPORT===');
  return { screen: screen!, report: report ?? '' };
}
// What a terminal shows on a line: whatever was written after its last erase.
const visible = (screen: string, containing: string) => {
  const line = screen.split('\n').find(l => l.includes(containing)) ?? '';
  return line.split('\x1b[0J').at(-1)!.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
};

describe('setup in a real terminal', () => {
  it('SET-82 each question\'s last line stays on screen (added: found live)', () => {
    const { screen } = inTerminal([[6, 'n\\r'], [8, 'you@yahoo.com\\r'], [2, '\\r']]);
    expect(visible(screen, '[Y/n]')).toContain('until you remove it. [Y/n] ›');
    expect(visible(screen, 'you@yahoo.com')).toContain('› you@yahoo.com');
    expect(visible(screen, 'App password')).toContain('App password (nothing shows while you paste. That\'s normal) ›');
    // The input then ends at the password question: a plain stop, not a hang.
    expect(screen).toContain('(SETUP-INTERRUPTED)');
    expect(screen).not.toContain('unsettled top-level await');
  }, 180_000);

  it('SET-82 Ctrl+C at a question: a plain stop with its code, logged, never "unsettled top-level await" (added: found live)', () => {
    const { screen, report } = inTerminal([[6, 'n\\r'], [8, '\\003']]);
    expect(screen).toContain('Setup stopped before it was finished.');
    expect(screen).toContain('(SETUP-INTERRUPTED)');
    expect(screen).not.toContain('unsettled top-level await');
    expect(report).toContain('SETUP-INTERRUPTED');
    expect(report).toContain('ctrl-c');
  }, 180_000);
});
