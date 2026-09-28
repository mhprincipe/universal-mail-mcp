import { createHmac, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLicenseApp } from '../../src/licenseService/app.js';
import { createMemoryStore } from '../../src/licenseService/store.js';
import { createFakeClock } from '../../testkit/src/fakeClock.js';

// The license service (design §13.3) on a port, with an in-memory store, a
// signing key made for the test, and Paddle's webhook secret; plus the
// events Paddle sends, signed the way Paddle signs them.
export const SERVICE_URL = 'https://license.example.invalid';
export const WEBHOOK_SECRET = 'pdl_ntfset_test_secret';
export const DAY = 24 * 60 * 60_000;

export async function startService(options: { start?: Date; maxInstalls?: number } = {}) {
  const clock = createFakeClock(options.start ?? new Date('2026-10-01T12:00:00Z'));
  const store = createMemoryStore();
  const signingKey: JsonWebKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  const app = createLicenseApp({
    store, signingKey, serviceUrl: SERVICE_URL, clock, paddleWebhookSecret: WEBHOOK_SECRET,
    checkout: { clientToken: 'test_client_token', monthlyPriceId: 'pri_monthly', yearlyPriceId: 'pri_yearly' },
    ...(options.maxInstalls ? { maxInstalls: options.maxInstalls } : {})
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}, from = '203.0.113.5') => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json, text };
  };
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, text: await response.text(), type: response.headers.get('content-type') ?? '' };
  };
  // Paddle's signature: ts and an HMAC-SHA256 of "ts:body" with the endpoint's secret.
  const signed = (body: string, options: { secret?: string; at?: number } = {}) => {
    const ts = Math.floor((options.at ?? clock.now()) / 1000);
    const h1 = createHmac('sha256', options.secret ?? WEBHOOK_SECRET).update(`${ts}:${body}`).digest('hex');
    return { 'paddle-signature': `ts=${ts};h1=${h1}` };
  };
  let eventNumber = 0;
  const event = (type: string, data: Record<string, unknown>, id?: string) => JSON.stringify({ event_id: id ?? `evt_${++eventNumber}`, event_type: type, occurred_at: new Date(clock.now()).toISOString(), data });
  const subscription = (over: Record<string, unknown> = {}) => ({
    id: 'sub_01', status: 'active', customer_id: 'ctm_01', custom_data: null,
    current_billing_period: { starts_at: new Date(clock.now()).toISOString(), ends_at: new Date(clock.now() + 31 * DAY).toISOString() },
    items: [{ status: 'active', price: { id: 'pri_monthly', name: 'Monthly', billing_cycle: { interval: 'month', frequency: 1 } } }],
    management_urls: { update_payment_method: 'https://pay.example.invalid/manage/sub_01', cancel: 'https://pay.example.invalid/cancel/sub_01' },
    ...over
  });
  const webhook = (type: string, data: Record<string, unknown>, options: { id?: string; secret?: string; at?: number } = {}) => {
    const body = event(type, data, options.id);
    return post('/webhook/paddle', body, signed(body, options));
  };

  return {
    base, clock, store, signingKey, post, get, signed, event, subscription, webhook,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}
