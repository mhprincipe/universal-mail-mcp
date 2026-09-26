import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

// Owner sign-in by emailed code (design §6.5): 8 characters, single use, 10
// minutes, 5 tries, rate-limited, sent only to the sign-in address.

// 30 characters, without the ones people misread: 0 1 I L O U.
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const LIFETIME_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60_000;
// Protects the owner's inbox from being flooded.
const PER_ADDRESS_PER_HOUR = 5;
// One requester can't use up the hour's codes and lock the owner out.
const PER_REQUESTER_PER_HOUR = 3;

export function newCode(): string {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

// Shown as K7Q2-F9XM.
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

type Refusal = { ok: false; reason: string };
export type SigninCodes = {
  request(requester: string): Promise<{ ok: true; session: string } | Refusal>;
  verify(session: string, entered: string): { ok: true } | Refusal;
};

const digest = (value: string) => createHash('sha256').update(value).digest();

export function createSigninCodes(options: {
  clock: { now(): number };
  signInAddress: string;
  // Accounts that may send the code, the sign-in account first. A function
  // picks up accounts added since start-up.
  senders: string[] | (() => string[]);
  send(account: string, to: string, code: string): Promise<void>;
}): SigninCodes {
  const { clock } = options;
  const sessions = new Map<string, { hash: Buffer; expires: number; attempts: number; used: boolean }>();
  const sentAt: number[] = [];
  const byRequester = new Map<string, number[]>();
  const recent = (times: number[]) => times.filter(t => t > clock.now() - HOUR_MS);

  return {
    async request(requester) {
      const mine = recent(byRequester.get(requester) ?? []);
      if (recent(sentAt).length >= PER_ADDRESS_PER_HOUR || mine.length >= PER_REQUESTER_PER_HOUR) return { ok: false, reason: 'rate_limited' };
      const code = newCode();
      // Through the sign-in account if it works, otherwise any other.
      let delivered = false;
      for (const account of typeof options.senders === 'function' ? options.senders() : options.senders) {
        try { await options.send(account, options.signInAddress, code); delivered = true; break; } catch { /* try the next account */ }
      }
      if (!delivered) return { ok: false, reason: 'send_failed' };
      sentAt.push(clock.now());
      byRequester.set(requester, [...mine, clock.now()]);
      for (const [id, s] of sessions) if (s.expires < clock.now()) sessions.delete(id);
      const session = randomUUID();
      sessions.set(session, { hash: digest(code), expires: clock.now() + LIFETIME_MS, attempts: 0, used: false });
      return { ok: true, session };
    },

    verify(session, entered) {
      const s = sessions.get(session);
      if (!s) return { ok: false, reason: 'unknown' };
      if (s.used) return { ok: false, reason: 'used' };
      if (s.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
      if (s.expires < clock.now()) return { ok: false, reason: 'expired' };
      // Forgiving about case, spaces and the dash; compared as equal-length
      // digests, in constant time.
      const typed = digest(entered.toUpperCase().replace(/[\s-]/g, ''));
      if (timingSafeEqual(typed, s.hash)) { s.used = true; return { ok: true }; }
      s.attempts++;
      return { ok: false, reason: s.attempts >= MAX_ATTEMPTS ? 'too_many_attempts' : 'wrong' };
    }
  };
}
