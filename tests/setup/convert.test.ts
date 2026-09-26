import { afterEach, describe, expect, it } from 'vitest';
import { createWorld } from './flowHarness.js';

// SET-55: Update from version 1 (design §10), using a fixture of v1's
// settings: project and service yahoo-mail-mcp, its secrets yahoo-email and
// yahoo-app-password, and SENT_COPY_MODE. Version 1 itself is never changed:
// it keeps running, as the fallback, until the owner removes it.
let w: ReturnType<typeof createWorld> | undefined;
afterEach(() => { w?.cleanup(); w = undefined; });

const V1 = { project: 'yahoo-mail-mcp', email: 'me@yahoo.com', password: 'v1-app-password', sentCopyMode: 'yahoo' as const };
const secret = (world: ReturnType<typeof createWorld>, name: string) => JSON.parse(world.fake.state.secrets.get(name)!.at(-1)!);

describe('update from version 1', () => {
  it('SET-55 converts a v1 deployment: its account, address and Sent mode carried over, nothing asked twice, v1 untouched', async () => {
    w = createWorld({ google: { v1: V1 }, accounts: { 'me@yahoo.com': { provider: 'yahoo', password: V1.password } } });
    w.answers('');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.asked.map(a => a.code)).toEqual(['ASK-CONVERT']);
    const state = secret(w, 'universal-mail-state');
    expect(state.accounts).toMatchObject([{ name: 'personal', email: 'me@yahoo.com', sentCopyMode: 'yahoo' }]);
    expect(state.signInAddress).toBe('me@yahoo.com');
    expect(secret(w, 'universal-mail-credentials').passwords).toEqual({ personal: V1.password });
    // In v1's own project, now labelled as Universal Mail's; no second project.
    expect(w.fake.changes()).not.toContain('createProject');
    expect(w.fake.changes()).toContain('labelProject');
    // v1's secrets are only read, never written; its Sent mode needed no sending test.
    expect(w.fake.state.secrets.get('yahoo-app-password')).toEqual([V1.password]);
    expect(w.events.filter(e => e.startsWith('sendTest'))).toEqual([]);
    expect(w.text()).toContain('All done.');
    expect(w.text()).toContain('Version 1 is still running, unchanged, as your fallback.');
    // The next run finds the new install.
    w.clearScreen();
    w.answers('3');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.text()).toContain('Universal Mail is installed');
  });

  it('SET-55 v1\'s password no longer accepted: a new app password is asked for, and used', async () => {
    w = createWorld({ google: { v1: V1 }, accounts: { 'me@yahoo.com': { provider: 'yahoo', password: 'made-since' } } });
    w.answers('', 'made-since', '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(w.asked.map(a => a.code).slice(0, 2)).toEqual(['ASK-CONVERT', 'ASK-APP-PASSWORD']);
    expect(secret(w, 'universal-mail-credentials').passwords).toEqual({ personal: 'made-since' });
  });

  it('SET-55 v1 with its Sent mode never verified: the sending test settles it', async () => {
    w = createWorld({ google: { v1: { ...V1, sentCopyMode: 'unverified' } }, accounts: { 'me@yahoo.com': { provider: 'yahoo', password: V1.password, copies: 0 } } });
    w.answers('', '');
    expect(await w.run()).toEqual({ outcome: 'done' });
    expect(secret(w, 'universal-mail-state').accounts[0].sentCopyMode).toBe('append');
  });

  it('SET-55 declining the conversion is an ordinary new install', async () => {
    w = createWorld({ google: { v1: V1 } });
    w.answers('n', '');
    expect(await w.run()).toEqual({ outcome: 'stopped', code: 'SETUP-NO-ACCOUNTS' });
    expect(w.asked.map(a => a.code).slice(0, 2)).toEqual(['ASK-CONVERT', 'ASK-ADDRESS']);
    expect(w.fake.changes()).toEqual([]);
  });
});
