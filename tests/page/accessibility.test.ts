import axe from 'axe-core';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboard } from '../../src/page/views.js';
import { codePage, errorPage, permissionsPage, startPage as approvalStart } from '../../src/signin/pages.js';
import { startPage } from './pageHarness.js';

// Your page for everyone (added 2026-09-29, principle 6): every page the
// server renders passes the axe accessibility rules: labels on every field,
// names on every button, a language, headings in order, landmarks, no
// duplicate ids. Colour contrast needs a real browser's layout, so it's left
// out here; the phone layout is PG-16.
let p: Awaited<ReturnType<typeof startPage>> | undefined;
afterEach(async () => { await p?.close(); p = undefined; });

async function violations(html: string): Promise<string[]> {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(axe.source);
  const result = await (dom.window as unknown as { axe: typeof axe }).axe.run(dom.window.document, {
    rules: { 'color-contrast': { enabled: false } }
  });
  dom.window.close();
  return result.violations.map(v => `${v.id}: ${v.help} (${v.nodes.length}×, e.g. ${v.nodes[0]?.html.slice(0, 80)})`);
}

describe('accessibility', () => {
  it('A11Y-01 every page passes the automated accessibility rules: sign-in, code, approval, and your page with accounts, apps and activity (added: 2.4)', { timeout: 60_000 }, async () => {
    p = await startPage();
    p.app.signin!.grants.connect('https://claude.ai/oauth/mcp-oauth-client-metadata', 'Claude', { me: ['read', 'organize'] });
    await p.signIn();
    await p.act('/check', {});
    const full = dashboard({ base: '/k', csrf: 'c', now: 60_000, canGrantSend: true, report: '{"result":"PASS"}',
      accounts: [
        { name: 'me', email: 'me@example.invalid', sending: true, sendLimits: { perHour: 30, perDay: 200 }, status: 'working', lastUsed: 0 },
        { name: 'work', email: 'work@example.invalid', sending: false, sendLimits: { perHour: 5, perDay: 20 }, status: 'password' }
      ],
      apps: [{ appId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', appName: 'Claude', connection: 1, accounts: { me: ['read', 'organize'], work: ['read'] }, lastUsed: 0 }],
      activity: [
        { id: 'a1', at: 0, app: 'Claude', account: 'me', action: 'trashed', count: 2, from: 'INBOX', to: 'Trash', undo: { kind: 'move', mailbox: 'Trash', uids: [1, 2], destination: 'INBOX' } },
        { id: 'a2', at: 0, app: 'Claude', account: 'me', action: 'sent', count: 1, recipients: 1 }
      ] });
    // The approval screens an app's sign-in shows (fingerprint, code, permissions, a refusal).
    const app = { name: 'Claude', origin: 'https://claude.ai' };
    const approval = [approvalStart(app, 'me@example.invalid', 'c', true), codePage(app, 'c', 'That code is wrong.'), permissionsPage(app, ['me', 'work'], true, 'c', 'Pick at least one account.'), errorPage('This link has expired.')];
    const pages = [...new Set([...p.pages, full, ...approval])].filter(h => h.startsWith('<!doctype html>'));
    expect(pages.length).toBeGreaterThan(3);
    const found: string[] = [];
    for (const html of pages) {
      const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '(no title)';
      for (const v of await violations(html)) found.push(`${title}: ${v}`);
    }
    expect([...new Set(found)]).toEqual([]);
  });
});
