import { homedir } from 'node:os';
import { VERSION } from '../version.js';
import { runSetup, type SetupDeps } from './flow.js';
import { createGcloudRunner, createGoogleCloud } from './gcloud.js';
import { buildReport, createSetupLog, type SetupLog } from './log.js';
import { render } from './messages.js';
import { createProgressStore } from './progress.js';
import { createPrompt } from './prompt.js';
import { createMailCheck } from './realMail.js';
import { createSelfTest } from './selfTest.js';
import { serverLog } from './serverLog.js';
import { createUi } from './ui.js';

// `node setup.js` (design §3): the real parts, wired to the flow. The launcher
// (setup.js) passes the process's streams, the home folder and the release's
// pinned image. Exit codes: 0 done, 1 stopped with a message, 2 not understood.

export type MainIo = {
  env: NodeJS.ProcessEnv; stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; home?: string; image: string;
  // For tests: how to run gcloud, the new project's ID, time, and parts stood in.
  gcloud?: string[]; projectId?: () => string; clock?: SetupDeps['clock']; overrides?: Partial<SetupDeps>;
};

const INDENT = '  ';
const indented = (text: string) => text.split('\n').map(l => (l ? `${INDENT}${l}` : l)).join('\n');

export async function main(argv: string[], io: MainIo): Promise<number> {
  const home = io.home ?? homedir();
  const ui = createUi({ write: text => io.stdout.write(text) }, INDENT);
  if (argv[0] === 'report') {
    io.stdout.write(`${buildReport(home, { version: VERSION })}\n`);
    // Once there's a project, the server's own log too (DIA-11). Reading it
    // isn't a setup run, so it adds nothing to setup's log.
    const project = createProgressStore(home).load()?.project;
    if (project) {
      const quiet: SetupLog = { secret: () => undefined, event: () => undefined };
      io.stdout.write(`\n${await serverLog(createGcloudRunner({ command: io.gcloud, env: io.env, log: quiet }), project)}\n`);
    }
    return 0;
  }
  if (argv.length) { ui.say('USAGE'); return 2; }

  const clock = io.clock ?? { now: Date.now, sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) };
  const log = createSetupLog(home, clock);
  const google = createGoogleCloud({ run: createGcloudRunner({ command: io.gcloud, env: io.env, log }), newProjectId: io.projectId });
  const prompt = createPrompt(io.stdin, io.stdout, reason => log.event({ type: 'input-closed', reason }));
  try {
    const outcome = await runSetup({
      google, ui, log, clock, version: VERSION, image: io.image,
      // Cloud Shell sets CLOUD_SHELL=true in every session.
      isCloudShell: io.env.CLOUD_SHELL === 'true',
      progress: createProgressStore(home),
      mail: createMailCheck({ log }),
      selfTest: createSelfTest({ google, log, version: VERSION, clock }),
      // A question shows its message, then waits on the same line.
      ask: (code, values, options) => prompt.question(indented(render(code, values)), { hidden: Boolean(options?.hidden) }),
      ...io.overrides
    });
    return outcome.outcome === 'done' ? 0 : 1;
  } finally { prompt.close(); }
}
