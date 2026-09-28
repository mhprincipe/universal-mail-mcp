import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY, SERVICE_URL, startService } from './harness.js';

// SUB-10, SUB-11 (design §13.3): the license service's routes, and Paddle's
// webhook. Nothing of the person's is kept beyond what the merchant sends.
let s: Awaited<ReturnType<typeof startService>> | undefined;
afterEach(async () => { await s?.close(); s = undefined; vi.restoreAllMocks(); });

const CODE = /^UM-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;

// A paid subscription, bought from the page (its install id travels as custom data).
async function paid(service: NonNullable<typeof s>, install = 'inst-1') {
  const r = await service.webhook('subscription.activated', service.subscription({ custom_data: { install } }));
  expect(r.status).toBe(200);
  const record = await service.store.get('subscriptions', 'sub_01') as { code: string };
  return record.code;
}
async function license(service: NonNullable<typeof s>, token: string, install: string) {
  const jwks = JSON.parse((await service.get('/jwks')).text);
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: SERVICE_URL, audience: install, typ: 'um-license+jwt' });
  return payload;
}

describe('the license service', () => {
  it('SUB-10 /jwks is the public signing key only', async () => {
    s = await startService();
    const r = await s.get('/jwks');
    expect(r.status).toBe(200);
    const jwks = JSON.parse(r.text);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0].kid).toBeTruthy();
    expect(jwks.keys[0].d).toBeUndefined();
    expect(r.text).not.toContain(s.signingKey.d!);
  });

  it('SUB-11 a purchase from the page: the webhook mints a code and binds the install; renew by install alone then works', async () => {
    s = await startService();
    const code = await paid(s, 'inst-1');
    expect(code).toMatch(CODE);
    const record = await s.store.get('licenses', code) as Record<string, unknown>;
    expect(record).toMatchObject({ code, subscriptionId: 'sub_01', status: 'active', plan: 'monthly', installs: ['inst-1'], portal: 'https://pay.example.invalid/manage/sub_01' });
    expect(record.paidThrough).toBe(new Date(s.clock.now() + 31 * DAY).toISOString());
    // The server renews with its install id, without a code to paste.
    const r = await s.post('/renew', { install: 'inst-1' });
    expect(r.status).toBe(200);
    const payload = await license(s, String(r.body.token), 'inst-1');
    expect(payload).toMatchObject({ sub: code, plan: 'monthly', portal: 'https://pay.example.invalid/manage/sub_01' });
    expect(payload.exp! * 1000).toBe(Date.parse(String(record.paidThrough)));
    expect(r.body.keys).toEqual(JSON.parse((await s.get('/jwks')).text));
  });

  it('SUB-10 activating with the code binds another install (a reinstall), up to the limit; beyond it, refused and nothing changed', async () => {
    s = await startService({ maxInstalls: 3 });
    const code = await paid(s, 'inst-1');
    for (const install of ['inst-2', 'inst-3']) {
      const r = await s.post('/activate', { code, install });
      expect(r.status, install).toBe(200);
      expect((await license(s, String(r.body.token), install)).sub).toBe(code);
    }
    // The same install again is fine (a restart, a retry).
    expect((await s.post('/activate', { code, install: 'inst-2' })).status).toBe(200);
    const fourth = await s.post('/activate', { code, install: 'inst-4' });
    expect(fourth.status).toBe(409);
    expect(fourth.body).toEqual({ error: 'too_many_installs' });
    expect((await s.store.get('licenses', code) as { installs: string[] }).installs).toEqual(['inst-1', 'inst-2', 'inst-3']);
    // Case and spacing don't matter to the person.
    expect((await s.post('/activate', { code: ` ${code.toLowerCase()} `, install: 'inst-2' })).status).toBe(200);
  });

  it('SUB-10 a code nobody has, an install nobody bound, or a request without either: 404 with the plain reason, nothing logged of the code', async () => {
    s = await startService();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await paid(s);
    expect(await s.post('/activate', { code: 'UM-ZZZZ-ZZZZ-ZZZZ', install: 'inst-9' })).toMatchObject({ status: 404, body: { error: 'unknown_code' } });
    expect(await s.post('/renew', { install: 'inst-9' })).toMatchObject({ status: 404, body: { error: 'unknown_install' } });
    expect(await s.post('/renew', {})).toMatchObject({ status: 400 });
    expect(await s.post('/activate', { code: 'not a code', install: 'inst-9' })).toMatchObject({ status: 404 });
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).not.toContain('UM-ZZZZ');
  });

  it('SUB-10/11 renewal follows the subscription: past due refuses at once; cancelled keeps what was paid for, then refuses; paid again resumes', async () => {
    s = await startService();
    const code = await paid(s);
    await s.webhook('subscription.past_due', s.subscription({ status: 'past_due' }));
    let r = await s.post('/renew', { code, install: 'inst-1' });
    expect(r.status).toBe(402);
    expect(r.body).toEqual({ error: 'not_paid', portal: 'https://pay.example.invalid/manage/sub_01' });
    // Paid again: a later period.
    await s.webhook('subscription.updated', s.subscription({ current_billing_period: { starts_at: new Date(s.clock.now()).toISOString(), ends_at: new Date(s.clock.now() + 62 * DAY).toISOString() } }));
    r = await s.post('/renew', { code, install: 'inst-1' });
    expect(r.status).toBe(200);
    expect((await license(s, String(r.body.token), 'inst-1')).exp! * 1000).toBe(s.clock.now() + 62 * DAY);
    // Cancelled: the token still runs to the end of what was paid for; after that, refused.
    await s.webhook('subscription.canceled', s.subscription({ status: 'canceled' }));
    expect((await s.post('/renew', { code, install: 'inst-1' })).status).toBe(200);
    s.clock.advance(63 * DAY);
    r = await s.post('/renew', { code, install: 'inst-1' });
    expect(r.status).toBe(402);
    expect((await s.post('/activate', { code, install: 'inst-2' })).status).toBe(402);
  });

  it('SUB-11 a yearly plan is a yearly license; a subscription without an install (bought elsewhere) waits for its code to be entered', async () => {
    s = await startService();
    await s.webhook('subscription.activated', s.subscription({ id: 'sub_02', items: [{ status: 'active', price: { id: 'pri_yearly', name: 'Yearly', billing_cycle: { interval: 'year', frequency: 1 } } }],
      current_billing_period: { starts_at: new Date(s.clock.now()).toISOString(), ends_at: new Date(s.clock.now() + 366 * DAY).toISOString() } }));
    const { code } = await s.store.get('subscriptions', 'sub_02') as { code: string };
    expect(await s.store.get('licenses', code)).toMatchObject({ plan: 'yearly', installs: [] });
    const r = await s.post('/activate', { code, install: 'inst-7' });
    expect((await license(s, String(r.body.token), 'inst-7')).plan).toBe('yearly');
  });

  it('SUB-11 a bad or stale signature, or none: refused, nothing changed; the same event twice changes nothing', async () => {
    s = await startService();
    const data = s.subscription({ custom_data: { install: 'inst-1' } });
    expect((await s.webhook('subscription.activated', data, { secret: 'someone-elses-secret' })).status).toBe(401);
    expect((await s.webhook('subscription.activated', data, { at: s.clock.now() - 10 * 60_000 })).status).toBe(401);
    expect((await s.post('/webhook/paddle', s.event('subscription.activated', data))).status).toBe(401);
    expect(await s.store.get('subscriptions', 'sub_01')).toBeUndefined();
    expect((await s.webhook('subscription.activated', data, { id: 'evt_same' })).status).toBe(200);
    const { code } = await s.store.get('subscriptions', 'sub_01') as { code: string };
    expect((await s.webhook('subscription.activated', data, { id: 'evt_same' })).status).toBe(200);
    expect((await s.store.get('subscriptions', 'sub_01') as { code: string }).code).toBe(code);
    // A replay of an old event (Paddle retries) never undoes a newer one.
    await s.webhook('subscription.updated', s.subscription({ current_billing_period: { starts_at: new Date(s.clock.now()).toISOString(), ends_at: new Date(s.clock.now() + 62 * DAY).toISOString() } }), { id: 'evt_newer' });
    expect((await s.webhook('subscription.activated', data, { id: 'evt_same' })).status).toBe(200);
    expect((await s.store.get('licenses', code) as { paidThrough: string }).paidThrough).toBe(new Date(s.clock.now() + 62 * DAY).toISOString());
    // An event kind we don't act on is acknowledged, so Paddle doesn't retry it.
    expect((await s.webhook('transaction.created', { id: 'txn_1' })).status).toBe(200);
  });

  it('SUB-11 the receipt page: after checkout, the code by the transaction; before the webhook arrives, "on its way"', async () => {
    s = await startService();
    let page = await s.get('/welcome?_ptxn=txn_9');
    expect(page.status).toBe(200);
    expect(page.text).toContain('on its way');
    await s.webhook('transaction.completed', { id: 'txn_9', status: 'completed', subscription_id: 'sub_01', customer_id: 'ctm_01' });
    page = await s.get('/welcome?_ptxn=txn_9');
    expect(page.text).toContain('on its way');
    await s.webhook('subscription.activated', s.subscription());
    const { code } = await s.store.get('subscriptions', 'sub_01') as { code: string };
    page = await s.get('/welcome?_ptxn=txn_9');
    expect(page.text).toContain(code);
    expect(page.text).toContain('Universal Mail page');
    // Whatever order the two events arrive in.
    await s.webhook('subscription.activated', s.subscription({ id: 'sub_03' }));
    await s.webhook('transaction.completed', { id: 'txn_10', status: 'completed', subscription_id: 'sub_03', customer_id: 'ctm_01' });
    expect((await s.get('/welcome?_ptxn=txn_10')).text).toContain((await s.store.get('subscriptions', 'sub_03') as { code: string }).code);
    expect((await s.get('/welcome?_ptxn=<script>')).text).not.toContain('<script>');
  });

  it('SUB-10 /buy opens the checkout with the install as custom data, escaped; the install is optional', async () => {
    s = await startService();
    const page = await s.get('/buy?install=inst-1');
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.text).toContain('test_client_token');
    expect(page.text).toContain('pri_monthly');
    expect(page.text).toContain('pri_yearly');
    expect(page.text).toContain('"install":"inst-1"');
    // An install id that isn't one is dropped, never written into the page.
    const odd = await s.get('/buy?install=inst-1%22%3E%3C/script%3E%3Cscript%3E');
    expect(odd.status).toBe(200);
    expect(odd.text).not.toContain('</script><script>');
    expect(odd.text).toContain('"install":""');
    expect((await s.get('/buy')).status).toBe(200);
  });

  it('SUB-10 activation is limited per address: the 31st try in an hour is refused, and an hour later it works again', async () => {
    s = await startService();
    const code = await paid(s);
    for (let i = 0; i < 30; i++) expect((await s.post('/activate', { code: 'UM-ZZZZ-ZZZZ-ZZZZ', install: 'xxxx' })).status).toBe(404);
    expect((await s.post('/activate', { code, install: 'inst-2' })).status).toBe(429);
    // Another address is unaffected.
    expect((await s.post('/activate', { code, install: 'inst-2' }, {}, '198.51.100.7')).status).toBe(200);
    s.clock.advance(60 * 60_000 + 1);
    expect((await s.post('/activate', { code, install: 'inst-2' })).status).toBe(200);
  });
});
