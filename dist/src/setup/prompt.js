import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { Stop } from './stop.js';
// Questions at the Cloud Shell prompt. For a hidden one (an app password),
// what's typed or pasted isn't echoed; the question itself says so (SET-22).
// If the input closes (Ctrl+C, Ctrl+D, the end of a pipe), a waiting question
// stops setup with SETUP-INTERRUPTED; onClosed says which, for the log.
export function createPrompt(input, output, onClosed) {
    let muted = false;
    let closed;
    let waiting;
    // Readline echoes typing through this; while muted, the echo goes nowhere.
    const echo = new Writable({
        write(chunk, encoding, done) { if (!muted)
            output.write(chunk, encoding); done(); }
    });
    const rl = createInterface({ input, output: echo, terminal: true });
    const shut = (reason) => {
        if (closed)
            return;
        closed = reason;
        muted = false;
        onClosed?.(reason);
        // The message starts on its own line, not after the question.
        if (waiting)
            output.write('\n');
        waiting?.(new Stop('SETUP-INTERRUPTED'));
        waiting = undefined;
    };
    // Found live: without a listener, Ctrl+C closed readline and left the
    // question waiting on nothing ("Detected unsettled top-level await").
    rl.on('SIGINT', () => { shut('ctrl-c'); rl.close(); });
    rl.on('close', () => shut('input-closed'));
    return {
        question(text, options) {
            if (closed)
                return Promise.reject(new Stop('SETUP-INTERRUPTED'));
            // In a terminal, readline redraws the line it waits on (to column 1,
            // erase), so the question's last line must be readline's own prompt:
            // written any other way, it's wiped (found live: "[Y/n] ›" never showed).
            const cut = text.lastIndexOf('\n') + 1;
            output.write(text.slice(0, cut));
            return new Promise((resolve, reject) => {
                waiting = reject;
                rl.question(`${text.slice(cut)} `, answer => {
                    waiting = undefined;
                    muted = false;
                    if (options.hidden)
                        output.write('\n');
                    resolve(answer);
                });
                // The prompt is on screen; from here, while hidden, typing isn't.
                muted = options.hidden;
            });
        },
        // Setup closing its own prompt isn't the person closing the input.
        close: () => { closed ??= 'input-closed'; rl.close(); }
    };
}
//# sourceMappingURL=prompt.js.map