export type DiagnosticConfig = { resource: string; issuer: string; owner?: string; clients?: string; token?: string; oidc?: boolean; mailbox?: boolean };
export type Session = { initialize(): Promise<void>; tools(): Promise<void>; mailbox(): Promise<void>; close(): Promise<void> };
export type Dependencies = { request(url: string, init?: RequestInit): Promise<Response>; verify(token: string, jwksUri: string): Promise<{ scopes: string[] }>; session(): Session };
export type Stage = { name: string; status: 'PASS' | 'FAIL' | 'NOT_RUN' };
export async function diagnoseOAuth(config: DiagnosticConfig, deps: Dependencies): Promise<{ status: string; stages: Stage[] }> {
  const stages: Stage[] = ['configuration', 'health', 'resource', 'provider', 'jwks', 'challenge', 'token', 'userinfo', 'initialize', 'tools', 'mailbox', 'chatgpt', 'claude'].map(name => ({ name, status: 'NOT_RUN' }));
  let active = stages[0]!;
  let session: Session | undefined;
  const check = (ok: unknown) => { if (!ok) throw new Error('CHECK_FAILED'); };
  const step = async (name: string, run: () => Promise<void>) => {
    active = stages.find(s => s.name === name)!;
    await run(); active.status = 'PASS';
  };
  const request = (url: string, headers?: Record<string, string>) => deps.request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const json = async (url: string, headers?: Record<string, string>) => { const r = await request(url, headers); check(r.ok); return r.json(); };
  let provider: Record<string, any> = {};
  try {
    await step('configuration', async () => {
      for (const value of [config.resource, config.issuer]) { const u = new URL(value); check(u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search); }
      check(new URL(config.resource).pathname === '/mcp');
      if (config.token) check(config.owner && config.clients);
    });
    const base = new URL(config.resource).origin;
    const metadata = base + '/.well-known/oauth-protected-resource/mcp';
    await step('health', async () => check((await json(base + '/health')).status === 'ok'));
    await step('resource', async () => {
      const doc = await json(metadata);
      check(doc.resource === config.resource && doc.authorization_servers?.length === 1 && doc.authorization_servers[0] === config.issuer && doc.scopes_supported?.includes('mail.read'));
    });
    await step('provider', async () => {
      provider = await json(new URL('/.well-known/openid-configuration', config.issuer).href);
      check(provider.issuer === config.issuer && provider.code_challenge_methods_supported?.includes('S256') && provider.client_id_metadata_document_supported === true);
      for (const field of ['jwks_uri', 'authorization_endpoint', 'token_endpoint', ...(config.oidc ? ['userinfo_endpoint'] : [])]) {
        const url = new URL(provider[field]);
        check(url.origin === new URL(config.issuer).origin && !url.username && !url.password && !url.hash && !url.search);
      }
    });
    await step('jwks', async () => { const doc = await json(provider.jwks_uri); check(Array.isArray(doc.keys) && doc.keys.some((k: any) => k.kty === 'RSA' && k.kid && k.n && k.e && !k.d)); });
    await step('challenge', async () => {
      for (const path of ['/mcp', '/ready']) {
        const r = await request(base + path);
        check(r.status === 401 && r.headers.get('www-authenticate')?.includes(`resource_metadata="${metadata}"`));
        await r.body?.cancel();
      }
    });
    if (config.token) {
      const token = config.token;
      await step('token', async () => check((await deps.verify(token, provider.jwks_uri)).scopes.includes('mail.read')));
      if (config.oidc) await step('userinfo', async () => check((await json(provider.userinfo_endpoint, { Authorization: `Bearer ${token}` })).sub === config.owner));
      session = deps.session();
      await step('initialize', () => session!.initialize());
      await step('tools', () => session!.tools());
      if (config.mailbox) await step('mailbox', () => session!.mailbox());
    }
  } catch { active.status = 'FAIL'; }
  finally { await session?.close().catch(() => {}); }
  // A standalone client cannot attest that ChatGPT or Claude completed their own flow.
  return { status: stages.some(s => s.status === 'FAIL') ? 'FAIL' : 'INCOMPLETE', stages };
}
