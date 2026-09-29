import { afterEach, describe, expect, it } from 'vitest';
import { createCanary } from '../../testkit/src/canary.js';
import { startPage } from './pageHarness.js';

// DIA-12 (added: for the owner's live performance test, 2026-09-28): every
// tool call leaves one line in the server's log: the tool, how long it took,
// whether it worked and, if not, its code. Never its arguments or its answer,
// which can hold mail.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

const claude = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

async function call(page: NonNullable<typeof p>, connection: number, name: string, args: Record<string, unknown>) {
  const r = await page.mcp(claude, connection, 'tools/call', { name, arguments: args });
  const line = r.body.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? r.body;
  return JSON.parse(JSON.parse(line.trim()).result.content[0].text) as { ok: boolean; code: string };
}

describe('the tool log', () => {
  it('DIA-12 each call: one line with the tool, its time, its outcome and code; never what was asked or answered', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize', 'send'] });
    const folder = createCanary('folder-name');
    // Nothing listens for the test account, so the mail call fails; the log says so, by code.
    const outcome = await call(p, grant.connection, 'search_email', { account: 'me', mailbox: folder, text: createCanary('search-text'), limit: 1 });
    expect(outcome.ok).toBe(false);
    const tools = p.logged().filter(e => e.event === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ event: 'tool', name: 'search_email', account: 'me', ok: false, code: outcome.code });
    expect(typeof tools[0]!.ms).toBe('number');
    const text = JSON.stringify(p.logged());
    expect(text).not.toContain(folder);
    expect(text).not.toContain('search-text');
    // A refusal that never reaches the mail server is logged the same way.
    await call(p, grant.connection, 'move_email', { mailbox: 'INBOX', uid: 1, destination: 'x', destinationAccount: 'work' });
    const refused = p.logged().filter(e => e.event === 'tool').at(-1)!;
    expect(refused).toMatchObject({ name: 'move_email', ok: false });
    expect(typeof refused.code).toBe('string');
  });

  it('DIA-13 the line also says where the time went, by step name only (added: the fourth live run)', async () => {
    p = await startPage();
    const grant = p.app.signin!.grants.connect(claude, 'Claude', { me: ['read', 'organize', 'send'] });
    const folder = createCanary('folder-name');
    await call(p, grant.connection, 'search_email', { account: 'me', mailbox: folder, limit: 1 });
    const line = p.logged().filter(e => e.event === 'tool').at(-1)!;
    // Nothing listens for the test account: the time went on trying to connect.
    expect(line.phases['imap.connect']).toMatchObject({ n: expect.any(Number), ms: expect.any(Number) });
    expect(line.phases['imap.connect'].n).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(line.phases)).not.toContain(folder);
    // Every line has a breakdown, a refused call's too.
    await call(p, grant.connection, 'move_email', { mailbox: 'INBOX', uid: 1, destination: 'x', destinationAccount: 'work' });
    expect(p.logged().filter(e => e.event === 'tool').at(-1)!.phases).toBeTypeOf('object');
  });
});
