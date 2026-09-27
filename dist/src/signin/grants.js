// Grants live on the server, not in tokens (design §6.5): which accounts an app
// may use, and for which of Read, Organize and Send. Every request reads the
// current grant, so a change or a disconnect applies to the very next request.
export function createGrantStore(saved = {}, onChange = () => undefined) {
    const grants = new Map((saved.apps ?? []).map(g => [g.appId, g]));
    // Survives disconnects, so a reconnection never reuses an old number.
    const connections = new Map(Object.entries(saved.connections ?? {}));
    const snapshot = () => ({ apps: [...grants.values()], connections: Object.fromEntries(connections) });
    const changed = () => onChange(snapshot());
    return {
        get: appId => grants.get(appId),
        connect(appId, appName, accounts) {
            const connection = (connections.get(appId) ?? 0) + 1;
            connections.set(appId, connection);
            const grant = { appId, ...(appName ? { appName } : {}), connection, accounts };
            grants.set(appId, grant);
            changed();
            return grant;
        },
        update(appId, accounts) {
            const current = grants.get(appId);
            if (!current)
                throw new Error(`No connection for ${appId}`);
            const grant = { ...current, accounts };
            grants.set(appId, grant);
            changed();
            return grant;
        },
        disconnect(appId) {
            grants.delete(appId);
            connections.set(appId, (connections.get(appId) ?? 0) + 1);
            changed();
        },
        snapshot
    };
}
//# sourceMappingURL=grants.js.map