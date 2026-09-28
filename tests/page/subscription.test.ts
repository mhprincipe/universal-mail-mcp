import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { GRACE_DAYS, TRIAL_DAYS } from '../../src/subscription/state.js';
import { ReportSchema } from '../check/reportSchema.js';
import { KEY, PUBLIC_URL, SERVICE_URL, startPage, type ServiceAnswer } from './pageHarness.js';

// SUB-04 to SUB-09 (design §13): the subscription on the installed server:
// the page's Subscription section, activation, renewal, the emails, read-only
// in the tools, the report's facts; and no service address means no gate.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

const DAY = 24 * 60 * 60_000;
const INSTALLED = '2026-09-25T10:00:00.000Z';
const t0 = Date.parse(INSTALLED);
const day = (n: number) => new Date(t0 + n * DAY + 2 * 60 * 60_000);
// Codes use A-Z and 2-7 (no 0/O or 1/I to mistake), as the service mints them.
const CODE = 'UM-K7Q2-F6XM-3B5T';
const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const last = (list: string[]) => JSON.parse(list.at(-1)!);

// A license service that signs what it's told to: paid through `until`.
async function service() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const keys = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] as JWK[] };
  const token = (install: string, until: number, code = CODE) => new SignJWT({ plan: 'monthly', portal: 'https://pay.example.invalid/manage' })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'um-license+jwt' }).setIssuer(SERVICE_URL).setSubject(code).setAudience(install)
    .setIssuedAt(Math.floor(until / 1000) - 60).setExpirationTime(Math.floor(until / 1000)).sign(privateKey);
  let paidThrough = t0 + 60 * DAY;
  let answer: 'paid' | 'not_paid' | 'down' | 'wrong-install' = 'paid';
  const handle = async (path: string, body: Record<string, unknown>): Promise<ServiceAnswer> => {
    if (answer === 'down') throw new TypeError('fetch failed');
    if (path !== '/activate' && path !== '/renew') return { status: 404, body: { error: 'not_found' } };
    if (body.code !== CODE) return { status: 404, body: { error: 'unknown_code' } };
    if (answer === 'not_paid') return { status: 402, body: { error: 'not_paid', portal: 'https://pay.example.invalid/manage' } };
    // A token for someone else's install: an answer the server must not take.
    return { status: 200, body: { token: await token(answer === 'wrong-install' ? 'someone-else' : String(body.install), paidThrough), keys } };
  };
  return { handle, keys, token, set: (a: typeof answer) => { answer = a; }, paidThrough: (ms: number) => { paidThrough = ms; } };
}

// A tool call as an AI app makes it; the envelope from the answer (JSON or event stream).
async function tool(page: NonNullable<typeof p>, connection: number, name: string, args: Record<string, unknown>) {
  const r = await page.mcp(claude, connection, 'tools/call', { name, arguments: args });
  const line = r.body.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? r.body;
  const rpc = JSON.parse(line.trim());
  return JSON.parse(rpc.result.content[0].text) as { ok: boolean; code: string; message: string };
}

