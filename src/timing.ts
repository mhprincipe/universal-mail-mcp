import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// Where a tool call's time goes (DIA-13): per named step, the total time and
// how many times. Only step names are kept, never what a step was asked or
// answered, so the breakdown can go in the log beside the tool's line.
export type Phases = Record<string, { ms: number; n: number }>;

const current = new AsyncLocalStorage<Phases>();

export function measuring<T>(into: Phases, fn: () => Promise<T>): Promise<T> {
  return current.run(into, fn);
}

export async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const into = current.getStore();
  if (!into) return fn();
  const started = performance.now();
  try { return await fn(); }
  finally {
    const step = into[name] ??= { ms: 0, n: 0 };
    step.ms += performance.now() - started;
    step.n++;
  }
}

export const rounded = (phases: Phases): Phases =>
  Object.fromEntries(Object.entries(phases).map(([name, { ms, n }]) => [name, { ms: Math.round(ms), n }]));

// The mail server's commands, each timed as `${prefix}.${command}`. Anything
// else on the connection (its state, its events) passes straight through.
const COMMANDS = new Set([
  'connect', 'noop', 'list', 'status', 'getMailboxLock', 'search', 'fetchAll', 'fetchOne', 'append',
  'messageMove', 'messageCopy', 'messageDelete', 'messageFlagsAdd', 'messageFlagsRemove', 'mailboxCreate', 'logout'
]);

export function timedClient<T extends object>(client: T, prefix: string): T {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property !== 'string' || !COMMANDS.has(property)) return value.bind(target);
      return (...args: unknown[]) => phase(`${prefix}.${property}`, () => value.apply(target, args));
    }
  });
}
