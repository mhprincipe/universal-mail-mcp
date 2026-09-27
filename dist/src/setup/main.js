import { homedir } from 'node:os';
import { VERSION } from '../version.js';
import { runSetup } from './flow.js';
import { createGcloudRunner, createGoogleCloud } from './gcloud.js';
import { buildReport, createSetupLog } from './log.js';
import { render } from './messages.js';
import { createProgressStore } from './progress.js';
import { createPrompt } from './prompt.js';
import { createMailCheck } from './realMail.js';
import { createSelfTest } from './selfTest.js';
import { createUi } from './ui.js';
const INDENT = '  ';
const indented = (text) => text.split('\n').map(l => (l ? `${INDENT}${l}` : l)).join('\n');
export async function main(argv, io) {
    const home = io.home ?? homedir();
    const ui = createUi({ write: text => io.stdout.write(text) }, INDENT);
    if (argv[0] === 'report') {
        io.stdout.write(`${buildReport(home, { version: VERSION })}\n`);
        return 0;
    }
    if (argv.length) {
        ui.say('USAGE');
        return 2;
    }
    const clock = io.clock ?? { now: Date.now, sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)) };
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
    }
    finally {
        prompt.close();
    }
}
//# sourceMappingURL=main.js.map