describe('the subscription on your page', () => {
  it('SUB-04 a fresh install shows the trial with its days left, and the link to buy; activating saves the license and says "Paid through"', async () => {
    const s = await service();
    p = await startPage({ service: s.handle, start: day(0) });
    await p.signIn();
    let page = await p.get();
    expect(page.html).toContain(`Free trial: ${TRIAL_DAYS} days left`);
    expect(page.html).toContain(`${SERVICE_URL}/buy`);
    expect(page.html).toContain('name="code"');
    // The daily "is this install bound?" was asked once; not again the same day.
    expect(p.serviceCalls.map(c => c.path)).toEqual(['/renew']);
    p.clock.advance(3 * 60 * 60_000);
    await p.get();
    expect(p.serviceCalls).toHaveLength(1);
    // (The page session has expired meanwhile: sign in again.)
    await p.signIn();

    page = await p.act('/subscription/activate', { code: ` ${CODE.toLowerCase()} ` });
    expect(page.html).toContain('Paid through 24 November 2026');
    expect(page.html).toContain('https://pay.example.invalid/manage');
    expect(page.html).not.toContain('Free trial');
    // What the service was sent: first the daily "is this install bound?" (no code
    // yet), then the activation with the code and this install's id; never the key.
    expect(p.serviceCalls.map(c => c.path)).toEqual(['/renew', '/activate']);
    expect(Object.keys(p.serviceCalls[0]!.body)).toEqual(['install']);
    const activation = p.serviceCalls[1]!;
    expect(activation.body.code).toBe(CODE);
    expect(String(activation.body.install)).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(p.serviceCalls[0]!.body.install).toBe(activation.body.install);
    expect(JSON.stringify(p.serviceCalls)).not.toContain(KEY);
    // Saved: the install id, the license and the service's keys; nothing secret about the person.
    await p.app.signin!.saved();
    const saved = last(p.saves.state);
    expect(saved.installId).toBe(activation.body.install);
    expect(saved.license).toMatchObject({ code: CODE, keys: s.keys });
    expect(typeof saved.license.token).toBe('string');
    // Restarted with what was saved, later the same day: still paid, no call needed (renewal is daily).
    await p.close();
    p = await startPage({ service: s.handle, state: saved, start: new Date(t0 + 12 * 60 * 60_000) });
    await p.signIn();
    expect((await p.get()).html).toContain('Paid through 24 November 2026');
    expect(p.serviceCalls).toHaveLength(0);
  });

  it('SUB-05 a wrong code, a code in the wrong shape, or the service unreachable: said plainly, nothing saved', async () => {
    const s = await service();
    p = await startPage({ service: s.handle, start: day(0) });
    await p.signIn();
    const before = p.saves.state.length;
    expect((await p.act('/subscription/activate', { code: 'UM-ZZZZ-ZZZZ-ZZZZ' })).html).toContain('That code wasn&#39;t recognised');
    expect((await p.act('/subscription/activate', { code: 'hello' })).html).toContain('doesn&#39;t look like a license code');
    s.set('down');
    expect((await p.act('/subscription/activate', { code: CODE })).html).toContain('Couldn&#39;t reach the subscription service');
    s.set('not_paid');
    expect((await p.act('/subscription/activate', { code: CODE })).html).toContain('isn&#39;t paid up');
    s.set('wrong-install');
    expect((await p.act('/subscription/activate', { code: CODE })).html).toContain('couldn&#39;t be verified');
    await p.app.signin!.saved();
    expect(last(p.saves.state).license ?? undefined).toBeUndefined();
    // Nothing saved by any of them (the install id was saved when the page was first shown).
    expect(p.saves.state.length).toBe(before);
    expect((await p.get()).html).toContain('Free trial');
  });

  it('SUB-06 renewal, daily: a fresh token moves the paid-through date; a refusal is emailed once; an outage changes nothing', async () => {
    const s = await service();
    p = await startPage({ service: s.handle, start: day(0) });
    await p.signIn();
    await p.act('/subscription/activate', { code: CODE });
    expect(p.serviceCalls.map(c => c.path)).toEqual(['/renew', '/activate']);
    // The same day: no renewal asked for.
    await p.get();
    expect(p.serviceCalls).toHaveLength(2);
    // A day later, with a later paid-through date at the service: renewed with the code.
    s.paidThrough(t0 + 90 * DAY);
    p.clock.advance(DAY + 60_000);
    await p.get();
    expect(p.serviceCalls.map(c => c.path)).toEqual(['/renew', '/activate', '/renew']);
    expect(p.serviceCalls[2]!.body.code).toBe(CODE);
    // The page session has long expired: sign in again to look.
    expect((await p.signIn()).html).toContain('Paid through 24 December 2026');
    // The service refusing (card failed, cancelled): one email, the license kept as it was.
    s.set('not_paid');
    p.clock.advance(DAY + 60_000);
    await p.get();
    await p.get();
    const refused = p.sent.filter(m => /couldn't be renewed/.test(m.subject));
    expect(refused).toHaveLength(1);
    expect(refused[0]!.text).toContain('https://pay.example.invalid/manage');
    expect((await p.signIn()).html).toContain('Paid through 24 December 2026');
    // An outage: nothing asked of anyone, nothing changed.
    s.set('down');
    p.clock.advance(DAY + 60_000);
    await p.get();
    expect(p.sent.filter(m => /couldn't be renewed/.test(m.subject))).toHaveLength(1);
    expect((await p.signIn()).html).toContain('Paid through 24 December 2026');
  });

  it('SUB-07 the emails: trial ending, trial ended, then read-only, each once, surviving a restart; none while paid', async () => {
    const s = await service();
    p = await startPage({ service: s.handle, start: day(22) });
    await p.get();
    expect(p.sent).toHaveLength(0);
    p.clock.advance(DAY);
    await p.get();
    await p.get();
    let mails = p.sent.filter(m => /trial/i.test(m.subject));
    expect(mails.map(m => m.subject)).toEqual(['Your Universal Mail trial ends in 7 days']);
    expect(mails[0]!.text).toContain(`${SERVICE_URL}/buy`);
    expect(mails[0]!.text).toContain(`${PUBLIC_URL}/${KEY}`);
    // Restarted in the same phase: not sent again; the next one comes at day 30.
    await p.app.signin!.saved();
    const saved = last(p.saves.state);
    await p.close();
    p = await startPage({ service: s.handle, state: saved, start: day(24) });
    await p.get();
    await p.get();
    expect(p.sent.filter(m => /trial/i.test(m.subject))).toHaveLength(0);
    await p.close();
    p = await startPage({ service: s.handle, state: saved, start: day(TRIAL_DAYS) });
    await p.get();
    await p.get();
    mails = p.sent.filter(m => /trial/i.test(m.subject));
    expect(mails.map(m => m.subject)).toEqual(['Your Universal Mail trial has ended']);
    expect(mails[0]!.text).toContain(`${GRACE_DAYS} more days`);
    expect((await p.signIn()).html).toContain('Your trial has ended');
    p.clock.advance(GRACE_DAYS * DAY);
    await p.get();
    await p.get();
    expect(p.sent.map(m => m.subject).filter(s => !/code/.test(s))).toEqual(['Your Universal Mail trial has ended', 'Universal Mail is now read-only']);
    expect((await p.signIn()).html).toContain('read-only');
  });

  it('SUB-07 with a paid subscription, none of the trial emails; a lapse after paying gets its own', async () => {
    const s = await service();
    s.paidThrough(t0 + 40 * DAY);
    p = await startPage({ service: s.handle, start: day(0) });
    await p.signIn();
    await p.act('/subscription/activate', { code: CODE });
    for (const n of [23, 30, 44]) { p.clock.advance((n - (n === 23 ? 0 : n === 30 ? 23 : 30)) * DAY); await p.get(); await p.get(); }
    expect(p.sent.filter(m => /trial/i.test(m.subject))).toHaveLength(0);
    // Paid through day 40, the service now refusing: grace from day 40, read-only from day 54.
    s.set('not_paid');
    p.clock.advance(11 * DAY);
    await p.get();
    await p.get();
    expect(p.sent.map(m => m.subject).filter(s => !/code/.test(s))).toEqual(['Your Universal Mail subscription couldn\'t be renewed', 'Universal Mail is now read-only']);
  });

  it('SUB-03/08 read-only in the tools: organizing is refused with the sentence; reading goes through; the report says the state', async () => {
    const s = await service();
    p = await startPage({ service: s.handle, start: day(TRIAL_DAYS + GRACE_DAYS) });
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize', 'send'] });
    const move = await tool(p, grant.connection, 'move_email', { account: 'me', mailbox: 'INBOX', uid: 1, destination: 'Archive' });
    expect(move).toMatchObject({ ok: false, code: 'SUBSCRIPTION-READ-ONLY' });
    expect(move.message).toContain(`${PUBLIC_URL}/${KEY}`);
    const search = await tool(p, grant.connection, 'search_email', { account: 'me', limit: 1 });
    expect(search.code).not.toBe('SUBSCRIPTION-READ-ONLY');
    await p.signIn();
    const report = JSON.parse(/<textarea readonly>([\s\S]*?)<\/textarea>/.exec((await p.act('/check', {})).html)![1]!.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&'));
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report.facts.subscription).toEqual({ state: 'read-only' });
    // Subscribing now: the very next call works again.
    await p.act('/subscription/activate', { code: CODE });
    expect((await tool(p, grant.connection, 'move_email', { account: 'me', mailbox: 'INBOX', uid: 1, destination: 'Archive' })).code).not.toBe('SUBSCRIPTION-READ-ONLY');
  });

  it('SUB-09 without a service address (a build from source), there is no Subscription section, no emails, and nothing is ever refused', async () => {
    p = await startPage({ start: day(400) });
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize', 'send'] });
    expect((await tool(p, grant.connection, 'move_email', { account: 'me', mailbox: 'INBOX', uid: 1, destination: 'Archive' })).code).not.toBe('SUBSCRIPTION-READ-ONLY');
    await p.get();
    expect(p.sent).toHaveLength(0);
    expect((await p.signIn()).html).not.toContain('Subscription');
  });
});
