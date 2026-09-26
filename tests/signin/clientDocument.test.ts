import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCUMENT_LIMITS, fetchClientDocument, isPublicAddress, pinnedGet, redirectAllowed, type DocumentDeps
} from '../../src/signin/clientDocument.js';

const trusted = ['https://claude.ai', 'https://chatgpt.com'];
const claudeId = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const claudeDoc = { client_id: claudeId, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };

const deps = (overrides: Partial<DocumentDeps> = {}) => ({
  resolve: vi.fn(async (_host: string) => ['160.79.104.10']),
  get: vi.fn(async (_url: URL, _address: string) => ({ status: 200, body: JSON.stringify(claudeDoc) })),
  ...overrides
});

describe('app identity documents', () => {
  it('SIG-10 an identity document on a trusted origin is accepted, fetched from the vetted address', async () => {
    const d = deps();
    expect(await fetchClientDocument(claudeId, trusted, d)).toEqual(claudeDoc);
    expect(d.resolve).toHaveBeenCalledWith('claude.ai');
    expect(d.get).toHaveBeenCalledWith(new URL(claudeId), '160.79.104.10');
  });

  it('SIG-11 an untrusted origin is refused before any network activity', async () => {
    const refusals = [
      'https://evil.example/client.json', 'http://claude.ai/oauth/mcp-oauth-client-metadata', 'https://claude.ai.evil.example/x',
      'https://user:pw@claude.ai/x', 'https://claude.ai:8443/x', 'https://claude.ai/x#frag', 'not a url', 'https://10.0.0.1/x'
    ];
    for (const clientId of refusals) {
      const d = deps();
      await expect(fetchClientDocument(clientId, trusted, d), clientId).rejects.toMatchObject({ reason: 'untrusted_origin' });
      expect(d.resolve, clientId).not.toHaveBeenCalled();
      expect(d.get, clientId).not.toHaveBeenCalled();
    }
  });

  it('SIG-12 private, loopback, link-local and metadata addresses are refused', () => {
    const blocked = [
      '10.0.0.5', '172.16.1.1', '192.168.1.1', '127.0.0.1', '0.0.0.0', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
      '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'garbage'
    ];
    for (const address of blocked) expect(isPublicAddress(address), address).toBe(false);
    for (const address of ['160.79.104.10', '8.8.8.8', '2607:6bc0::10']) expect(isPublicAddress(address), address).toBe(true);
  });

  it('SIG-13 a trusted hostname that resolves to a private address is refused (DNS rebinding)', async () => {
    for (const answer of [['10.0.0.5'], ['160.79.104.10', '127.0.0.1'], []]) {
      const d = deps({ resolve: vi.fn(async () => answer) });
      await expect(fetchClientDocument(claudeId, trusted, d), answer.join()).rejects.toMatchObject({ reason: 'unsafe_address' });
      expect(d.get).not.toHaveBeenCalled();
    }
  });

  it('SIG-14 redirects are not followed', async () => {
    const d = deps({ get: vi.fn(async () => ({ status: 302, body: '' })) });
    await expect(fetchClientDocument(claudeId, trusted, d)).rejects.toMatchObject({ reason: 'fetch_status' });
    expect(d.get).toHaveBeenCalledTimes(1);
  });

  it('SIG-16 the document must name itself, and redirect addresses must match it exactly', async () => {
    const other = deps({ get: vi.fn(async () => ({ status: 200, body: JSON.stringify({ ...claudeDoc, client_id: 'https://claude.ai/other' }) })) });
    await expect(fetchClientDocument(claudeId, trusted, other)).rejects.toMatchObject({ reason: 'document_invalid' });
    const noRedirects = deps({ get: vi.fn(async () => ({ status: 200, body: JSON.stringify({ ...claudeDoc, redirect_uris: [] }) })) });
    await expect(fetchClientDocument(claudeId, trusted, noRedirects)).rejects.toMatchObject({ reason: 'document_invalid' });

    const callback = 'https://claude.ai/api/mcp/auth_callback';
    expect(redirectAllowed(claudeDoc, callback)).toBe(true);
    for (const near of [`${callback}/`, `${callback}?x=1`, callback.toUpperCase(), 'https://claude.ai/api/mcp/auth_callback2', 'http://claude.ai/api/mcp/auth_callback']) {
      expect(redirectAllowed(claudeDoc, near), near).toBe(false);
    }
  });
});

describe('the pinned fetch itself', () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = undefined; });
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    server = createServer(handler);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  it('SIG-15 documents over 64 KB, or slower than 5 seconds, are refused; redirects come back unfollowed', async () => {
    expect(DOCUMENT_LIMITS).toEqual({ maxBytes: 64 * 1024, timeoutMs: 5_000 });
    const port = await serve((req, res) => {
      if (req.url === '/big') { res.end('x'.repeat(64 * 1024 + 1)); return; }
      if (req.url === '/slow') { setTimeout(() => res.end('{}'), 1_000); return; }
      if (req.url === '/moved') { res.writeHead(302, { Location: '/ok' }); res.end(); return; }
      res.end(JSON.stringify({ host: req.headers.host }));
    });
    // Connects to the vetted address while naming the real host.
    const url = (path: string) => new URL(`http://docs.example:${port}${path}`);
    const ok = await pinnedGet(url('/ok'), '127.0.0.1', DOCUMENT_LIMITS, 'http');
    expect(ok).toEqual({ status: 200, body: JSON.stringify({ host: `docs.example:${port}` }) });
    expect(await pinnedGet(url('/moved'), '127.0.0.1', DOCUMENT_LIMITS, 'http')).toMatchObject({ status: 302 });
    await expect(pinnedGet(url('/big'), '127.0.0.1', DOCUMENT_LIMITS, 'http')).rejects.toMatchObject({ reason: 'document_too_large' });
    await expect(pinnedGet(url('/slow'), '127.0.0.1', { ...DOCUMENT_LIMITS, timeoutMs: 200 }, 'http')).rejects.toMatchObject({ reason: 'fetch_timeout' });
  });
});
