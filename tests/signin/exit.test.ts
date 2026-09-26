import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { success } from '../../src/errors.js';
import { MailService } from '../../src/yahoo/mailService.js';
import { callback, claude, issuer, key, startApproval } from './approvalHarness.js';

let a: Awaited<ReturnType<typeof startApproval>> | undefined;
let client: Client | undefined;
afterEach(async () => { await client?.close().catch(() => undefined); client = undefined; await a?.close(); a = undefined; vi.restoreAllMocks(); });

describe('Phase 2 exit', () => {
  it('a scripted Claude-like client connects to two accounts, with Auth0 absent', async () => {
    // Each account's mail is faked; the question here is the connection.
    vi.spyOn(MailService.prototype, 'searchEmail').mockImplementation(async function (this: MailService) {
      return success([{ mailbox: 'INBOX', uid: 1, subject: `hello from ${this.address}`, from: [], to: [], read: false, flagged: false, untrustedContent: true as const }]);
    });
    a = await startApproval();
    expect(Object.keys(process.env).filter(name => name.startsWith('OAUTH_'))).toEqual([]);
    // The public issuer is https://mail.example; locally it is served at a.base.
    const local = (url: string) => url.replace(issuer, a!.base);

    // 1. Unauthenticated: a 401 pointing at the resource metadata.
    const first = await fetch(`${a.base}/${key}/mcp`, { method: 'POST' });
    expect(first.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(first.headers.get('www-authenticate') ?? '')![1]!;

    // 2. Discovery: resource, then the sign-in server.
    const resource = await (await fetch(local(metadataUrl))).json();
    expect(resource.resource).toBe(`${issuer}/${key}/mcp`);
    const server = await (await fetch(`${local(resource.authorization_servers[0])}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({ issuer, code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });

    // 3. Authorization with PKCE, as Claude would open it in the owner's browser.
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(local(server.authorization_endpoint));
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: claude, redirect_uri: callback, state: 'claude-state-1', resource: resource.resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
    })) authorize.searchParams.set(k, v);
    let cookie = '';
    const browser = async (url: string, body?: Record<string, string>) => {
      const response = await fetch(url, body
        ? { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams(body) }
        : { redirect: 'manual' });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return { response, html: await response.text() };
    };

    // 4. The owner approves: code by email, then two accounts, Read only.
    let page = await browser(authorize.href);
    page = await browser(`${a.base}/authorize/code`, { csrf: a.csrfIn(page.html) });
    page = await browser(`${a.base}/authorize/verify`, { csrf: a.csrfIn(page.html), code: a.codeIn() });
    const approved = await browser(`${a.base}/authorize/approve`, { csrf: a.csrfIn(page.html), 'personal:read': 'on', 'work:read': 'on' });

    // 5. Back at Claude: check the issuer and state, then exchange the code.
    const back = new URL(approved.response.headers.get('location')!);
    expect(back.searchParams.get('iss')).toBe(issuer);
    expect(back.searchParams.get('state')).toBe('claude-state-1');
    const tokens = await (await fetch(local(server.token_endpoint), { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: callback, client_id: claude, code_verifier: verifier
    }) })).json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 900 });

    // 6. MCP with the token: both accounts, and only them.
    client = new Client({ name: 'claude-like', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${a.base}/${key}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const found = (await client.callTool({ name: 'search_email', arguments: { mailbox: 'INBOX' } })).structuredContent as any;
    expect(found.data.map((m: { account: string; subject: string }) => `${m.account}: ${m.subject}`).sort())
      .toEqual(['personal: hello from personal@example.invalid', 'work: hello from work@example.invalid']);

    // 7. Refresh: a new token that works the same.
    const refreshed = await (await fetch(local(server.token_endpoint), { method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: claude
    }) })).json();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    const again = await fetch(`${a.base}/${key}/mcp`, {
      method: 'POST', headers: { Authorization: `Bearer ${refreshed.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(again.status).toBe(200);
  });
});
