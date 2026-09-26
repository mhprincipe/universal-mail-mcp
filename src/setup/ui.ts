import { render, type MessageCode, type Stand } from './messages.js';

// The only place setup writes to the screen, and it only shows registry
// messages (SET-01). Output goes through `out`, so tests can capture it.
export type Screen = { write(text: string): void };
export const terminal: Screen = { write: text => process.stdout.write(text) };

export function createUi(out: Screen = terminal, indent = '  ') {
  return {
    say(code: MessageCode, values: Record<string, string> = {}, options: { stand?: Stand } = {}) {
      out.write(`${render(code, values, options).split('\n').map(l => (l ? `${indent}${l}` : l)).join('\n')}\n`);
    },
    blank() { out.write('\n'); }
  };
}
export type Ui = ReturnType<typeof createUi>;
