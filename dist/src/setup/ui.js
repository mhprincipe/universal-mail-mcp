import { render } from './messages.js';
export const terminal = { write: text => process.stdout.write(text) };
export function createUi(out = terminal, indent = '  ') {
    return {
        say(code, values = {}, options = {}) {
            out.write(`${render(code, values, options).split('\n').map(l => (l ? `${indent}${l}` : l)).join('\n')}\n`);
        },
        blank() { out.write('\n'); }
    };
}
//# sourceMappingURL=ui.js.map