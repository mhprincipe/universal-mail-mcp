import { afterEach, describe, expect, it } from 'vitest';
import { createCanary, scanForCanaries } from '../../testkit/src/canary.js';
import { dashboard } from '../../src/page/views.js';
import { ReportSchema } from '../check/reportSchema.js';
import { startPage } from './pageHarness.js';

// Your page: health, what it never shows, and phone width (design §3.6).
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

const reportIn = (html: string) => {
  const text = /<textarea readonly[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];
  return text === undefined ? undefined : JSON.parse(text.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
};

describe('health on your page', () => {
  it('PG-09 Check runs the stages; the report shown for copying is the redacted report', async () => {
    p = await startPage();
    await p.signIn();
    const page = await p.act('/check', {});
    const report = reportIn(page.html);
    expect(() => ReportSchema.parse(report)).not.toThrow();
    expect(report.stages.map((s: { stage: string }) => s.stage)).toEqual(['server', 'signin', 'account:me', 'tools:me', 'live:me', 'sent:me', 'account:work', 'tools:work', 'live:work', 'sent:work']);
    // Nothing listens for these test accounts: reported as such, in plain words.
    expect(report.stages[2]).toMatchObject({ status: 'FAIL', code: 'MAIL-UNREACHABLE' });
    expect(page.html).toContain('It contains no mail and no secrets');
  });

  it('PG-09 an account the check finds refusing its password is shown as needing Fix it', async () => {
    p = await startPage();
    await p.signIn();
    // What the check found, as its stages report it.
    p.app.signin!.noteCheck({ stages: [{ stage: 'account:work', status: 'FAIL', code: 'MAIL-APP-PASSWORD-REJECTED' }, { stage: 'account:me', status: 'PASS' }] });
    const page = await p.get();
    expect(page.html).toMatch(/id="account-work">[\s\S]*?Password not accepted/);
    expect(page.html).toMatch(/id="account-me">[\s\S]*?class="ok">Working/);
  });

  it('PG-10 no page ever contains a password, token or email content (canary scan of every rendered page)', async () => {
    const passwords = { me: createCanary('me-password'), work: createCanary('work-password') };
    const tried = createCanary('typed-password');
    const newOne = createCanary('new-password');
    const subject = createCanary('email-subject');
    p = await startPage({ passwords, accepted: { 'me@example.invalid': newOne, 'work@example.invalid': passwords.work } });
    const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    p.app.signin!.grants.connect(claude, 'Claude', { me: ['read'] });
    await p.signIn();
    // Every kind of page: the dashboard, refusals, a fix, a check with its report, an app's permissions.
    await p.act('/accounts/add', { email: 'side@example.invalid', password: tried, name: 'side' });
    await p.act('/accounts/password', { name: 'me', password: tried });
    await p.act('/accounts/password', { name: 'me', password: newOne });
    await p.act('/check', {});
    await p.act('/apps/permissions', { app: claude, 'me:read': 'on' });
    await p.act('/accounts/sending', { name: 'work', on: 'off' });
    const signingKeyPart = (p.records.credentials.signingKey as { d: string }).d;
    const findings = scanForCanaries([passwords.me, passwords.work, tried, newOne, subject, signingKeyPart, p.records.credentials.encryptionKey], {
      html: p.pages, logs: p.logged().map(e => JSON.stringify(e))
    });
    expect(findings).toEqual([]);
    expect(p.pages.length).toBeGreaterThan(12);
  });

  it('PG-16 every page is laid out for a phone: the viewport is set and nothing is wider than the screen', async () => {
    p = await startPage();
    await p.signIn();
    await p.act('/check', {});
    const shown = [...p.pages, dashboard({ base: '/k', csrf: 'c', now: 0, canGrantSend: false, report: 'x'.repeat(5000),
      accounts: [{ name: 'a-very-long-account-name-for-a-phone', email: 'someone.with.a.very.long.address@an-extremely-long-domain-name.example', sending: true, sendLimits: { perHour: 30, perDay: 200 }, status: 'password' }],
      apps: [] })];
    for (const html of shown.filter(h => h.startsWith('<!doctype html>'))) {
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      // No fixed width in pixels anywhere; long words wrap; inputs fit their box.
      expect(html).not.toMatch(/width:\s*\d{3,}px/);
      expect(html).toContain('overflow-wrap:anywhere');
      expect(html).toContain('box-sizing:border-box');
    }
  });
});
