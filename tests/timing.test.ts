import { describe, expect, it } from 'vitest';
import { measuring, phase, rounded, timedClient, type Phases } from '../src/timing.js';

// DIA-13 (added: the owner's fourth live run, 2026-09-29): get_thread, send
// and reply stayed slow after tuning that guessed where their time went. Each
// tool's log line now says where it went: per step (a login, each kind of mail
// server command, the SMTP send, parsing), total time and how many times.
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('where a tool call spends its time', () => {
  it('DIA-13 each named step adds its time and a count to the call it belongs to', async () => {
    const phases: Phases = {};
    const value = await measuring(phases, async () => {
      await phase('imap.search', () => pause(20));
      await phase('imap.search', () => pause(20));
      await phase('smtp.send', () => pause(5));
      return 'answer';
    });
    expect(value).toBe('answer');
    expect(phases['imap.search']!.n).toBe(2);
    expect(phases['imap.search']!.ms).toBeGreaterThanOrEqual(35);
    expect(phases['smtp.send']!.n).toBe(1);
    expect(Object.keys(phases).sort()).toEqual(['imap.search', 'smtp.send']);
  });

  it('DIA-13 a step that fails still counts; outside a call nothing is kept', async () => {
    const phases: Phases = {};
    await measuring(phases, () => phase('imap.connect', async () => { await pause(5); throw new Error('refused'); }).catch(() => undefined));
    expect(phases['imap.connect']!.n).toBe(1);
    await expect(phase('imap.search', async () => 7)).resolves.toBe(7);
    // Work after the call has ended isn't put down to it.
    expect(phases['imap.search']).toBeUndefined();
  });

  it('DIA-13 two calls at once each keep only their own steps', async () => {
    const a: Phases = {}; const b: Phases = {};
    await Promise.all([
      measuring(a, async () => { await pause(10); await phase('imap.fetchOne', () => pause(10)); }),
      measuring(b, async () => { await phase('smtp.send', () => pause(15)); })
    ]);
    expect(Object.keys(a)).toEqual(['imap.fetchOne']);
    expect(Object.keys(b)).toEqual(['smtp.send']);
  });

  it('DIA-13 rounded for the log: whole milliseconds', () => {
    expect(rounded({ 'imap.search': { ms: 12.6, n: 2 } })).toEqual({ 'imap.search': { ms: 13, n: 2 } });
  });

  it('DIA-13 a mail connection is timed per command, and otherwise behaves exactly as itself', async () => {
    const raw = {
      usable: true,
      mailbox: { path: 'INBOX', exists: 3 },
      calls: 0,
      async search(this: { calls: number }) { this.calls++; await pause(5); return [1, 2]; },
      async fetchOne() { return { uid: 1 }; },
      on(this: { usable: boolean }) { return this.usable ? 'not timed' : 'lost itself'; }
    };
    const client = timedClient(raw, 'imap');
    const phases: Phases = {};
    await measuring(phases, async () => {
      expect(await client.search()).toEqual([1, 2]);
      expect(await client.fetchOne()).toEqual({ uid: 1 });
      expect(client.on()).toBe('not timed');
      // Handed on by itself (as a callback), a method still belongs to the connection.
      const { on } = client;
      expect((on as () => string)()).toBe('not timed');
    });
    // Its own state, through the wrapper; `this` is the real connection.
    expect(client.usable).toBe(true);
    expect(client.mailbox.exists).toBe(3);
    expect(raw.calls).toBe(1);
    expect(Object.keys(phases).sort()).toEqual(['imap.fetchOne', 'imap.search']);
  });
});
