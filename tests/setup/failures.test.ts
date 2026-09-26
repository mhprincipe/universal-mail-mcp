import { afterEach, describe, expect, it } from 'vitest';
import { GoogleRefusal } from '../../src/setup/google.js';
import { createWorld, typical } from './flowHarness.js';

// The failure matrix (design §8.2): each asserts the exact message, the code,
// and that what it says about the person's position is true.
let w: ReturnType<typeof createWorld> | undefined;
afterEach(() => { w?.cleanup(); w = undefined; });

const stateOf = (world: ReturnType<typeof createWorld>) => JSON.parse(world.fake.state.secrets.get('universal-mail-state')!.at(-1)!);

describe('setup failures', () => {
  it('SET-30 billing missing: the fix, and truly nothing changed', async () => {
    w = createWorld({ google: { billing: { state: 'missing', trial: false } } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-BILLING-MISSING' });
    expect(w.text()).toContain('Google Cloud billing isn\'t set up yet.');
    expect(w.text()).toContain('console.cloud.google.com/billing');
    expect(w.text()).toContain('Nothing was changed.');
    expect(w.fake.changes()).toEqual([]);
  });

  it('SET-31 billing suspended: before any change, and after the project exists', async () => {
    w = createWorld({ google: { billing: { state: 'suspended', trial: false } } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-BILLING-SUSPENDED' });
    expect(w.text()).toContain('Nothing was changed.');
    expect(w.fake.changes()).toEqual([]);
    w.cleanup();

    // Closed between the check and linking it: the project exists now, so the
    // message must not claim nothing changed.
    w = createWorld({ google: { refuse: { linkBilling: new GoogleRefusal('SETUP-BILLING-SUSPENDED') } } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-BILLING-SUSPENDED' });
    expect(w.fake.changes()).toEqual(['createProject']);
    expect(w.text()).toContain('Your progress is saved.');
    expect(w.text()).not.toContain('Nothing was changed.');
  });

  it('SET-32 free-trial account: the upgrade prompt; skipping records the reminder', async () => {
    w = createWorld({ google: { billing: { state: 'active', trial: true, accountId: 'billing-1' } } });
    w.answers('s', 'me@yahoo.com', '', w.accounts['me@yahoo.com']!.password, '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.text()).toContain('Your Google Cloud account is on the free trial.');
    expect(w.text()).toContain('Activate full account');
    expect(stateOf(w).trialReminder).toBe(true);
  });

  it('SET-33 company policy blocks public services: before and after changes', async () => {
    w = createWorld({ google: { blocksPublicServices: true } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-ORG-POLICY' });
    expect(w.text()).toContain('Use a personal Google account instead.');
    expect(w.fake.changes()).toEqual([]);
    w.cleanup();

    w = createWorld({ google: { refuse: { enableServices: new GoogleRefusal('SETUP-ORG-POLICY') } } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-ORG-POLICY' });
    expect(w.text()).toContain('Your progress is saved.');
  });

  it('SET-34 project quota used up: when known in advance, and when Google says so at creation', async () => {
    w = createWorld({ google: { canCreateProject: false } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-PROJECT-QUOTA' });
    expect(w.fake.changes()).toEqual([]);
    w.cleanup();

    w = createWorld({ google: { refuse: { createProject: new GoogleRefusal('SETUP-PROJECT-QUOTA') } } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-PROJECT-QUOTA' });
    // The refused creation changed nothing.
    expect(w.fake.state.project).toBeUndefined();
    expect(w.text()).toContain('Nothing was changed.');
  });

  it('SET-35 wrong app password: try again in place', async () => {
    w = createWorld();
    w.answers('me@yahoo.com', '', 'wrong', '', w.accounts['me@yahoo.com']!.password, '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.text()).toContain('Yahoo Mail didn\'t accept that app password.');
    expect(w.text()).toContain('Generate app password');
    expect(w.text()).toContain('Try again, or type s to skip this for now');
    expect(stateOf(w).accounts.map((a: { email: string }) => a.email)).toEqual(['me@yahoo.com']);
  });

  it('SET-36 a normal password pasted instead of an app password: the message says so', async () => {
    w = createWorld();
    w.answers('me@yahoo.com', '', 'my-normal-password', 's');
    await w.run();
    expect(w.text()).toContain('it\'s your normal password instead of an app password');
  });

  it('SET-37 unknown provider: fix the address in place', async () => {
    w = createWorld();
    // The corrected address is typed at the problem's own prompt.
    w.answers('me@yahooo.com', 'me@yahoo.com', '', w.accounts['me@yahoo.com']!.password, '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.text()).toContain('We couldn\'t work out how to reach me@yahooo.com.');
    expect(stateOf(w).accounts.map((a: { email: string }) => a.email)).toEqual(['me@yahoo.com']);
  });

  it('SET-38 provider without a safe move: kept with moving off, or skipped', async () => {
    w = createWorld({ accounts: { 'me@fastmail.com': { provider: 'fastmail', password: 'fm-app-password', safeMove: false } } });
    w.answers('me@fastmail.com', '', 'fm-app-password', '', '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.text()).toContain('Fastmail can\'t move messages safely, so moving is turned off for me@fastmail.com.');
    expect(stateOf(w).accounts).toMatchObject([{ email: 'me@fastmail.com', safeMove: false }]);
  });

  it('SET-39 duplicate Sent copy: handled, and said so', async () => {
    w = createWorld({ accounts: { 'me@yahoo.com': { provider: 'yahoo', password: 'y-app-password', copies: 2 } } });
    w.answers('me@yahoo.com', '', 'y-app-password', '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.text()).toContain('me@yahoo.com kept two copies of the test email in Sent.');
    expect(w.text()).toContain('This was handled for you.');
    expect(stateOf(w).accounts[0].sentCopyMode).toBe('yahoo');
  });

  it('SET-71 mail server unreachable: not blamed on the password; Enter tries again with the same one (added)', async () => {
    w = createWorld({ accounts: { 'me@yahoo.com': { provider: 'yahoo', password: 'y-app-password', failing: { reason: 'unreachable', times: 1 } } } });
    w.answers('me@yahoo.com', '', 'y-app-password', '', '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.text()).toContain('We couldn\'t reach Yahoo Mail to check me@yahoo.com.');
    expect(w.text()).toContain('Your password hasn\'t been checked yet.');
    expect(w.screen()).not.toContain('(MAIL-APP-PASSWORD)');
    expect(w.asked.filter(a => a.code === 'ASK-APP-PASSWORD')).toHaveLength(1);
    expect(w.logEntries().filter(e => e.op === 'check').map(e => e.outcome)).toEqual(['unreachable', 'ok']);
    expect(stateOf(w).accounts.map((a: { email: string }) => a.email)).toEqual(['me@yahoo.com']);
  });

  it('SET-71 no secure connection: the password was not sent, and the log says why; s skips (added)', async () => {
    w = createWorld({ accounts: { 'me@yahoo.com': { provider: 'yahoo', password: 'y-app-password', failing: { reason: 'insecure', times: 9 } } } });
    w.answers('me@yahoo.com', '', 'y-app-password', 's');
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-NO-ACCOUNTS' });
    expect(w.text()).toContain('Yahoo Mail didn\'t offer a secure connection for me@yahoo.com, so your password wasn\'t sent.');
    expect(w.screen()).not.toContain('(MAIL-APP-PASSWORD)');
    expect(w.logEntries().filter(e => e.op === 'check').map(e => e.outcome)).toEqual(['insecure']);
  });

  it('SET-80 every stop ends with how to get help, unless its own steps already say it (added: found by DIA-04)', async () => {
    w = createWorld({ google: { billing: { state: 'missing', trial: false } } });
    typical(w);
    await w.run();
    expect(w.text()).toContain('Stuck? Type node setup.js report and paste what it shows into your AI.');
    w.cleanup();
    // SETUP-SELFTEST-FAILED's steps already point to the report: not said twice.
    w = createWorld({ selfTest: { failing: 'Something unexpected went wrong during this check.' } });
    typical(w);
    await w.run();
    expect(w.text().split('setup.js report').length - 1).toBe(1);
  });

  it('SET-40 not running in Cloud Shell: nothing asked of Google at all', async () => {
    w = createWorld({ cloudShell: false });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-NOT-CLOUD-SHELL' });
    expect(w.text()).toContain('Open in Cloud Shell');
    expect(w.fake.calls).toEqual([]);
  });
});
