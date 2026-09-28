import { afterEach, describe, expect, it } from 'vitest';
import { scanForCanaries } from '../../testkit/src/canary.js';
import { IMAGE, NEW_IMAGE, createWorld, typical } from './flowHarness.js';

let w: ReturnType<typeof createWorld> | undefined;
afterEach(() => { w?.cleanup(); w = undefined; });

const stateOf = (world: ReturnType<typeof createWorld>) => JSON.parse(world.fake.state.secrets.get('universal-mail-state')!.at(-1)!);
const credentialsOf = (world: ReturnType<typeof createWorld>) => JSON.parse(world.fake.state.secrets.get('universal-mail-credentials')!.at(-1)!);

describe('setup flow', () => {
  it('SET-10 nothing changes in Google Cloud before step 3', async () => {
    w = createWorld();
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'done' });
    const firstChange = w.fake.calls.findIndex(c => c.write);
    expect(w.fake.calls[firstChange]!.name).toBe('createProject');
    expect(w.screen().indexOf('Step 3 of 8')).toBeGreaterThan(-1);
    // And a run that stops in step 2 changes nothing at all.
    const stopped = createWorld();
    stopped.answers('nobody@unknown.example', '', 's');
    expect((await stopped.run()).outcome).toBe('stopped');
    expect(stopped.fake.changes()).toEqual([]);
    stopped.cleanup();
  });

  it('SET-11 email passwords are checked before the project is created', async () => {
    w = createWorld();
    typical(w);
    await w.run();
    const created = w.events.indexOf('google createProject');
    expect(w.events.indexOf('check me@yahoo.com')).toBeLessThan(created);
    expect(w.events.indexOf('check fleet@gmail.com')).toBeLessThan(created);
  });

  it('SET-12 a complete install run twice changes nothing the second time', async () => {
    w = createWorld();
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'done' });
    const before = w.fake.changes().length;
    // The second run is the menu (SET-50); checking everything changes nothing.
    w.answers('1');
    w.clearScreen();
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.fake.changes().length).toBe(before);
    expect(w.screen()).toContain('checks passed');
  });

  it('SET-13 interrupted after any change, a rerun resumes with no duplicate creates', async () => {
    const complete = createWorld();
    typical(complete);
    await complete.run();
    const total = complete.fake.changes().length;
    complete.cleanup();
    expect(total).toBeGreaterThan(5);

    for (let n = 0; n < total; n++) {
      const world = createWorld();
      typical(world);
      world.fake.interruptAfterChanges(n);
      // A closed tab: here, the run ends; in Cloud Shell the process just stops.
      expect(await world.run(), `after ${n} changes`).toEqual({ outcome: 'stopped', code: 'SETUP-UNEXPECTED' });
      world.fake.interruptAfterChanges(undefined);
      world.clearScreen();
      // Passwords again only if they weren't stored yet; Enter for the rest.
      const stored = world.fake.state.secrets.has('universal-mail-credentials');
      // Enter to continue; then the passwords, only if they weren't stored yet.
      world.answers('', ...(stored ? [] : [world.accounts['me@yahoo.com']!.password, world.accounts['fleet@gmail.com']!.password]));
      expect(await world.run(), `after ${n} changes`).toEqual({ outcome: 'done' });
      expect(world.screen(), `after ${n} changes`).toMatch(/Welcome back\. The last setup stopped at step \d of 8/);
      expect(world.fake.state.project).toBe('universal-mail-4f2a');
      expect(world.fake.state.budget).toBe(1);
      world.cleanup();
    }
  });

  it('SET-14 slow service enablement shows the waiting message, then succeeds', async () => {
    w = createWorld({ google: { servicesReadyAfterMs: 40_000 } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.screen()).toContain('Google is still turning this on. Usually under a minute.');
  });

  it('SET-15 enablement that never becomes ready stops with GOOGLE-SERVICE-NOT-READY, progress saved', async () => {
    w = createWorld({ google: { servicesReadyAfterMs: 60 * 60_000 } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'GOOGLE-SERVICE-NOT-READY' });
    expect(w.screen()).toContain('Your progress is saved.');
    expect(w.fake.state.server).toBeUndefined();
    // Later, it continues from there.
    await w.clock.sleep(60 * 60_000);
    w.answers('', w.accounts['me@yahoo.com']!.password, w.accounts['fleet@gmail.com']!.password);
    expect(await w.run()).toEqual({ outcome: 'done' });
  });

  it('SET-16 slowly spreading permissions are waited for, then succeed', async () => {
    w = createWorld({ google: { permissionLateAttempts: 3 } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.fake.state.server).toBeDefined();
  });

  it('SET-17 "All done" appears only after the self-test passes', async () => {
    w = createWorld();
    typical(w);
    await w.run();
    expect(w.selfTests).toEqual(['https://universal-mail-4f2a-uc.a.run.app']);
    expect(w.screen().indexOf('82 of 82 checks passed')).toBeLessThan(w.screen().indexOf('All done.'));
    expect(w.screen()).toMatch(/https:\/\/universal-mail-4f2a-uc\.a\.run\.app\/[A-Za-z0-9_-]{20,}\/mcp/);
  });

  it('SET-18 a failed self-test names the failing check and never shows "All done"', async () => {
    // The failing check arrives as the report's cause: a whole sentence.
    w = createWorld({ selfTest: { failing: 'Gmail no longer accepts the app password.' } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-SELFTEST-FAILED' });
    expect(w.text()).toContain('The final check found a problem. Gmail no longer accepts the app password.');
    expect(w.text()).not.toContain('..');
    expect(w.screen()).not.toContain('All done.');
  });

  it('SET-19 the $1 budget is created', async () => {
    w = createWorld();
    typical(w);
    await w.run();
    expect(w.fake.state.budget).toBe(1);
  });

  it('SET-20 an unsigned or mismatched image is refused before it\'s started', async () => {
    w = createWorld({ google: { trustedImages: [] } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-IMAGE-UNTRUSTED' });
    expect(w.fake.changes()).not.toContain('startServer');
  });

  it('SET-21 passwords never reach disk', async () => {
    w = createWorld();
    typical(w);
    await w.run();
    const passwords = Object.values(w.accounts).map(a => a.password);
    expect(scanForCanaries(passwords, { dirs: [w.home] })).toEqual([]);
    // They did reach the secret store, and only there.
    expect(Object.values(credentialsOf(w).passwords).sort()).toEqual([...passwords].sort());
  });

  it('SET-23 pressing Enter at every prompt produces a correct install', async () => {
    w = createWorld();
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'done' });
    const state = stateOf(w);
    expect(state.accounts.map((a: { name: string; email: string }) => `${a.name}=${a.email}`)).toEqual(['yahoo=me@yahoo.com', 'gmail=fleet@gmail.com']);
    expect(state.signInAddress).toBe('me@yahoo.com');
    // When it was installed: the free-trial reminder counts from here (PG-14).
    expect(state.installedAt).toBe('2026-09-25T10:00:00.000Z');
    expect(state.accounts.map((a: { sentCopyMode: string }) => a.sentCopyMode)).toEqual(['yahoo', 'yahoo']);
    expect(w.fake.state.server?.image).toBe(IMAGE);
    expect(w.fake.state.server?.settings.PUBLIC_URL).toBe('https://universal-mail-4f2a-uc.a.run.app');
  });

  // Found live, 2026-09-27: step 8 failed on a server bug fixed in the next
  // release, but a rerun kept the running server ("already started"), so the
  // fix could never arrive and the check would fail on the version instead.
  it('SET-83 rerunning an unfinished install with a newer release starts the newer server before checking (added: found live)', async () => {
    w = createWorld({ selfTest: { failingImage: IMAGE } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-SELFTEST-FAILED' });
    expect(w.fake.state.server!.image).toBe(IMAGE);

    w.useImage(NEW_IMAGE);
    w.answers('', w.accounts['me@yahoo.com']!.password, w.accounts['fleet@gmail.com']!.password);
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.fake.state.server!.image).toBe(NEW_IMAGE);
    // The same server, brought up to date: not a second one, and nothing else redone.
    expect(w.events.filter(e => e === 'google createProject')).toHaveLength(1);
    expect(w.events.filter(e => e === 'sendTest me@yahoo.com')).toHaveLength(1);
  });

  it('SET-83 rerunning with the same release leaves the running server alone', async () => {
    w = createWorld({ selfTest: { failing: 'Something unexpected went wrong during this check.' } });
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-SELFTEST-FAILED' });
    const starts = w.fake.state.starts;
    w.answers('', w.accounts['me@yahoo.com']!.password, w.accounts['fleet@gmail.com']!.password);
    await w.run();
    expect(w.fake.state.starts).toBe(starts);
  });

  // Seen live, 2026-09-27: "Which address should get your sign-in codes? [yahoo]"
  // asked for an address but suggested a name, and the owner had to ask what to type.
  it('SET-23 the sign-in question suggests an address, and takes an address or a name (added: found live)', async () => {
    for (const [answer, expected] of [['', 'me@yahoo.com'], ['fleet@gmail.com', 'fleet@gmail.com'], ['FLEET@gmail.com ', 'fleet@gmail.com'], ['gmail', 'fleet@gmail.com']] as const) {
      w = createWorld();
      w.answers('me@yahoo.com', 'fleet@gmail.com', '', w.accounts['me@yahoo.com']!.password, '', w.accounts['fleet@gmail.com']!.password, '', answer);
      expect(await w.run(), answer).toEqual({ outcome: 'done' });
      expect(w.text()).toContain('Which address should get your sign-in codes? [me@yahoo.com] ›');
      expect(stateOf(w).signInAddress, answer).toBe(expected);
    }
  });

  it('SET-74 the server restarts after step 7 saves the Sent modes, so step 8 checks what was saved (added: found wiring step 8)', async () => {
    w = createWorld();
    typical(w);
    expect(await w.run()).toEqual({ outcome: 'done' });
    // Started once in step 6, then restarted to read the new settings, before the check.
    expect(w.fake.state.starts).toBe(2);
    const loaded = JSON.parse(w.fake.state.server!.loadedState!);
    expect(loaded.accounts.map((a: { sentCopyMode: string }) => a.sentCopyMode)).toEqual(['yahoo', 'yahoo']);
    const order = w.events.filter(e => /^google (start|restart)Server$/.test(e) || e === 'selfTest' || e.startsWith('sendTest'));
    expect(order).toEqual(['google startServer', 'sendTest me@yahoo.com', 'sendTest fleet@gmail.com', 'google restartServer', 'selfTest']);
    expect(w.selfTests).toEqual(['https://universal-mail-4f2a-uc.a.run.app']);
  });

  it('SET-74 skipping the sending test still saves "Universal Mail files Sent" and restarts before the check', async () => {
    w = createWorld();
    w.answers('me@yahoo.com', '', w.accounts['me@yahoo.com']!.password, '', '', 'n');
    expect(await w.run()).toEqual({ outcome: 'done' });
    // The "n" answered the sending question.
    expect(w.asked.map(a => a.code).slice(0, 6)).toEqual(['ASK-ADDRESS', 'ASK-ADDRESS', 'ASK-APP-PASSWORD', 'ASK-NAME', 'ASK-SIGNIN', 'ASK-SEND-TEST']);
    expect(JSON.parse(w.fake.state.server!.loadedState!).accounts[0].sentCopyMode).toBe('append');
  });

  it('SET-24 an account can be skipped with s, and the rest complete', async () => {
    w = createWorld();
    w.answers('me@yahoo.com', 'fleet@gmail.com', '', 'wrong-password', 's', w.accounts['fleet@gmail.com']!.password, '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.screen()).toContain('(MAIL-APP-PASSWORD)');
    expect(w.screen()).toContain('Skipped me@yahoo.com');
    expect(stateOf(w).accounts.map((a: { email: string }) => a.email)).toEqual(['fleet@gmail.com']);
    expect(Object.keys(credentialsOf(w).passwords)).toEqual(['gmail']);
  });
});
