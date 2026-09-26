import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanary, scanForCanaries } from '../../testkit/src/canary.js';
import { callback, claude, key, startApproval } from './approvalHarness.js';

let a: Awaited<ReturnType<typeof startApproval>> | undefined;
afterEach(async () => { await a?.close(); a = undefined; vi.restoreAllMocks(); });

function captureLog() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return { lines, refusals: () => lines.map(l => JSON.parse(l)).filter(e => e.event === 'signin_refused') };
}

describe('refusals', () => {
  it('SIG-80 every refusal logs a reason code, and never a token or claim value', async () => {
    const log = captureLog();
    a = await startApproval();
    const token = createCanary('token');
    const code = createCanary('code');
    const verifier = createCanary('verifier');
    const state = createCanary('state');

    await fetch(`${a.base}/${key}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    await fetch(`${a.base}/${key}/mcp`, { method: 'POST' });
    await fetch(`${a.base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback, client_id: claude, code_verifier: verifier }) });
    await fetch(`${a.base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: claude }) });
    await fetch(`${a.base}/authorize?${new URLSearchParams({ client_id: 'https://evil.example/app.json', redirect_uri: 'https://evil.example/cb', state })}`, { redirect: 'manual' });
    await a.open({ state });
    await a.post('/authorize/code', { csrf: token });

    expect(log.refusals().map(r => r.reason)).toEqual(['token_invalid', 'token_missing', 'invalid_grant', 'invalid_grant', 'untrusted_origin', 'csrf']);
    for (const refusal of log.refusals()) expect(Object.keys(refusal).sort()).toEqual(['app', 'event', 'reason']);
    expect(scanForCanaries([token, code, verifier, state], { logs: log.lines })).toEqual([]);
  });

  it('SIG-81 refusals are counted per app', async () => {
    captureLog();
    a = await startApproval();
    for (let i = 0; i < 2; i++) {
      await fetch(`${a.base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'not-a-token', client_id: claude }) });
    }
    await fetch(`${a.base}/authorize?${new URLSearchParams({ client_id: 'https://evil.example/app.json', redirect_uri: 'https://evil.example/cb' })}`, { redirect: 'manual' });
    expect(a.app.signin.refusals()).toEqual({
      [claude]: { invalid_grant: 2 },
      'https://evil.example/app.json': { untrusted_origin: 1 }
    });
  });
});
