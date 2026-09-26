import type { InstallStore } from '../installed.js';
import type { AccountGrant, Action, GrantStore } from '../signin/grants.js';
import type { PageTools } from './routes.js';

// Your page: connected apps (design §3.6). Permissions change per app and per
// account, and apply to the app's very next request; giving Send needs your
// fingerprint, as on the approval page.

const ACTIONS: Action[] = ['read', 'organize', 'send'];

export function appActions(tools: PageTools, deps: {
  store: InstallStore; grants: GrantStore;
  disconnect(appId: string): Promise<void>;
  notify(subject: string, text: string): Promise<void>;
}) {
  const nameOf = (appId: string) => deps.grants.get(appId)?.appName ?? new URL(appId).host;

  tools.post('/apps/permissions', async (req, res, session) => {
    const appId = String(req.body.app ?? '');
    const current = deps.grants.get(appId);
    if (!current) return tools.back(res, session, { kind: 'error', text: 'That app isn\'t connected any more.' });
    const grant: AccountGrant = {};
    for (const { name } of deps.store.accounts()) {
      const actions = ACTIONS.filter(action => req.body[`${name}:${action}`] === 'on');
      if (actions.length) grant[name] = actions;
    }
    if (!Object.keys(grant).length) return tools.back(res, session, { kind: 'error', text: 'Choose at least one account, or disconnect the app instead.' });
    // Send it didn't have before needs a fingerprint; Send it already had can stay.
    const newSend = Object.entries(grant).some(([account, actions]) => actions.includes('send') && !current.accounts[account]?.includes('send'));
    if (newSend && !tools.canGrantSend(session)) return tools.back(res, session, { kind: 'error', text: 'Giving Send needs your fingerprint. Sign in with it, then try again.' });
    deps.grants.update(appId, grant);
    const name = nameOf(appId);
    await deps.notify(`${name}'s permissions changed`, `${name} can now use: ${Object.entries(grant).map(([a, acts]) => `${a} (${acts.join(', ')})`).join('; ')}.`);
    tools.back(res, session, { kind: 'ok', text: `${name}'s permissions were saved.` });
  });

  tools.post('/apps/disconnect', async (req, res, session) => {
    const appId = String(req.body.app ?? '');
    if (!deps.grants.get(appId)) return tools.back(res, session, { kind: 'error', text: 'That app isn\'t connected any more.' });
    const name = nameOf(appId);
    await deps.disconnect(appId);
    tools.back(res, session, { kind: 'ok', text: `${name} was disconnected.` });
  });
}
