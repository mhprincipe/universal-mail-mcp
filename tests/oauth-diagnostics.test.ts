import { expect, it, vi } from 'vitest';
import { diagnoseOAuth } from '../scripts/oauth-diagnostics.js';

const config = { resource: 'https://mail.example/mcp', issuer: 'https://id.example/', owner: 'owner', clients: 'client' };
function fixture() {
  const request = vi.fn(async (url: string) => {
    if (url.endsWith('/health')) return Response.json({ status: 'ok' });
    if (url.includes('oauth-protected-resource')) return Response.json({ resource: config.resource, authorization_servers: [config.issuer], scopes_supported: ['mail.read'] });
    if (url.includes('openid-configuration')) return Response.json({ issuer: config.issuer, jwks_uri: config.issuer + 'keys', authorization_endpoint: config.issuer + 'authorize', token_endpoint: config.issuer + 'token', userinfo_endpoint: config.issuer + 'userinfo', code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });
    if (url.endsWith('/keys')) return Response.json({ keys: [{ kty: 'RSA', kid: 'test', n: 'value', e: 'AQAB' }] });
    if (url.endsWith('/userinfo')) return Response.json({ sub: 'owner' });
    return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mail.example/.well-known/oauth-protected-resource/mcp"' } });
  });
  const session = { initialize: vi.fn(async () => {}), tools: vi.fn(async () => {}), mailbox: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  return { request, verify: vi.fn(async () => ({ scopes: ['mail.read'] })), session: () => session, calls: session };
}
it('public checks never claim a full end-to-end pass without authorization and host evidence', async () => {
  const f = fixture(); const result = await diagnoseOAuth(config, f);
  expect(result.status).toBe('INCOMPLETE');
  expect(result.stages.find(s => s.name === 'token')?.status).toBe('NOT_RUN');
  expect(f.verify).not.toHaveBeenCalled(); expect(f.calls.initialize).not.toHaveBeenCalled();
});
it('runs token, UserInfo, MCP initialize, and discovery but does not access mailbox by default', async () => {
  const f = fixture(); const result = await diagnoseOAuth({ ...config, token: 'secret', oidc: true }, f);
  expect(result.stages.find(s => s.name === 'tools')?.status).toBe('PASS');
  expect(f.calls.mailbox).not.toHaveBeenCalled(); expect(f.calls.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain('secret');
});
it.each(['token', 'userinfo', 'initialize', 'tools', 'mailbox'])('identifies failure at %s without leaking exceptions or continuing dependent stages', async stage => {
  const f = fixture();
  if (stage === 'token') f.verify.mockRejectedValue(new Error('secret token body'));
  else if (stage === 'userinfo') { const normal = f.request.getMockImplementation()!; f.request.mockImplementation(async url => url.endsWith('/userinfo') ? Response.json({ sub: 'other' }) : normal(url)); }
  else f.calls[stage as 'initialize' | 'tools' | 'mailbox'].mockRejectedValue(new Error('secret mailbox body'));
  const result = await diagnoseOAuth({ ...config, token: 'secret', oidc: true, mailbox: true }, f);
  expect(result.status).toBe('FAIL'); expect(result.stages.find(s => s.name === stage)?.status).toBe('FAIL');
  expect(JSON.stringify(result)).not.toContain('secret');
  if (stage === 'token' || stage === 'userinfo') expect(f.calls.initialize).not.toHaveBeenCalled();
});
it('does not send credentials to a cross-origin UserInfo endpoint', async () => {
  const f = fixture(); const normal = f.request.getMockImplementation()!;
  f.request.mockImplementation(async url => {
    const r = await normal(url);
    return url.includes('openid-configuration') ? Response.json({ ...await r.json(), userinfo_endpoint: 'https://attacker.example/userinfo' }) : r;
  });
  const result = await diagnoseOAuth({ ...config, token: 'secret', oidc: true }, f);
  expect(result.status).toBe('FAIL'); expect(f.verify).not.toHaveBeenCalled();
  expect(f.request.mock.calls.some(([url]) => url.includes('attacker'))).toBe(false);
});
it('rejects an incorrect audience in discovery before accepting a token', async () => {
  const f = fixture(); const normal = f.request.getMockImplementation()!;
  f.request.mockImplementation(async url => url.includes('oauth-protected-resource') ? Response.json({ resource: 'https://wrong.example/mcp' }) : normal(url));
  expect((await diagnoseOAuth({ ...config, token: 'secret' }, f)).status).toBe('FAIL');
  expect(f.verify).not.toHaveBeenCalled();
});
it('missing mail.read fails the token stage', async () => {
  const f = fixture(); f.verify.mockResolvedValue({ scopes: [] });
  const result = await diagnoseOAuth({ ...config, token: 'secret' }, f);
  expect(result.stages.find(s => s.name === 'token')?.status).toBe('FAIL');
});
