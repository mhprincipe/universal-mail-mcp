import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod/v4';
import { csv } from './config.js';

const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search;
}, 'An HTTPS URL without credentials, query or fragment is required');
const schema = z.object({
  AUTH_MODE: z.enum(['oauth', 'oauth-setup']).default('oauth'),
  OAUTH_ISSUER: httpsUrl,
  OAUTH_JWKS_URI: httpsUrl,
  OAUTH_RESOURCE: httpsUrl.refine(value => new URL(value).pathname === '/mcp', 'Resource must end in /mcp'),
  OAUTH_OWNER_SUB: z.string().default(''),
  OAUTH_CLIENT_IDS: z.string().default(''),
}).superRefine((config, ctx) => {
  if (config.AUTH_MODE === 'oauth' && (!config.OAUTH_OWNER_SUB.trim() || !csv(config.OAUTH_CLIENT_IDS).length)) ctx.addIssue({ code: 'custom', message: 'OAuth requires the owner subject and approved clients' });
  if (config.OAUTH_OWNER_SUB === '*' || csv(config.OAUTH_CLIENT_IDS).includes('*')) ctx.addIssue({ code: 'custom', message: 'Wildcard identities are not allowed' });
});
export type OAuthConfig = z.infer<typeof schema>;
export function loadOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  if (!env.AUTH_MODE || env.AUTH_MODE === 'bearer') return undefined;
  if (env.AUTH_MODE !== 'oauth' && env.AUTH_MODE !== 'oauth-setup') throw new Error('Unsupported authentication mode');
  return schema.parse(env);
}
// Carries which check failed, never a token or claim value, so an operator can
// tell six distinct causes apart instead of reading one opaque 401.
export class TokenRejected extends Error {
  constructor(public readonly reason: string) {
    super('Unauthorized');
    this.name = 'TokenRejected';
  }
}

export function createTokenVerifier(config: OAuthConfig, key: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.OAUTH_JWKS_URI), { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 })) {
  return async (token: string) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'], issuer: config.OAUTH_ISSUER, audience: config.OAUTH_RESOURCE,
        requiredClaims: ['sub', 'iat', 'exp', 'azp', 'scope'], clockTolerance: 5, maxTokenAge: 900
      }));
    } catch (error) {
      const e = error as { code?: string; claim?: string };
      throw new TokenRejected(['jwt', e?.code ?? 'invalid', e?.claim].filter(Boolean).join(':'));
    }
    if (payload.sub !== config.OAUTH_OWNER_SUB) throw new TokenRejected('sub_mismatch');
    if (typeof payload.azp !== 'string') throw new TokenRejected('azp_missing');
    if (!csv(config.OAUTH_CLIENT_IDS).includes(payload.azp)) throw new TokenRejected('azp_not_allowed');
    if (typeof payload.scope !== 'string') throw new TokenRejected('scope_missing');
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') throw new TokenRejected('timestamps_missing');
    if (payload.exp - payload.iat > 900) throw new TokenRejected('lifetime_too_long');
    if (payload.exp <= payload.iat) throw new TokenRejected('lifetime_invalid');
    return { scopes: payload.scope.split(/\s+/).filter(Boolean) };
  };
}
const reads = new Set(['search_email', 'get_email', 'get_thread', 'list_folders']);
const writes = new Set(['create_draft', 'update_draft', 'move_email', 'archive_email', 'mark_read', 'mark_unread', 'flag_email', 'trash_email', 'restore_email', 'create_folder']);
export function requiredScopes(tool: string): string[] {
  if (reads.has(tool)) return ['mail.read'];
  if (writes.has(tool)) return ['mail.read', 'mail.write'];
  if (tool === 'send_email' || tool === 'reply_email') return ['mail.read', 'mail.send'];
  throw new Error('Unknown tool');
}
