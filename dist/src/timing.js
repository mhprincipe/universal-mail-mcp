import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
const current = new AsyncLocalStorage();
export function measuring(into, fn) {
    return current.run(into, fn);
}
export async function phase(name, fn) {
    const into = current.getStore();
    if (!into)
        return fn();
    const started = performance.now();
    try {
        return await fn();
    }
    finally {
        const step = into[name] ??= { ms: 0, n: 0 };
        step.ms += performance.now() - started;
        step.n++;
    }
}
export const rounded = (phases) => Object.fromEntries(Object.entries(phases).map(([name, { ms, n }]) => [name, { ms: Math.round(ms), n }]));
// The mail server's commands, each timed as `${prefix}.${command}`. Anything
// else on the connection (its state, its events) passes straight through.
const COMMANDS = new Set([
    'connect', 'noop', 'list', 'status', 'getMailboxLock', 'search', 'fetchAll', 'fetchOne', 'append',
    'messageMove', 'messageCopy', 'messageDelete', 'messageFlagsAdd', 'messageFlagsRemove', 'mailboxCreate', 'logout'
]);
export function timedClient(client, prefix) {
    return new Proxy(client, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== 'function')
                return value;
            if (typeof property !== 'string' || !COMMANDS.has(property))
                return value.bind(target);
            return (...args) => phase(`${prefix}.${property}`, () => value.apply(target, args));
        }
    });
}
//# sourceMappingURL=timing.js.map