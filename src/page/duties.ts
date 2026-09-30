import type { InstallStore } from '../installed.js';
import { VERSION } from '../version.js';

// What the server does on its own (design §3.7). Cloud Run runs it only while
// requests arrive, so each duty is checked on a request, no more often than it
// needs: the free-trial reminder hourly, the update feed daily.

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// "Before day 80" (design §4.6): ten days' warning.
const TRIAL_REMINDER_AFTER = 70 * DAY;

// 2.1.0 > 2.0.1 > 2.0.0 > 2.0.0-dev.
export function newer(candidate: string, current: string): boolean {
  const parts = (v: string) => { const [core = '', pre] = v.split('-'); return { nums: core.split('.').map(n => Number(n) || 0), pre: Boolean(pre) }; };
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) if ((a.nums[i] ?? 0) !== (b.nums[i] ?? 0)) return (a.nums[i] ?? 0) > (b.nums[i] ?? 0);
  return !a.pre && b.pre;
}

export function createDuties(deps: {
  store: InstallStore; clock: { now(): number }; feedUrl?: string; fetchImpl?: typeof fetch;
  notify(subject: string, text: string): Promise<void>;
  // The tools this version has, and the apps connected now (NTC-01).
  tools?: readonly string[]; apps?(): string[];
}) {
  let trialChecked = -Infinity;
  let feedChecked = -Infinity;
  let toolsChecked = false;

  const trial = async (now: number) => {
    if (now - trialChecked < HOUR) return;
    trialChecked = now;
    const noted = deps.store.noted();
    const installedAt = Date.parse(String(noted.installedAt ?? ''));
    if (noted.trialReminder !== true || noted.trialReminderSent === true || !Number.isFinite(installedAt)) return;
    if (now < installedAt + TRIAL_REMINDER_AFTER) return;
    deps.store.note({ trialReminderSent: true });
    await deps.notify('Your Google Cloud free trial ends soon',
      'Your Google Cloud account is still on the free trial. When the trial ends, Google switches off anything still running, including Universal Mail, unless the account is upgraded.\n\nUpgrading is free: you\'re only charged beyond the free tier, and Universal Mail\'s $1 cost alarm tells you if that ever happens.\n\n1. Open console.cloud.google.com/billing\n2. Click "Activate full account"');
  };

  const updates = async (now: number) => {
    if (!deps.feedUrl || now - feedChecked < DAY) return;
    feedChecked = now;
    try {
      const response = await (deps.fetchImpl ?? fetch)(deps.feedUrl, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      const feed = await response.json() as { version?: unknown; security?: unknown };
      const version = typeof feed.version === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(feed.version) ? feed.version : undefined;
      if (!version || !newer(version, VERSION) || deps.store.noted().updateNotified === version) return;
      deps.store.note({ updateNotified: version });
      const security = feed.security === true;
      await deps.notify(`Universal Mail ${version} is available${security ? ' (security update)' : ''}`,
        `${security ? 'This update fixes a security problem. Please install it soon.\n\n' : ''}To install it: open Google Cloud Shell from the Universal Mail website, type  node setup.js  and choose 2, Update. It checks the new version and puts the old one back if the check fails.`);
    } catch (error) {
      console.log(JSON.stringify({ event: 'update_check_failed', error: (error as Error)?.name ?? typeof error }));
    }
  };

  // New tools (NTC-01, NTC-02; found live: Claude kept the tool list it saw
  // when it was connected, and never saw five tools added since). Once per
  // start: the tools are compared with those noted last time; new ones, with
  // apps connected, are told once. A server updated from a version that noted
  // none has its apps told the whole count, once. A new installation, or the
  // same tools, says nothing.
  const tools = async () => {
    if (toolsChecked || !deps.tools) return;
    toolsChecked = true;
    const current = [...deps.tools];
    const saved = deps.store.noted().toolNames;
    const known = Array.isArray(saved) ? saved.filter((name): name is string => typeof name === 'string') : undefined;
    const added = known ? current.filter(name => !known.includes(name)) : undefined;
    const unchanged = known !== undefined && known.length === current.length && added!.length === 0;
    if (!unchanged) deps.store.note({ toolNames: current });
    const apps = deps.apps?.() ?? [];
    if (!apps.length || (added && !added.length)) return;
    const what = added
      ? `Universal Mail ${VERSION} added: ${added.join(', ')}.`
      : `Universal Mail ${VERSION} has ${current.length} tools. Apps connected before this version may still use an older list of them.`;
    await deps.notify('Universal Mail has new tools for your AI apps', `${what}

Your AI apps keep the list of tools they saw when you connected them, so they may not use new ones until you refresh the connection. Connected now: ${apps.join(', ')}.

Claude: Settings → Connectors → Universal Mail. Use its refresh option if there is one; otherwise Disconnect, then Connect again, and approve it on your Universal Mail page (then check its permissions there).
ChatGPT: Settings → Apps → Universal Mail, the same way.

Then start a new chat and ask: "List the Universal Mail tools you have." It should list ${current.length}.`);
  };

  return { run: async () => { const now = deps.clock.now(); await tools(); await trial(now); await updates(now); } };
}
