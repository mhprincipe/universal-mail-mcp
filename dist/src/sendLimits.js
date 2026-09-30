const DAY_MS = 24 * 60 * 60 * 1000;
// The same as config.ts's defaults, for the page to show.
export const DEFAULT_SEND_LIMITS = { perHour: 30, perDay: 200 };
export function createSendLog() {
    const sent = new Map();
    return {
        record(address, at) {
            const key = address.toLowerCase();
            // Only the last day matters; older entries go.
            sent.set(key, [...(sent.get(key) ?? []).filter(t => t > at - DAY_MS), at]);
        },
        release(address, at) {
            const times = sent.get(address.toLowerCase()) ?? [];
            const i = times.lastIndexOf(at);
            if (i >= 0)
                times.splice(i, 1);
        },
        since(address, from) {
            return (sent.get(address.toLowerCase()) ?? []).filter(t => t > from).length;
        }
    };
}
let shared;
export const sharedSendLog = () => shared ??= createSendLog();
//# sourceMappingURL=sendLimits.js.map