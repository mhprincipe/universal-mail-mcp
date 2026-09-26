import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

export const EXTERNAL_IO_FORBIDDEN = 'EXTERNAL_IO_FORBIDDEN';

const loopback = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

function forbidden(target: string): Error {
  return Object.assign(new Error(`${EXTERNAL_IO_FORBIDDEN}: tests may not reach ${target}`), { code: EXTERNAL_IO_FORBIDDEN });
}

// Socket.prototype.connect receives (options), (path), (port, host), or the
// pre-normalized array that net.connect passes. A path is a local pipe.
function hostOf(args: unknown[]): string | undefined {
  const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const first = list[0] as { host?: string; path?: string } | string | number | undefined;
  if (first && typeof first === 'object') return first.path ? undefined : (first.host ?? 'localhost');
  if (typeof first === 'string' && Number.isNaN(Number(first))) return undefined;
  return typeof list[1] === 'string' ? list[1] : 'localhost';
}

let installed = false;

// Every TCP path — net, tls, http, and fetch's own client — ends in
// Socket.prototype.connect, so guarding that one method covers all of them.
export function installNetworkGuard(): void {
  if (installed) return;
  installed = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const host = hostOf(args);
    if (host !== undefined && !loopback.has(host.toLowerCase())) throw forbidden(host);
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;

  // fetch wraps socket errors as a generic "fetch failed"; refuse up front so
  // the test sees the real reason.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const host = new URL(href).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!loopback.has(host)) throw forbidden(host);
    return originalFetch(input, init);
  }) as typeof fetch;

  syncBuiltinESMExports();
}
