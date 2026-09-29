import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EncryptJWT, SignJWT, createLocalJWKSet, decodeJwt, errors, exportJWK, generateKeyPair, importJWK, jwtDecrypt, jwtVerify, type CryptoKey, type JSONWebKeySet, type JWK, type JWTPayload } from 'jose';
import { CHECK_TOKEN_SECONDS, CHECK_TOKEN_TYPE } from '../setup/checkToken.js';
import { SigninRefusal, fetchClientDocument, fetchClientKeys, redirectAllowed, type DocumentDeps } from './clientDocument.js';
import { createGrantStore, type AccountGrant, type GrantStore } from './grants.js';

// The authorization server (design §6.5), built directly on jose. One grant
// type with PKCE, plus refresh. Tokens are stateless; the only memory is a
// short list of codes already used, because OAuth requires a code work once.

export type SigninKeys = { signing: { privateKey: CryptoKey; publicKey: CryptoKey }; encryption: Uint8Array };
export type PendingRequest = { clientId: string; clientName?: string; redirectUri: string; codeChallenge: string; state?: string };
type Begun = { ok: true; request: PendingRequest } | { ok: false; error: string; redirect?: string };
type TokenResponse = { status: number; body: any };

export type AuthorizationServer = {
  begin(params: Record<string, string | undefined>): Promise<Begun>;
  // The owner approved, with these permissions: record the grant, return the redirect.
  approve(request: PendingRequest, accounts: AccountGrant): Promise<string>;
  token(form: Record<string, string | undefined>): Promise<TokenResponse>;
  verifyAccess(token: string): Promise<{ appId: string; grantVersion: number }>;
  // The public signing key, for /jwks.
  jwks(): Promise<{ keys: JWK[] }>;
  // The check route's token, made by setup: valid for minutes, once.
  verifyCheck(token: string): Promise<void>;
  // For the check: issue an access token and verify it.
  roundTrip(): Promise<boolean>;
};

// The app id sign-in's own round trip issues a token to (the check's "signin" stage).
const CHECK_CLIENT = 'urn:universal-mail:check';
const CODE_SECONDS = 60;
const ACCESS_SECONDS = 15 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
// A signed assertion is for this one request: minutes, not hours.
const ASSERTION_MAX_SECONDS = 10 * 60;

export async function generateSigninKeys(): Promise<SigninKeys> {
  return { signing: await generateKeyPair('ES256', { extractable: true }), encryption: new Uint8Array(randomBytes(32)) };
}

