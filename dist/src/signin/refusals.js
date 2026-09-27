export function createRefusals() {
    const counts = new Map();
    return {
        record(reason, app = 'unknown') {
            const name = app.slice(0, 200);
            console.log(JSON.stringify({ event: 'signin_refused', reason, app: name }));
            const forApp = counts.get(name) ?? {};
            forApp[reason] = (forApp[reason] ?? 0) + 1;
            counts.set(name, forApp);
        },
        counts: () => Object.fromEntries(counts)
    };
}
//# sourceMappingURL=refusals.js.map