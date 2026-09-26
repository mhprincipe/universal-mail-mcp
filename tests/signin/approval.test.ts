import { afterEach, describe, expect, it } from 'vitest';
import { callback, claude, issuer, startApproval } from './approvalHarness.js';

let a: Awaited<ReturnType<typeof startApproval>> | undefined;
afterEach(async () => { await a?.close(); a = undefined; });

describe('the approval page', () => {
  it('SIG-70 the page refuses to be framed by another site', async () => {
    a = await startApproval();
    const first = await a.open();
    const code = await a.post('/authorize/code', { csrf: a.csrfIn(first.html) });
    for (const { response } of [first, code]) {
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });

  it('SIG-71 a missing or wrong CSRF token is refused', async () => {
    a = await startApproval();
    const first = await a.open();
    const csrf = a.csrfIn(first.html);
    expect(csrf.length).toBeGreaterThan(20);
    expect((await a.post('/authorize/code', {})).response.status).toBe(403);
    expect((await a.post('/authorize/code', { csrf: 'x'.repeat(csrf.length) })).response.status).toBe(403);
    expect((await a.post('/authorize/code', { csrf }, { withCookie: false })).response.status).toBe(403);
    expect(a.sent).toEqual([]);
    expect((await a.post('/authorize/code', { csrf })).response.status).toBe(200);
    expect(a.sent).toHaveLength(1);
  });

  it('SIG-72 responses aren\'t cached', async () => {
    a = await startApproval();
    const first = await a.open();
    const code = await a.post('/authorize/code', { csrf: a.csrfIn(first.html) });
    const token = await fetch(`${a.base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }) });
    for (const response of [first.response, code.response, token]) expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('SIG-73 nothing the app supplies is shown except its escaped name and verified origin', async () => {
    a = await startApproval('<script>alert(1)</script>Evil & Co');
    const { html } = await a.open({ state: '"><img src=x onerror=alert(2)>', login_hint: '<b>boss@bank.example</b>' });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Evil &amp; Co');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('boss@bank.example');
    expect(html).not.toContain('auth_callback');
    expect(html).toContain('claude.ai');
  });

  it('SIG-74 Send is unticked by default (and needs a fingerprint)', async () => {
    a = await startApproval();
    let page = await a.open();
    page = await a.post('/authorize/code', { csrf: a.csrfIn(page.html) });
    page = await a.post('/authorize/verify', { csrf: a.csrfIn(page.html), code: a.codeIn() });
    const input = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(page.html)?.[0] ?? '';
    expect(input('personal:read')).toContain('checked');
    expect(input('personal:send')).not.toContain('checked');
    expect(input('personal:send')).toContain('disabled');
  });

  it('SIG-75 addresses are masked before sign-in', async () => {
    a = await startApproval();
    const { html } = await a.open();
    expect(html).toContain('p•••@e•••.invalid');
    expect(html).not.toContain('personal@example.invalid');
    expect(html).not.toContain('work@example.invalid');
  });

  it('SIG-76 approving sends a "connected" email; disconnecting sends a "disconnected" email', async () => {
    a = await startApproval();
    const approved = await a.approve({ 'personal:read': 'on', 'work:read': 'on', 'work:organize': 'on' });
    expect(approved.response.status).toBe(302);
    const location = new URL(approved.response.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(callback);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ state: 'st-1', iss: issuer });
    expect(a.app.signin.grants.get(claude)?.accounts).toEqual({ personal: ['read'], work: ['read', 'organize'] });

    const connected = a.sent.at(-1)!;
    expect(connected).toMatchObject({ to: 'personal@example.invalid' });
    expect(connected.subject).toMatch(/connected/i);
    expect(connected.text).toContain('Claude');
    // The code email, once used, is filed away.
    expect(a.discarded).toHaveLength(1);

    await a.app.signin.disconnect(claude);
    expect(a.app.signin.grants.get(claude)).toBeUndefined();
    expect(a.sent.at(-1)!.subject).toMatch(/disconnected/i);
  });
});
