import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// Questions at the Cloud Shell prompt. For a hidden one (an app password),
// what's typed or pasted isn't echoed; the question itself says so (SET-22).
export function createPrompt(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
  let muted = false;
  // Readline echoes typing through this; while muted, the echo goes nowhere.
  const echo = new Writable({
    write(chunk, encoding, done) { if (!muted) output.write(chunk, encoding); done(); }
  });
  const rl = createInterface({ input, output: echo, terminal: true });
  return {
    question(text: string, options: { hidden: boolean }): Promise<string> {
      output.write(`${text} `);
      muted = options.hidden;
      return new Promise(resolve => rl.question('', answer => {
        muted = false;
        if (options.hidden) output.write('\n');
        resolve(answer);
      }));
    },
    close: () => rl.close()
  };
}
