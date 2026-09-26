import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE, NEW_IMAGE, createWorld, typical } from './flowHarness.js';

// The menu on an existing installation (design §3.9).
let w: ReturnType<typeof createWorld> | undefined;
afterEach(() => { w?.cleanup(); w = undefined; });

const credentialsOf = (world: ReturnType<typeof createWorld>) => JSON.parse(world.fake.state.secrets.get('universal-mail-credentials')!.at(-1)!);
const stateOf = (world: ReturnType<typeof createWorld>) => JSON.parse(world.fake.state.secrets.get('universal-mail-state')!.at(-1)!);

async function installed() {
  w = createWorld();
  typical(w);
  expect(await w.run()).toEqual({ outcome: 'done' });
  w.clearScreen();
  w.fake.calls.length = 0;
  return w;
}

describe('the menu', () => {
  it('SET-50 an existing install shows the four-item menu, and changes nothing until one is chosen', async () => {
    const world = await installed();
    world.answers('3');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.text()).toContain('Universal Mail is installed · version 2.0.0');
    for (const item of ['1 Check and fix', '2 Update', '3 Show my Universal Mail address', '4 Remove']) expect(world.text()).toContain(item);
    expect(world.text()).not.toContain('Step 1 of 8');
    expect(world.fake.changes()).toEqual([]);
  });

  it('SET-50 the menu also appears after Cloud Shell has cleared its files, found from Google itself', async () => {
    const world = await installed();
    world.clearHome();
    world.answers('3');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.text()).toContain('Universal Mail is installed');
    expect(world.fake.changes()).toEqual([]);
  });

  it('SET-51 Check and fix repairs a revoked password: a new one is checked, saved, the server restarted, and checked again', async () => {
    const world = await installed();
    // The person revoked the app password at Yahoo and made a new one.
    world.accounts['me@yahoo.com']!.password = 'brand-new-app-password';
    world.answers('1', 'wrong-one', '', 'brand-new-app-password');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.text()).toContain('Yahoo Mail no longer accepts the app password for me@yahoo.com.');
    expect(world.screen()).toContain('(MAIL-APP-PASSWORD)');
    expect(credentialsOf(world).passwords.yahoo).toBe('brand-new-app-password');
    // Only the one password changed; the other account's is kept.
    expect(credentialsOf(world).passwords.gmail).toBe(world.accounts['fleet@gmail.com']!.password);
    expect(world.fake.changes()).toEqual(['putSecret', 'restartServer']);
    // Checked before and after the repair; the second check passed in full.
    expect(world.selfTests).toHaveLength(3);
    expect(world.text()).toContain('✓ 6 of 6 checks passed');
    expect(world.screen()).not.toContain('brand-new-app-password');
  });

  it('SET-51 Check and fix settles a Sent mode never settled: the sending test, saved, restarted, checked', async () => {
    const world = await installed();
    // As a conversion from version 1 can leave it: the Sent mode not yet known for yahoo.
    const state = stateOf(world);
    state.accounts[0].sentCopyMode = 'unverified';
    await world.fake.google.putSecret('p', 'universal-mail-state', JSON.stringify(state));
    await world.fake.google.restartServer('p', 0);
    world.fake.calls.length = 0;
    world.events.length = 0;
    world.answers('1');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.events).toContain('sendTest me@yahoo.com');
    expect(stateOf(world).accounts[0].sentCopyMode).toBe('yahoo');
    expect(world.fake.changes()).toEqual(['putSecret', 'restartServer']);
    expect(world.text()).toContain('✓ 6 of 6 checks passed');
  });

  it('SET-50 an answer that isn\'t on the menu asks again', async () => {
    const world = await installed();
    world.answers('9', 'show', '3');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.asked.filter(a => a.code === 'ASK-MENU')).toHaveLength(3);
    expect(world.text()).toContain('Your Universal Mail page');
  });

  it('SET-51 a password repair can be skipped: the problem is named, nothing saved or restarted', async () => {
    const world = await installed();
    world.accounts['me@yahoo.com']!.password = 'brand-new-app-password';
    world.answers('1', 'not-it', 's');
    expect(await world.run()).toEqual({ outcome: 'stopped', code: 'SETUP-SELFTEST-FAILED' });
    expect(world.fake.changes()).toEqual([]);
    expect(credentialsOf(world).passwords.yahoo).not.toBe('brand-new-app-password');
  });

  it('SET-51 a mail server unreachable during the repair: its own message, then the same password tried again', async () => {
    const world = await installed();
    world.accounts['me@yahoo.com']!.password = 'brand-new-app-password';
    world.accounts['me@yahoo.com']!.failing = { reason: 'unreachable', times: 1 };
    world.answers('1', 'brand-new-app-password', '', 'brand-new-app-password');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.screen()).toContain('(MAIL-UNREACHABLE)');
    expect(credentialsOf(world).passwords.yahoo).toBe('brand-new-app-password');
  });

  it('SET-81 Check and fix repairs Google\'s side too: a missing $1 alarm and services turned off come back (added)', async () => {
    const world = await installed();
    world.fake.state.budget = undefined;
    world.fake.state.servicesEnabledAt = undefined;
    world.fake.state.billingLinked = false;
    world.answers('1');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.fake.changes()).toEqual(['linkBilling', 'enableServices', 'createBudget']);
    expect(world.text()).toContain('✓ Billing had come unlinked from the project, and was linked again.');
    expect(world.fake.state.budget).toBe(1);
    expect(world.text()).toContain('✓ The $1 cost alarm was missing, and was set again.');
    expect(world.text()).toContain('✓ Google services were off, and were turned on again.');
    expect(world.text()).toContain('checks passed');
  });

  it('SET-81 billing closed since the install: said plainly, and nothing else is touched', async () => {
    w = createWorld();
    typical(w);
    await w.run();
    w.clearScreen();
    w.fake.calls.length = 0;
    // The same world, now with its billing account closed.
    const closed = createWorld({ google: { billing: { state: 'suspended', trial: false } } });
    Object.assign(closed.fake.state, w.fake.state);
    closed.answers('1');
    try {
      expect(await closed.run()).toEqual({ outcome: 'stopped', code: 'SETUP-BILLING-SUSPENDED' });
      expect(closed.fake.changes()).toEqual([]);
    } finally { closed.cleanup(); }
  });

  it('SET-51 everything already working: checked, said so, nothing changed', async () => {
    const world = await installed();
    world.answers('1');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.text()).toContain('✓ 6 of 6 checks passed');
    expect(world.fake.changes()).toEqual([]);
  });

  it('SET-51 a problem it can\'t repair is named, with the report to share; nothing changed', async () => {
    w = createWorld({ selfTest: { failing: 'Something unexpected went wrong during this check.' } });
    typical(w);
    await w.run();
    w.clearScreen();
    w.fake.calls.length = 0;
    w.answers('1');
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-SELFTEST-FAILED' });
    expect(w.text()).toContain('The final check found a problem. Something unexpected went wrong during this check.');
    expect(w.fake.changes()).toEqual([]);
  });

  it('SET-52 Update installs the new version, checks it, and keeps it', async () => {
    const world = await installed();
    world.useImage(NEW_IMAGE);
    world.answers('2');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.fake.state.server!.image).toBe(NEW_IMAGE);
    expect(world.text()).toContain('✓ Updated to version 2.0.0.');
  });

  it('SET-52 Update rolls back when the new version fails its check; the previous version is running again', async () => {
    w = createWorld({ selfTest: { failingImage: NEW_IMAGE } });
    typical(w);
    await w.run();
    w.clearScreen();
    w.useImage(NEW_IMAGE);
    w.answers('2');
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-UPDATE-ROLLED-BACK' });
    expect(w.fake.state.server!.image).toBe(IMAGE);
    expect(w.text()).toContain('The new version didn\'t pass its check, so the previous one was put back.');
    expect(w.text()).toContain('This was handled for you.');
  });

  it('SET-52 Update with an image that can\'t be verified: refused, and the running version untouched', async () => {
    const world = await installed();
    world.useImage('us-docker.pkg.dev/universal-mail/release/server@sha256:dead');
    world.answers('2');
    expect(await world.run()).toEqual({ outcome: 'stopped', code: 'SETUP-IMAGE-UNTRUSTED' });
    expect(world.fake.changes()).toEqual([]);
    expect(world.fake.state.server!.image).toBe(IMAGE);
  });

  it('SET-52 Update when this is already the running version: said so, nothing changed', async () => {
    const world = await installed();
    world.answers('2');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.text()).toContain('You already have version 2.0.0.');
    expect(world.fake.changes()).toEqual([]);
  });

  it('SET-53 Show my address prints both addresses', async () => {
    const world = await installed();
    world.answers('3');
    await world.run();
    const key = stateOf(world).key;
    expect(world.text()).toContain(`https://universal-mail-4f2a-uc.a.run.app/${key}`);
    expect(world.text()).toContain(`https://universal-mail-4f2a-uc.a.run.app/${key}/mcp`);
  });

  it('SET-54 Remove needs the word typed; anything else keeps everything', async () => {
    const world = await installed();
    world.answers('4', 'yes');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.text()).toContain('Nothing was removed.');
    expect(world.fake.changes()).toEqual([]);
    expect(world.fake.state.deleted).toBe(false);
  });

  it('SET-54 Remove, confirmed, deletes the $1 alarm and the project, and forgets the install', async () => {
    const world = await installed();
    world.answers('4', 'remove');
    expect(await world.run()).toEqual({ outcome: 'done' });
    expect(world.fake.changes()).toEqual(['deleteBudget', 'deleteProject']);
    expect(world.fake.state.deleted).toBe(true);
    expect(world.fake.state.budget).toBeUndefined();
    expect(world.text()).toContain('Removed.');
    // Running setup again starts a fresh install.
    world.clearScreen();
    world.answers('');
    await world.run();
    expect(world.text()).toContain('Step 1 of 8');
  });
});
