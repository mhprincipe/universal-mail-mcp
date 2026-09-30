// Send limits (LIM-01, principle 4): when each account sent, kept per sending
// address so rebuilding the mail access (a page change) doesn't reset the
// count. In memory: a server that has been idle long enough to be stopped has
// sent nothing in the meantime, so the hour's count starts again, and a burst
// keeps the server running, and counted.
export type SendLog = {
  record(address: string, at: number): void;
  since(address: string, from: number): number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
// The same as config.ts's defaults, for the page to show.
export const DEFAULT_SEND_LIMITS = { perHour: 30, perDay: 200 };

export function createSendLog(): SendLog {
  const sent = new Map<string, number[]>();
  return {
    record(address, at) {
      const key = address.toLowerCase();
      // Only the last day matters; older entries go.
      sent.set(key, [...(sent.get(key) ?? []).filter(t => t > at - DAY_MS), at]);
    },
    since(address, from) {
      return (sent.get(address.toLowerCase()) ?? []).filter(t => t > from).length;
    }
  };
}

let shared: SendLog | undefined;
export const sharedSendLog = () => shared ??= createSendLog();
