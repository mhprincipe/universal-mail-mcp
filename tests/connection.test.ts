import { describe, expect, it } from 'vitest';
import { MailError } from '../src/errors.js';
import { ImapGateway } from '../src/mail/imap.js';

// ENG-18 (added: the owner's live baseline, 2026-09-28). Every tool call paid
// about 3.3 s to open a new encrypted connection and log in, and multi-step
// tools paid it several times (get_thread 18.7 s, update_draft 11.3 s). The
// design deferred reuse "until measurements show logins dominate": they did.
// One connection per account is now kept and reused, one call at a time,
// checked before reuse after a pause, and never reused after a failure.
type Fake = { id: number; connects: number; logouts: number; closes: number; noops: number; usable: boolean; noopFails?: boolean; noopHangs?: boolean };

function world(options: { connectFails?: Error } = {}) {
  const made: Fake[] = [];
  let now = 1_000_000;
  const gateway = new ImapGateway({ IMAP_HOST: 'h', IMAP_PORT: 993, IMAP_TLS: 'implicit', YAHOO_EMAIL: 'me@yahoo.com', YAHOO_APP_PASSWORD: 'x' } as never, {
    clock: { now: () => now },
    noopTimeoutMs: 50,
    createClient: () => {
      const fake: Fake = { id: made.length + 1, connects: 0, logouts: 0, closes: 0, noops: 0, usable: false };
      made.push(fake);
      return {
        get usable() { return fake.usable; },
        connect: async () => { fake.connects++; if (options.connectFails) throw options.connectFails; fake.usable = true; },
        logout: async () => { fake.logouts++; fake.usable = false; },
        close: () => { fake.closes++; fake.usable = false; },
        noop: async () => {
          fake.noops++;
          if (fake.noopHangs) return new Promise(() => undefined);
          if (fake.noopFails) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
        },
        fake
      } as never;
    }
  });
  const use = <T>(fn: (fake: Fake) => T | Promise<T>) => gateway.run(async client => fn((client as unknown as { fake: Fake }).fake));
  return { gateway, made, use, advance: (ms: number) => { now += ms; } };
}

describe('the mail server connection', () => {
  it('ENG-18 many calls in a row share one connection and one login (added: found in the live baseline)', async () => {
    const w = world();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await w.use(f => f.id));
    expect(ids).toEqual([1, 1, 1, 1, 1]);
    expect(w.made).toHaveLength(1);
    expect(w.made[0]).toMatchObject({ connects: 1, logouts: 0, noops: 0 });
  });

  it('ENG-18 calls that arrive together take turns on the connection, in order', async () => {
    const w = world();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = w.use(async () => { order.push('first starts'); await new Promise<void>(r => { releaseFirst = r; }); order.push('first ends'); });
    const second = w.use(async () => { order.push('second runs'); });
    await new Promise(r => setTimeout(r, 10));
    expect(order).toEqual(['first starts']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first starts', 'first ends', 'second runs']);
    expect(w.made).toHaveLength(1);
  });

  it('ENG-18 after a pause the connection is checked first; a dead or silent one is replaced, not used', async () => {
    const w = world();
    await w.use(() => undefined);
    // Within the pause allowance: no check.
    w.advance(10_000);
    await w.use(() => undefined);
    expect(w.made[0]!.noops).toBe(0);
    // After it: checked, and alive, so kept.
    w.advance(180_000);
    expect(await w.use(f => f.id)).toBe(1);
    expect(w.made[0]!.noops).toBe(1);
    // The server dropped it meanwhile: replaced.
    w.advance(180_000);
    w.made[0]!.noopFails = true;
    expect(await w.use(f => f.id)).toBe(2);
    expect(w.made[0]!.closes).toBe(1);
    // A check that never answers: given up on quickly, replaced.
    w.advance(180_000);
    w.made[1]!.noopHangs = true;
    expect(await w.use(f => f.id)).toBe(3);
  });

  it('ENG-26 a pause of up to two minutes costs no check: the check itself took Yahoo about a second (added: measured live)', async () => {
    const w = world();
    await w.use(() => undefined);
    w.advance(90_000);
    await w.use(() => undefined);
    w.advance(119_000);
    await w.use(() => undefined);
    expect(w.made[0]!.noops).toBe(0);
    w.advance(121_000);
    await w.use(() => undefined);
    expect(w.made[0]!.noops).toBe(1);
    expect(w.made).toHaveLength(1);
  });

  it('ENG-18 a connection the server closed is never handed out', async () => {
    const w = world();
    await w.use(() => undefined);
    w.made[0]!.usable = false;
    expect(await w.use(f => f.id)).toBe(2);
  });

  it('ENG-18 after a failure mid-call the connection is dropped, and the next call gets a fresh one; a mail-level refusal keeps it', async () => {
    const w = world();
    await expect(w.use(() => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); })).rejects.toThrow();
    expect(w.made[0]!.closes).toBe(1);
    expect(await w.use(f => f.id)).toBe(2);
    // "No such message" says nothing about the connection: it stays.
    await expect(w.use(() => { throw new MailError('MESSAGE_NOT_FOUND', 'gone'); })).rejects.toThrow('gone');
    expect(await w.use(f => f.id)).toBe(2);
    expect(w.made).toHaveLength(2);
  });

  it('ENG-18 a read that fails on a stale connection is retried once on a fresh one', async () => {
    const w = world();
    let tries = 0;
    const answer = await w.gateway.read(async () => {
      tries++;
      if (tries === 1) throw Object.assign(new Error('Connection closed'), { code: 'EPIPE' });
      return 'ok';
    });
    expect(answer).toBe('ok');
    expect(w.made).toHaveLength(2);
  });

  it('ENG-18 a login that fails is not kept: the next call tries again', async () => {
    const w = world({ connectFails: Object.assign(new Error('Authentication failed.'), { authenticationFailed: true }) });
    await expect(w.use(() => undefined)).rejects.toThrow();
    await expect(w.use(() => undefined)).rejects.toThrow();
    expect(w.made).toHaveLength(2);
  });

  it('ENG-18 closing the gateway logs out of the shared connection', async () => {
    const w = world();
    await w.use(() => undefined);
    await w.gateway.close();
    expect(w.made[0]!.logouts).toBe(1);
    expect(await w.use(f => f.id)).toBe(2);
  });
});