// From universal-mail-credentials: the private signing key as a JWK, and a
// 32-byte encryption key. Messages never repeat either value.
export async function loadSigninKeys(env: NodeJS.ProcessEnv): Promise<SigninKeys> {
  let jwk: JWK;
  try { jwk = JSON.parse(env.SIGNIN_SIGNING_KEY ?? ''); } catch { throw new Error("SIGNIN_SIGNING_KEY isn't a valid key."); }
  const encryption = Buffer.from(env.SIGNIN_ENCRYPTION_KEY ?? '', 'base64url');
  if (encryption.length !== 32) throw new Error('SIGNIN_ENCRYPTION_KEY must be 32 bytes, base64url-encoded.');
  const { d: _private, ...publicJwk } = jwk;
  return {
    signing: { privateKey: await importJWK(jwk, 'ES256') as CryptoKey, publicKey: await importJWK(publicJwk, 'ES256') as CryptoKey },
    encryption: new Uint8Array(encryption)
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export function createAuthorizationServer(options: {
  issuer: string; resource: string; trustedOrigins: string[]; keys: SigninKeys | (() => Promise<SigninKeys>);
  clock: { now(): number }; documents: DocumentDeps; grants?: GrantStore;
  // The check route's address; by default the MCP address ending /check.
  checkAudience?: string;
}): AuthorizationServer & { grants: GrantStore } {
  const { issuer, resource, clock } = options;
  const grants = options.grants ?? createGrantStore();
  // Keys may load lazily (from the credentials secret), on first use.
  let loaded: Promise<SigninKeys> | undefined;
  const keys = () => loaded ??= typeof options.keys === 'function' ? options.keys() : Promise.resolve(options.keys);
  const seconds = () => Math.floor(clock.now() / 1000);
  const usedCodes = new Map<string, number>();
  const usedChecks = new Map<string, number>();
  const usedAssertions = new Map<string, number>();
  const checkAudience = options.checkAudience ?? resource.replace(/\/mcp$/, '/check');

  const seal = async (claims: JWTPayload, lifetime: number) => new EncryptJWT(claims)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt(seconds()).setExpirationTime(seconds() + lifetime).setJti(randomUUID())
    .encrypt((await keys()).encryption);

  // Undefined for anything expired, forged, or of another kind.
  const open = async (token: string, typ: 'code' | 'refresh') => {
    try {
      const { payload } = await jwtDecrypt(token, (await keys()).encryption, {
        currentDate: new Date(clock.now()), keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM']
      });
      return payload.typ === typ ? payload : undefined;
    } catch { return undefined; }
  };

  const tokenError = (error: string): TokenResponse => ({ status: 400, body: { error } });

  // Which app is asking (added for ChatGPT, SIG-83/84). A public client just
  // names itself (client_id), as Claude does; PKCE and the sealed code are
  // the proof. An app may instead prove itself with an assertion signed by
  // the keys its own document names (private_key_jwt): then that is checked
  // in full, and anything short of proof is invalid_client, never ignored.
  const whoIsAsking = async (form: Record<string, string | undefined>): Promise<{ clientId?: string } | undefined> => {
    if (form.client_assertion === undefined && form.client_assertion_type === undefined) return { clientId: form.client_id };
    if (form.client_assertion_type !== ASSERTION_TYPE || !form.client_assertion) return undefined;
    let claimed: string | undefined;
    try { claimed = decodeJwt(form.client_assertion).iss; } catch { return undefined; }
    const clientId = form.client_id ?? claimed;
    if (!clientId || claimed !== clientId) return undefined;
    try {
      const doc = await fetchClientDocument(clientId, options.trustedOrigins, options.documents);
      const keySet = createLocalJWKSet(await fetchClientKeys(doc, options.trustedOrigins, options.documents) as JSONWebKeySet);
      const { payload } = await jwtVerify(form.client_assertion, keySet, {
        issuer: clientId, subject: clientId, audience: [issuer, `${issuer}/token`],
        algorithms: ['RS256', 'PS256', 'ES256'], currentDate: new Date(clock.now()), requiredClaims: ['exp', 'jti']
      });
      if (payload.exp! > seconds() + ASSERTION_MAX_SECONDS) return undefined;
      for (const [id, expires] of usedAssertions) if (expires < seconds()) usedAssertions.delete(id);
      const once = `${clientId} ${payload.jti}`;
      if (usedAssertions.has(once)) return undefined;
      usedAssertions.set(once, payload.exp!);
      return { clientId };
    } catch { return undefined; }
  };

  const issue = async (clientId: string, grantVersion: number): Promise<TokenResponse> => {
    const access = await new SignJWT({ client_id: clientId, grant_version: grantVersion })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(issuer).setAudience(resource)
      .setIssuedAt(seconds()).setExpirationTime(seconds() + ACCESS_SECONDS).setJti(randomUUID())
      .sign((await keys()).signing.privateKey);
    // A new refresh token on every use: its 30 days always count from the last use.
    const refresh = await seal({ typ: 'refresh', client_id: clientId, grant_version: grantVersion }, REFRESH_SECONDS);
    return { status: 200, body: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, refresh_token: refresh } };
  };

  const verifyAccess = async (token: string) => {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, (await keys()).signing.publicKey, {
        issuer, audience: resource, algorithms: ['ES256'], currentDate: new Date(clock.now())
      });
      // A check token never opens the mail tools, whatever its audience.
      if (protectedHeader.typ === CHECK_TOKEN_TYPE) throw new Error('a check token');
      return { appId: String(payload.client_id), grantVersion: Number(payload.grant_version) };
    } catch (error) {
      throw new SigninRefusal(error instanceof errors.JWTExpired ? 'token_expired' : 'token_invalid');
    }
  };

  return {
    grants,
    async begin(params) {
      const { client_id: clientId, redirect_uri: redirectUri, state } = params;
      if (!clientId || !redirectUri) return { ok: false, error: 'invalid_request' };
      let doc;
      try { doc = await fetchClientDocument(clientId, options.trustedOrigins, options.documents); }
      catch (error) { return { ok: false, error: error instanceof SigninRefusal ? error.reason : 'client_invalid' }; }
      // An address the document doesn't list is never redirected to, not even with an error.
      if (!redirectAllowed(doc, redirectUri)) return { ok: false, error: 'redirect_mismatch' };

      const refuse = (error: string, description: string): Begun => {
        const url = new URL(redirectUri);
        url.searchParams.set('error', error);
        url.searchParams.set('error_description', description);
        if (state) url.searchParams.set('state', state);
        url.searchParams.set('iss', issuer);
        return { ok: false, error, redirect: url.href };
      };
      if (params.response_type !== 'code') return refuse('unsupported_response_type', 'Only the code flow is supported.');
      if (!params.code_challenge || params.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) {
        return refuse('invalid_request', 'PKCE with S256 is required.');
      }
      return { ok: true, request: { clientId, ...(doc.client_name ? { clientName: doc.client_name } : {}), redirectUri, codeChallenge: params.code_challenge, ...(state ? { state } : {}) } };
    },

    async approve(request, accounts) {
      const grantVersion = grants.connect(request.clientId, request.clientName, accounts).connection;
      const code = await seal({
        typ: 'code', client_id: request.clientId, redirect_uri: request.redirectUri, code_challenge: request.codeChallenge, grant_version: grantVersion
      }, CODE_SECONDS);
      const url = new URL(request.redirectUri);
      url.searchParams.set('code', code);
      if (request.state) url.searchParams.set('state', request.state);
      url.searchParams.set('iss', issuer);
      return url.href;
    },

    async token(form) {
      const asking = await whoIsAsking(form);
      if (!asking) return { status: 401, body: { error: 'invalid_client' } };
      const clientId = asking.clientId;
      if (form.grant_type === 'authorization_code') {
        if (!form.code || !form.code_verifier || !form.redirect_uri || !clientId) return tokenError('invalid_request');
        const claims = await open(form.code, 'code');
        if (!claims || claims.client_id !== clientId || claims.redirect_uri !== form.redirect_uri) return tokenError('invalid_grant');
        const expected = Buffer.from(String(claims.code_challenge), 'base64url');
        const presented = sha256(form.code_verifier);
        if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return tokenError('invalid_grant');
        for (const [id, expires] of usedCodes) if (expires < seconds()) usedCodes.delete(id);
        if (usedCodes.has(claims.jti!)) return tokenError('invalid_grant');
        usedCodes.set(claims.jti!, claims.exp!);
        return issue(clientId, Number(claims.grant_version));
      }
      if (form.grant_type === 'refresh_token') {
        if (!form.refresh_token || !clientId) return tokenError('invalid_request');
        const claims = await open(form.refresh_token, 'refresh');
        if (!claims || claims.client_id !== clientId) return tokenError('invalid_grant');
        return issue(clientId, Number(claims.grant_version));
      }
      return tokenError('unsupported_grant_type');
    },

    async jwks() {
      const { d: _private, ...publicKey } = await exportJWK((await keys()).signing.publicKey);
      return { keys: [{ ...publicKey, alg: 'ES256', use: 'sig' }] };
    },

    async verifyCheck(token) {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, (await keys()).signing.publicKey, {
          issuer, audience: checkAudience, algorithms: ['ES256'], typ: CHECK_TOKEN_TYPE, currentDate: new Date(clock.now()),
          requiredClaims: ['iat', 'exp', 'jti'], maxTokenAge: CHECK_TOKEN_SECONDS
        }));
      } catch (error) {
        throw new SigninRefusal(error instanceof errors.JWTExpired ? 'token_expired' : 'token_invalid');
      }
      // Minutes, not hours: a longer-lived one isn't setup's.
      if (payload.exp! - payload.iat! > CHECK_TOKEN_SECONDS) throw new SigninRefusal('token_invalid');
      for (const [id, expires] of usedChecks) if (expires < seconds()) usedChecks.delete(id);
      if (usedChecks.has(payload.jti!)) throw new SigninRefusal('token_reused');
      usedChecks.set(payload.jti!, payload.exp!);
    },

    async roundTrip() {
      const { body } = await issue(CHECK_CLIENT, 0);
      try { return (await verifyAccess(body.access_token)).appId === CHECK_CLIENT; } catch { return false; }
    },

    verifyAccess
  };
}
