import { createHash, randomBytes, type JsonWebKey } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { SignJWT, exportJWK, importJWK, type CryptoKey, type JWK } from 'jose';
import { escape } from '../signin/pages.js';
import { LICENSE_TOKEN_TYPE } from '../subscription/state.js';
import { readSubscription, verifyPaddleSignature } from './paddle.js';
import type { LicenseStore } from './store.js';

// The license service (design §13.3): the only thing we run. It mints codes
// when the merchant says someone paid, binds installs to them, and signs
// licenses the person's own server verifies. Codes are logged only as {code}.

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_SHAPE = /^UM-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;
const DEFAULT_MAX_INSTALLS = 3;
const TRIES_PER_ADDRESS_PER_HOUR = 30;
const HOUR = 60 * 60_000;

export type LicenseRecord = {
  code: string; subscriptionId: string; status: string; paidThrough: string; plan: string; portal?: string; installs: string[]; createdAt: string;
};

export type LicenseAppDeps = {
  store: LicenseStore;
  signingKey: JsonWebKey;
  serviceUrl: string;
  clock: { now(): number };
  paddleWebhookSecret: string;
  checkout: { clientToken: string; monthlyPriceId: string; yearlyPriceId: string };
  maxInstalls?: number;
};

export function mintCode(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map(b => CODE_ALPHABET[b % 32]!).join('');
  return `UM-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function createLicenseApp(deps: LicenseAppDeps) {
  const { store, clock } = deps;
  const maxInstalls = deps.maxInstalls ?? DEFAULT_MAX_INSTALLS;
  const service = deps.serviceUrl.replace(/\/$/, '');
  const { d: _private, ...publicJwk } = deps.signingKey;
  const kid = createHash('sha256').update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y })).digest('base64url').slice(0, 16);
  const jwks = { keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' } as JWK] };
  let privateKey: CryptoKey | undefined;
  const sign = async (record: LicenseRecord, install: string) => {
    privateKey ??= await importJWK(deps.signingKey as JWK, 'ES256') as CryptoKey;
    return new SignJWT({ plan: record.plan, ...(record.portal ? { portal: record.portal } : {}) })
      .setProtectedHeader({ alg: 'ES256', kid, typ: LICENSE_TOKEN_TYPE })
      .setIssuer(service).setSubject(record.code).setAudience(install)
      .setIssuedAt(Math.floor(clock.now() / 1000)).setExpirationTime(Math.floor(Date.parse(record.paidThrough) / 1000))
      .sign(privateKey);
  };
  const log = (event: string, detail: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...detail }));

  // Activation tries per address, per hour: a code can't be guessed at speed.
  const tries = new Map<string, number[]>();
  const limited = (address: string) => {
    const now = clock.now();
    const recent = (tries.get(address) ?? []).filter(t => now - t < HOUR);
    tries.set(address, [...recent, now]);
    return recent.length >= TRIES_PER_ADDRESS_PER_HOUR;
  };

  const license = async (code: string) => (await store.get('licenses', code)) as LicenseRecord | undefined;
  const paid = (record: LicenseRecord) => {
    if (record.status === 'past_due' || record.status === 'paused') return false;
    return Date.parse(record.paidThrough) > clock.now();
  };
  // A license for this install: the record, with the install bound.
  const issue = async (res: Response, record: LicenseRecord, install: string) => {
    if (!paid(record)) return res.status(402).json({ error: 'not_paid', ...(record.portal ? { portal: record.portal } : {}) });
    if (!record.installs.includes(install)) {
      if (record.installs.length >= maxInstalls) return res.status(409).json({ error: 'too_many_installs' });
      record.installs = [...record.installs, install];
      await store.put('licenses', record.code, record);
      await store.put('installs', install, { code: record.code });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token: await sign(record, install), keys: jwks });
  };

  const app = express();
  app.set('trust proxy', 1);
  const json = express.json({ limit: '4kb' });
  const address = (req: Request) => req.ip ?? 'unknown';
  const installOf = (req: Request) => typeof req.body?.install === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(req.body.install) ? req.body.install as string : undefined;

  app.get('/jwks', (_req, res) => res.json(jwks));

  // From the page: the code on the receipt, and this install.
  app.post('/activate', json, async (req, res) => {
    const install = installOf(req);
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    if (!install) return res.status(400).json({ error: 'install_required' });
    if (limited(address(req))) return res.status(429).json({ error: 'too_many_tries' });
    const record = CODE_SHAPE.test(code) ? await license(code) : undefined;
    if (!record) { log('license_unknown_code'); return res.status(404).json({ error: 'unknown_code' }); }
    log('license_activated', { plan: record.plan, installs: record.installs.length + 1 });
    await issue(res, record, install);
  });

  // From the server, daily: by the code it has, or by its install alone
  // (bought from the page, the install came with the purchase).
  app.post('/renew', json, async (req, res) => {
    const install = installOf(req);
    if (!install) return res.status(400).json({ error: 'install_required' });
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : undefined;
    let record = code && CODE_SHAPE.test(code) ? await license(code) : undefined;
    if (!record && !code) {
      const bound = await store.get('installs', install) as { code?: string } | undefined;
      record = bound?.code ? await license(bound.code) : undefined;
      if (!record) return res.status(404).json({ error: 'unknown_install' });
    }
    if (!record) return res.status(404).json({ error: 'unknown_code' });
    await issue(res, record, install);
  });

  // Paddle's events: signed with our endpoint's secret; each acted on once.
  app.post('/webhook/paddle', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifyPaddleSignature(req.header('paddle-signature'), raw, deps.paddleWebhookSecret, clock.now())) {
      log('webhook_refused', { reason: 'signature' });
      return res.status(401).json({ error: 'unauthorized' });
    }
    let event: { event_id?: unknown; event_type?: unknown; data?: unknown };
    try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'not_json' }); }
    const id = typeof event.event_id === 'string' ? event.event_id : undefined;
    const type = typeof event.event_type === 'string' ? event.event_type : '';
    if (id && await store.get('events', id)) return res.json({ ok: true, seen: true });

    if (type === 'transaction.completed') {
      const data = event.data as { id?: unknown; subscription_id?: unknown } | undefined;
      if (typeof data?.id === 'string' && typeof data.subscription_id === 'string') await store.put('transactions', data.id, { subscriptionId: data.subscription_id });
    } else if (type.startsWith('subscription.')) {
      const sub = readSubscription(event.data);
      if (sub) {
        const known = await store.get('subscriptions', sub.id) as { code?: string } | undefined;
        let record = known?.code ? await license(known.code) : undefined;
        if (!record) {
          let code = mintCode();
          while (await license(code)) code = mintCode();
          record = { code, subscriptionId: sub.id, status: sub.status, paidThrough: sub.paidThrough ?? new Date(clock.now()).toISOString(), plan: sub.plan, installs: [], createdAt: new Date(clock.now()).toISOString() };
          await store.put('subscriptions', sub.id, { code });
        }
        record.status = sub.status;
        if (sub.paidThrough) record.paidThrough = sub.paidThrough;
        record.plan = sub.plan;
        if (sub.portal) record.portal = sub.portal;
        if (sub.install && !record.installs.includes(sub.install) && record.installs.length < maxInstalls) {
          record.installs = [...record.installs, sub.install];
          await store.put('installs', sub.install, { code: record.code });
        }
        await store.put('licenses', record.code, record);
        log('subscription_event', { type, status: sub.status, plan: sub.plan });
      }
    }
    if (id) await store.put('events', id, { at: new Date(clock.now()).toISOString(), type });
    res.json({ ok: true });
  });

  // The receipt page after checkout: the code, once the merchant has told us.
  app.get('/welcome', async (req, res) => {
    const txn = typeof req.query._ptxn === 'string' ? req.query._ptxn : '';
    const transaction = txn ? await store.get('transactions', txn) as { subscriptionId?: string } | undefined : undefined;
    const subscription = transaction?.subscriptionId ? await store.get('subscriptions', transaction.subscriptionId) as { code?: string } | undefined : undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(page('Thank you', subscription?.code
      ? `<h1>Thank you</h1><p>Your license code:</p><p class="code">${escape(subscription.code)}</p>
<p>On your Universal Mail page, open <strong>Subscription</strong> and paste it. If you bought from that page, it's already active there: nothing to paste.</p>
<p>Keep this code: a reinstall needs it.</p>`
      : '<h1>Thank you</h1><p>Your license code is on its way. Refresh this page in a minute.</p><p>If you bought from your Universal Mail page, it will show "Paid through" by itself within a day.</p>'));
  });

  // The checkout, with the install id along, so the purchase binds itself.
  app.get('/buy', (req, res) => {
    const install = typeof req.query.install === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(req.query.install) ? req.query.install : '';
    const settings = JSON.stringify({ token: deps.checkout.clientToken, monthly: deps.checkout.monthlyPriceId, yearly: deps.checkout.yearlyPriceId, install, success: `${service}/welcome` });
    res.type('html').send(page('Universal Mail', `<h1>Universal Mail</h1>
<p>$4 a month or $36 a year, for any number of email accounts. Cancel any time.</p>
<p><button id="monthly">$4 a month</button> <button id="yearly">$36 a year</button></p>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script id="settings" type="application/json">${settings.replace(/</g, '\\u003c')}</script>
<script>${CHECKOUT_SCRIPT}</script>`));
  });

  app.use((_req: Request, res: Response) => { res.status(404).json({ error: 'not_found' }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const status = (error as { status?: number })?.status;
    log('license_service_error', { status: status ?? 500 });
    res.status(status === 400 || status === 413 ? status : 500).json({ error: 'Request could not be processed.' });
  });
  return app;
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}.code{font-family:ui-monospace,monospace;font-size:1.4rem}button{font-size:1rem;padding:.6rem 1rem}</style></head><body><main>${body}</main></body></html>`;

const CHECKOUT_SCRIPT = `(() => {
  const s = JSON.parse(document.getElementById('settings').textContent);
  if (!window.Paddle) return;
  Paddle.Initialize({ token: s.token });
  const open = priceId => Paddle.Checkout.open({ items: [{ priceId, quantity: 1 }], customData: s.install ? { install: s.install } : {}, settings: { successUrl: s.success + '?_ptxn={transaction_id}' } });
  document.getElementById('monthly').addEventListener('click', () => open(s.monthly));
  document.getElementById('yearly').addEventListener('click', () => open(s.yearly));
})();`;
