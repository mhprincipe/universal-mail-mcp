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
}) {
  let trialChecked = -Infinity;
  let feedChecked = -Infinity;

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

  return { run: async () => { const now = deps.clock.now(); await trial(now); await updates(now); } };
}
