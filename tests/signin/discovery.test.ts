import { afterEach, describe, expect, it, vi } from 'vitest';
import { issuer, startSignin, type Signin } from './harness.js';

let signin: Signin | undefined;
afterEach(async () => { vi.restoreAllMocks(); await signin?.close(); signin = undefined; });

describe('discovery and address', () => {
  it('SIG-01 resource metadata names the resource and the issuer', async () => {
    signin = await startSignin();
    const response = await fetch(`${signin.base}/.well-known/oauth-protected-resource/${signin.key}/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: `${issuer}/${signin.key}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header']
    });
  });

  it('SIG-02 server metadata advertises CIMD, S256 only, and issuer identification', async () => {
    signin = await startSignin();
    const response = await fetch(`${signin.base}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    });
  });

  it('SIG-03 a request without the key gets a 404 and reveals nothing', async () => {
    signin = await startSignin();
    const nothing = await fetch(`${signin.base}/no-such-page`);
    const nothingBody = await nothing.text();
    expect(nothing.status).toBe(404);
    const keyless = [
      ['GET', '/mcp'], ['POST', '/mcp'], ['GET', '/ready'],
      ['GET', '/.well-known/oauth-protected-resource'], ['GET', '/.well-known/oauth-protected-resource/mcp'],
      ['GET', '/wrong-key/mcp'], ['POST', `/${signin.key}x/mcp`], ['GET', `/.well-known/oauth-protected-resource/${signin.key.slice(0, -1)}/mcp`]
    ];
    for (const [method, path] of keyless) {
      const response = await fetch(`${signin.base}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.text(), `${method} ${path}`).toBe(nothingBody);
      expect(response.headers.get('www-authenticate'), `${method} ${path}`).toBeNull();
    }
    // With the key, the endpoint exists and asks for sign-in.
    const keyed = await fetch(`${signin.base}/${signin.key}/mcp`, { method: 'POST' });
    expect(keyed.status).toBe(401);
    expect(keyed.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/${signin.key}/mcp"`);
  });

  it('SIG-04 the key never appears in the request log', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    signin = await startSignin();
    await fetch(`${signin.base}/.well-known/oauth-protected-resource/${signin.key}/mcp`);
    await fetch(`${signin.base}/${signin.key}/mcp`, { method: 'POST' });
    await fetch(`${signin.base}/${signin.key}x/mcp`);
    expect(lines.filter(line => line.includes(signin!.key.slice(0, 20)))).toEqual([]);
    expect(lines.map(line => JSON.parse(line)).filter(entry => entry.event === 'request').map(entry => `${entry.method} ${entry.route} ${entry.status}`)).toEqual([
      'GET /.well-known/oauth-protected-resource/{key}/mcp 200',
      'POST /{key}/mcp 401',
      'GET (not found) 404'
    ]);
  });
});
