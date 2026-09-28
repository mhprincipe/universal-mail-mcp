import { afterEach, describe, expect, it } from 'vitest';
import { GRACE_DAYS } from '../../src/subscription/state.js';
import { DAY, startService } from '../licenseService/harness.js';
import { startPage } from '../page/pageHarness.js';

// SUB-14 (design §13): the whole loop, with the real license service behind
// the page: a purchase from the page binds the install by itself; the server
// renews; the card fails; grace; read-only; paid again; active.
let s: Awaited<ReturnType<typeof startService>> | undefined;
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; await s?.close(); s = undefined; });

const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const INSTALLED = '2026-09-25T10:00:00.000Z';
const t0 = Date.parse(INSTALLED);

async function tool(page: NonNullable<typeof p>, connection: number, name: string, args: Record<string, unknown>) {
  const r = await page.mcp(claude, connection, 'tools/call', { name, arguments: args });
  const line = r.body.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? r.body;
  return JSON.parse(JSON.parse(line.trim()).result.content[0].text) as { ok: boolean; code: string };
}

describe('the subscription, end to end', () => {
  it('SUB-14 bought from the page, the server needs no code: it binds and renews by its install; a lapse goes read-only; paying again brings it back', async () => {
    s = await startService({ start: new Date(t0) });
    const service = s;
    p = await startPage({ start: new Date(t0 + 2 * 60 * 60_000), service: async (path, body) => {
      const r = await fetch(`${service.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    } });
    // The page's buy link carries the install id, and the purchase comes back with it.
    const html = (await p.signIn()).html;
    await p.app.signin!.saved();
    const install = JSON.parse(p.saves.state.at(-1)!).installId as string;
    expect(html).toContain('Free trial');
    expect(typeof install).toBe('string');
    expect(html).toContain(`/buy?install=${install}`);
    await s.webhook('subscription.activated', s.subscription({ custom_data: { install } }));
    // The next day the server renews by install alone: paid.
    p.clock.advance(DAY + 60_000); s.clock.advance(DAY + 60_000);
    await p.get();
    // Asked once when first shown (nothing bound yet), and again the next day.
    expect(p.serviceCalls.map(c => c.path)).toEqual(['/renew', '/renew']);
    expect(p.serviceCalls[1]!.body).toEqual({ install });
    expect((await p.signIn()).html).toContain('Paid through');
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize', 'send'] });
    expect((await tool(p, grant.connection, 'move_email', { account: 'me', mailbox: 'INBOX', uid: 1, destination: 'Archive' })).code).not.toBe('SUBSCRIPTION-READ-ONLY');

    // The card fails: past due at the merchant; the server hears at its next renewal.
    await s.webhook('subscription.past_due', s.subscription({ status: 'past_due' }));
    p.clock.advance(DAY + 60_000); s.clock.advance(DAY + 60_000);
    await p.get();
    expect(p.sent.map(m => m.subject).filter(x => !/code/.test(x))).toEqual(['Your Universal Mail subscription couldn\'t be renewed']);
    // Paid through day 31 from the purchase; grace to day 45; read-only after.
    p.clock.advance((31 + GRACE_DAYS) * DAY); s.clock.advance((31 + GRACE_DAYS) * DAY);
    await p.get();
    expect((await tool(p, grant.connection, 'move_email', { account: 'me', mailbox: 'INBOX', uid: 1, destination: 'Archive' })).code).toBe('SUBSCRIPTION-READ-ONLY');
    expect(p.sent.map(m => m.subject).filter(x => !/code/.test(x))).toContain('Universal Mail is now read-only');

    // Paid again at the merchant: the next renewal brings it back, and organizing works at once.
    await s.webhook('subscription.updated', s.subscription({ status: 'active', current_billing_period: { starts_at: new Date(s.clock.now()).toISOString(), ends_at: new Date(s.clock.now() + 31 * DAY).toISOString() } }));
    p.clock.advance(DAY + 60_000); s.clock.advance(DAY + 60_000);
    await p.get();
    expect((await tool(p, grant.connection, 'move_email', { account: 'me', mailbox: 'INBOX', uid: 1, destination: 'Archive' })).code).not.toBe('SUBSCRIPTION-READ-ONLY');
    expect((await p.signIn()).html).toContain('Paid through');
    // A reinstall: the receipt's code on the new server's page binds it too.
    const { code } = await s.store.get('subscriptions', 'sub_01') as { code: string };
    const fresh = await startPage({ start: new Date(p.clock.now()), service: async (path, body) => {
      const r = await fetch(`${service.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    } });
    await fresh.signIn();
    expect((await fresh.act('/subscription/activate', { code })).html).toContain('Paid through');
    await fresh.close();
  }, 60_000);
});
