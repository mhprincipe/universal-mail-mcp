import { createHmac, timingSafeEqual } from 'node:crypto';

// Paddle, the merchant of record (design §13.1): its webhook signature and
// the parts of its events we read. As documented; the live setup confirms it.

// Paddle-Signature: ts=<unix seconds>;h1=<hex HMAC-SHA256 of "ts:body">.
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export function verifyPaddleSignature(header: string | undefined, rawBody: string, secret: string, now: number): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(';').map(p => p.trim().split('=') as [string, string]));
  const ts = Number(parts.ts);
  const h1 = parts.h1 ?? '';
  if (!Number.isInteger(ts) || Math.abs(now - ts * 1000) > SIGNATURE_WINDOW_MS) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(h1);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type PaddleSubscription = {
  id: string; status: string; paidThrough?: string; plan: 'monthly' | 'yearly' | string; portal?: string; install?: string;
};

// What we keep of a subscription event: nothing about the person but what
// the merchant's own ids say, plus the install id our page sent as custom data.
export function readSubscription(data: unknown): PaddleSubscription | undefined {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d.id !== 'string' || typeof d.status !== 'string') return undefined;
  const period = d.current_billing_period as { ends_at?: unknown } | null | undefined;
  const items = d.items as Array<{ price?: { billing_cycle?: { interval?: unknown } } }> | undefined;
  const interval = items?.[0]?.price?.billing_cycle?.interval;
  const urls = d.management_urls as { update_payment_method?: unknown } | null | undefined;
  const custom = d.custom_data as { install?: unknown } | null | undefined;
  return {
    id: d.id, status: d.status,
    ...(typeof period?.ends_at === 'string' ? { paidThrough: period.ends_at } : {}),
    plan: interval === 'year' ? 'yearly' : interval === 'month' ? 'monthly' : String(interval ?? 'unknown'),
    ...(typeof urls?.update_payment_method === 'string' ? { portal: urls.update_payment_method } : {}),
    ...(typeof custom?.install === 'string' && custom.install ? { install: custom.install } : {})
  };
}
