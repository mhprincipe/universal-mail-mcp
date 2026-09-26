import * as crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_ALPHABET, createSigninCodes, formatCode, newCode, type SigninCodes } from '../../src/signin/codes.js';
import { createFakeClock, type FakeClock } from '../../testkit/src/fakeClock.js';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const MINUTE = 60_000;
let clock: FakeClock;
let sent: Array<{ account: string; to: string; code: string }>;
let broken: Set<string>;
let codes: SigninCodes;

beforeEach(() => {
  clock = createFakeClock(new Date('2026-09-25T09:00:00Z'));
  sent = [];
  broken = new Set();
  codes = createSigninCodes({
    clock, signInAddress: 'owner@example.invalid', senders: ['personal', 'work'],
    send: async (account, to, code) => {
      if (broken.has(account)) throw new Error('auth failed');
      sent.push({ account, to, code });
    }
  });
});

// Request a code and return the session it belongs to, with the code that was emailed.
async function issue(requester = 'requester-1') {
  const outcome = await codes.request(requester);
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  return { session: outcome.session, code: sent.at(-1)!.code };
}

describe('sign-in codes', () => {
  it('SIG-40 codes are 8 characters from the unambiguous alphabet', () => {
    expect(CODE_ALPHABET).toHaveLength(30);
    for (const confusable of ['0', '1', 'I', 'L', 'O', 'U']) expect(CODE_ALPHABET).not.toContain(confusable);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = newCode();
      expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`));
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(1990);
    expect(formatCode('K7Q2F9XM')).toBe('K7Q2-F9XM');
  });

  it('SIG-41 a code works once (and is forgiving about how it is typed)', async () => {
    const { session, code } = await issue();
    expect(codes.verify(session, ` ${formatCode(code).toLowerCase()} `)).toEqual({ ok: true });
    expect(codes.verify(session, code)).toEqual({ ok: false, reason: 'used' });
  });

  it('SIG-42 a code expires after 10 minutes', async () => {
    const first = await issue();
    clock.advance(9 * MINUTE + 59_000);
    expect(codes.verify(first.session, first.code)).toEqual({ ok: true });
    const second = await issue();
    clock.advance(10 * MINUTE + 1_000);
    expect(codes.verify(second.session, second.code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('SIG-43 five wrong attempts end a code', async () => {
    const { session, code } = await issue();
    const wrong = code.startsWith('2') ? '3' + code.slice(1) : '2' + code.slice(1);
    for (let i = 0; i < 4; i++) expect(codes.verify(session, wrong)).toEqual({ ok: false, reason: 'wrong' });
    expect(codes.verify(session, wrong)).toEqual({ ok: false, reason: 'too_many_attempts' });
    expect(codes.verify(session, code)).toEqual({ ok: false, reason: 'too_many_attempts' });
  });

  it('SIG-44 the sign-in address gets at most 5 codes an hour', async () => {
    for (let i = 0; i < 5; i++) await issue(`requester-${i}`);
    expect(await codes.request('requester-9')).toEqual({ ok: false, reason: 'rate_limited' });
    expect(sent).toHaveLength(5);
    clock.advance(60 * MINUTE + 1_000);
    expect((await codes.request('requester-9')).ok).toBe(true);
  });

  it('SIG-45 one requester gets at most 3 codes an hour, leaving the rest for the owner', async () => {
    for (let i = 0; i < 3; i++) await issue('abuser');
    expect(await codes.request('abuser')).toEqual({ ok: false, reason: 'rate_limited' });
    expect((await codes.request('owner-browser')).ok).toBe(true);
  });

  it('SIG-46 codes go only to the sign-in address', async () => {
    await issue('requester-1');
    await issue('requester-2');
    expect(sent.map(s => s.to)).toEqual(['owner@example.invalid', 'owner@example.invalid']);
  });

  it('SIG-47 if the sign-in account can\'t send, the code goes out through another working account', async () => {
    broken.add('personal');
    const { session, code } = await issue();
    expect(sent).toEqual([{ account: 'work', to: 'owner@example.invalid', code }]);
    expect(codes.verify(session, code)).toEqual({ ok: true });
    broken.add('work');
    expect(await codes.request('requester-2')).toEqual({ ok: false, reason: 'send_failed' });
  });

  it('SIG-48 codes are compared with the constant-time function', async () => {
    const { session, code } = await issue();
    vi.mocked(crypto.timingSafeEqual).mockClear();
    codes.verify(session, code);
    expect(crypto.timingSafeEqual).toHaveBeenCalled();
  });
});
