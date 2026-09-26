// Grants live on the server, not in tokens (design §6.5): which accounts an app
// may use, and for which of Read, Organize and Send. Every request reads the
// current grant, so a change or a disconnect applies to the very next request.

export type Action = 'read' | 'organize' | 'send';
export type AccountGrant = Record<string, Action[]>;
export type Grant = { appId: string; appName?: string; connection: number; accounts: AccountGrant };

export type GrantStore = {
  get(appId: string): Grant | undefined;
  // A new connection. Its number is carried by the app's tokens, so tokens
  // from any earlier connection stop working.
  connect(appId: string, appName: string | undefined, accounts: AccountGrant): Grant;
  // Same connection, new permissions: no new token needed.
  update(appId: string, accounts: AccountGrant): Grant;
  disconnect(appId: string): void;
  // Everything needed to rebuild the store after a restart.
  snapshot(): GrantSnapshot;
};

// As saved in universal-mail-state: the current grants, and every app's last connection number.
export type GrantSnapshot = { apps: Grant[]; connections: Record<string, number> };

export function createGrantStore(saved: Partial<GrantSnapshot> = {}, onChange: (snapshot: GrantSnapshot) => void = () => undefined): GrantStore {
  const grants = new Map<string, Grant>((saved.apps ?? []).map(g => [g.appId, g]));
  // Survives disconnects, so a reconnection never reuses an old number.
  const connections = new Map<string, number>(Object.entries(saved.connections ?? {}));
  const snapshot = (): GrantSnapshot => ({ apps: [...grants.values()], connections: Object.fromEntries(connections) });
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
      if (!current) throw new Error(`No connection for ${appId}`);
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
