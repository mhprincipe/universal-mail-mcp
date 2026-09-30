import { lookup } from 'node:dns/promises';
import { DEFAULT_SEND_LIMITS } from '../sendLimits.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { loadAccounts, type NamedAccount } from '../accountsConfig.js';
import { failureEvent, runChecks } from '../check/runner.js';
import { providerOf, serverStages } from '../check/serverChecks.js';
import { VERSION } from '../version.js';
import { csv } from '../config.js';
import { createMailRouter, type MailRouter } from '../multiMail.js';
import { buildMcpServer } from '../tools.js';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import { createAuthorizationServer, loadSigninKeys, type SigninKeys } from './authorization.js';
import { createGrantStore, type GrantSnapshot } from './grants.js';
import type { InstallStore } from '../installed.js';
import { mountPage } from '../page/routes.js';
import { accountActions, type AccountStatus } from '../page/accounts.js';
import { appActions } from '../page/apps.js';
import { createDuties } from '../page/duties.js';
import type { MailCheck } from '../setup/flow.js';
import { mountApproval, type SystemMail } from './approvalRoutes.js';
import { createRefusals } from './refusals.js';
import { DOCUMENT_LIMITS, pinnedGet, type DocumentDeps } from './clientDocument.js';
import { createSubscription, longDate, type Subscription } from '../subscription/subscription.js';

// Apps that may connect: their identity documents must live on these origins.
// Updates add origins as more apps adopt the standard (design §6.5).
export const TRUSTED_ORIGINS = ['https://claude.ai', 'https://chatgpt.com'];

// Built-in sign-in (design §6.5): the server is its own sign-in server. The MCP
// endpoint lives under a secret path segment, {key}; without it, nothing here
// admits to existing.
const settings = z.object({
  SIGNIN_ISSUER: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !value.endsWith('/');
  }, 'The issuer is the server\'s public https:// address, with no path or trailing slash'),
  SIGNIN_KEY: z.string().regex(/^[A-Za-z0-9_-]{20,}$/, 'The key is at least 20 URL-safe characters'),
  // Where sign-in codes and notices go: the owner's address.
  SIGNIN_ADDRESS: z.string().email('The sign-in address must be an email address')
});

// What the installed server keeps across restarts (in universal-mail-state):
// what was saved, and where each change goes.
export type SavedSignin = {
  grants?: Partial<GrantSnapshot>;
  fingerprints?: WebAuthnCredential[];
  change(part: { grants?: GrantSnapshot; fingerprints?: WebAuthnCredential[] }): void;
  // Resolves once every change so far has been saved (or failed and been logged).
  settled(): Promise<void>;
};

export type SigninDeps = {
  clock?: { now(): number };
  keys?: SigninKeys;
  documents?: DocumentDeps;
  system?: SystemMail;
  saved?: SavedSignin;
  // Installed by setup: the accounts and passwords, which your page can change.
  store?: InstallStore;
  mailCheck?: MailCheck;
  fetchImpl?: typeof fetch;
};

// The real network, for production: DNS first, then a pinned fetch.
const realDocuments: DocumentDeps = {
  resolve: async host => (await lookup(host, { all: true })).map(a => a.address),
  get: (url, address) => pinnedGet(url, address, DOCUMENT_LIMITS)
};

export function createSigninApp(env: NodeJS.ProcessEnv, deps: SigninDeps = {}) {
  const { SIGNIN_ISSUER: issuer, SIGNIN_KEY: key, SIGNIN_ADDRESS: signInAddress } = settings.parse(env);
  const mcpPath = `/${key}/mcp`;
  const resourceMetadataPath = `/.well-known/oauth-protected-resource${mcpPath}`;
  const auth = createAuthorizationServer({
    issuer, resource: `${issuer}${mcpPath}`, trustedOrigins: TRUSTED_ORIGINS,
    keys: deps.keys ?? (() => loadSigninKeys(env)), clock: deps.clock ?? Date, documents: deps.documents ?? realDocuments,
    grants: createGrantStore(deps.saved?.grants, grants => deps.saved?.change({ grants }))
  });
  let accounts: NamedAccount[] | undefined;
  let mail: MailRouter | undefined;
  const store = deps.store;
  // Installed: the accounts as they are now (your page can change them).
  const getAccounts = () => accounts ??= loadAccounts(store ? { ...env, ...store.mailSettings() } : env);
  // A password the provider refused: shown on your page, and emailed once
  // ("something broke", with Fix it) until a working one is saved.
  const alerted = new Set<string>();
  const status: AccountStatus = new (class extends Map<string, 'working' | 'password'> {
    override set(name: string, value: 'working' | 'password') { if (value === 'working') alerted.delete(name); return super.set(name, value); }
  })();
  const onAuthFailure = async (name: string) => {
    status.set(name, 'password');
    if (!store || alerted.has(name)) return;
    alerted.add(name);
    await approval.notify(`The password for ${name} stopped working`,
      `Your email provider no longer accepts the app password Universal Mail uses for ${name}, so your AI apps can't use it.\n\nMake a new app password with your provider, then paste it on your Universal Mail page.\nFix it: ${issuer}/${key}`);
  };
  // The subscription (design §13): made once your page exists, below.
  let subscription: Subscription | undefined;
  const getMail = () => mail ??= createMailRouter(getAccounts(), { onAuthFailure, readOnly: () => subscription?.readOnlySentence() });
  // The old mail access logs out of its kept connections (ENG-18): they may carry an old password.
  store?.onAccountsChange(() => {
    const replaced = mail;
    accounts = undefined; mail = undefined;
    void replaced?.close().catch(() => undefined);
  });
  const checkPath = `/${key}/check`;
  const known = new Set([mcpPath, checkPath, resourceMetadataPath, '/.well-known/oauth-authorization-server', '/health',
    '/authorize', '/authorize/code', '/authorize/verify', '/authorize/approve', '/authorize/deny',
    '/authorize/passkey.js', '/authorize/passkey/options', '/authorize/passkey/verify', '/token', '/revoke', '/jwks']);
  const clock = deps.clock ?? Date;
  const refusals = createRefusals();
  const system: SystemMail = deps.system ?? {
    send: (account, to, subject, text) => getMail().service(account, 'read').sendSystemEmail(to, subject, text),
    discard: (account, messageId) => getMail().service(account, 'read').discardSystemEmail(messageId)
  };

  const app = express();
  // Installed, it runs behind Cloud Run's front end: one proxy hop, whose
  // X-Forwarded-For names the real visitor (code limits are per visitor).
  if (store) app.set('trust proxy', 1);

  // One line per request. The route is a template: the key becomes {key}, and
  // neither a query string nor an unknown path is ever written down.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const onPage = req.path === `/${key}` || req.path.startsWith(`/${key}/`);
      const route = known.has(req.path) || onPage ? req.path.replace(key, '{key}') : '(not found)';
      console.log(JSON.stringify({ event: 'request', method: req.method, route, status: res.statusCode, ms: Date.now() - started }));
    });
    next();
  });

  // What the server does on its own (reminders, update notices), checked as requests arrive.
  if (store) {
    const duties = createDuties({ store, clock, feedUrl: env.UPDATE_FEED_URL, fetchImpl: deps.fetchImpl, notify: (subject, text) => approval.notify(subject, text) });
    app.use(async (_req, _res, next) => {
      await duties.run().catch(() => undefined);
      await subscription?.duty().catch(error => console.log(JSON.stringify({ event: 'subscription_duty_failed', error: (error as Error)?.name ?? typeof error })));
      next();
    });
  }

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get(resourceMetadataPath, (_req, res) => res.json({
    resource: `${issuer}${mcpPath}`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header']
  }));

  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
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
  }));

  const approval = mountApproval(app, {
    issuer, auth, getMail: () => getMail(), signInAddress, system, clock, refusals,
    fingerprints: deps.saved?.fingerprints, onFingerprintsChange: fingerprints => deps.saved?.change({ fingerprints })
  });

  // The server's own check (design §7): from setup's check route, and from your page.
  const serverCheck = async (expectedVersion: string) => {
    const listed = getAccounts();
    const stages = serverStages({
      expectedVersion, runningVersion: VERSION, signinRoundTrip: () => auth.roundTrip(),
      accounts: listed.map(account => ({
        name: account.name, imapHost: account.config.IMAP_HOST, sentCopyMode: account.config.SENT_COPY_MODE,
        service: getMail().service(account.name, 'read')
      }))
    });
    const providers = [...new Set(listed.map(account => providerOf(account.config.IMAP_HOST)))];
    const state = subscription?.current();
    const report = await runChecks(stages, {
      version: VERSION, clock,
      facts: { accounts: listed.length, providers, ...(state && state.state !== 'unlimited' ? { subscription: { state: state.state, ...('daysLeft' in state ? { daysLeft: state.daysLeft } : {}) } } : {}) },
      onError: (stage, error) => console.log(JSON.stringify(failureEvent(stage, error)))
    });
    noteCheck(report);
    return report;
  };

  // What a check found about each account: a password refused, or all well.
  const noteCheck = (report: { stages: Array<{ stage: string; status: string; code?: string }> }) => {
    for (const s of report.stages) {
      const [kind, name] = s.stage.split(':');
      if (kind !== 'account' || !name) continue;
      if (s.status === 'PASS') status.set(name, 'working');
      else if (s.code === 'MAIL-APP-PASSWORD-REJECTED') status.set(name, 'password');
    }
  };
  // When each app last made a request (shown on your page).
  const lastUsed = new Map<string, number>();
  if (store) {
    subscription = createSubscription({ store, clock, serviceUrl: env.LICENSE_SERVICE_URL, fetchImpl: deps.fetchImpl, pageUrl: `${issuer}/${key}`, notify: (subject, text) => approval.notify(subject, text) });
    const sub = subscription;
    mountPage(app, {
      key, owner: approval.owner, signInAddress: () => store.signInAddress(), clock, notify: approval.notify,
      view: () => ({
        accounts: store.accounts().map(a => ({ name: a.name, email: a.email, sending: a.sending ?? true, sendLimits: a.sendLimits ?? DEFAULT_SEND_LIMITS, status: status.get(a.name) ?? 'unknown' })),
        apps: auth.grants.snapshot().apps.map(g => ({ ...g, lastUsed: lastUsed.get(g.appId) })),
        subscription: sub.current(), buyUrl: sub.buyUrl()
      }),
      extend: tools => {
        // Subscribing: the code from the receipt (design §13.1).
        tools.post('/subscription/activate', async (req, res, session) => {
          const outcome = await sub.activate(String(req.body.code ?? ''));
          if (!outcome.ok) return tools.back(res, session, { kind: 'error', text: outcome.text });
          const paid = outcome.state.state === 'active' ? ` Paid through ${longDate(Date.parse(outcome.state.paidThrough))}.` : '';
          tools.back(res, session, { kind: 'ok', text: `Your subscription is active.${paid}` });
        });
        accountActions(tools, { store, mailCheck: deps.mailCheck!, grants: auth.grants, status, notify: approval.notify });
        appActions(tools, { store, grants: auth.grants, disconnect: approval.disconnect, notify: approval.notify });
        // Check that everything works: the report, shown for copying.
        tools.post('/check', async (_req, res, session) => {
          const report = await serverCheck(VERSION);
          tools.back(res, session, report.result === 'PASS' ? { kind: 'ok', text: 'Everything works.' } : undefined, { report: JSON.stringify(report, null, 2) });
        });
      }
    });
  }

  const tokenForm = express.urlencoded({ extended: false, limit: '16kb' });
  app.post('/token', tokenForm, async (req, res) => {
    const answer = await auth.token(req.body ?? {});
    if (answer.status !== 200) refusals.record(answer.body.error, typeof req.body?.client_id === 'string' ? req.body.client_id : undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.status(answer.status).json(answer.body);
  });
  // Tokens are stateless; disconnecting (your page) is what ends access. RFC 7009 asks for 200 either way.
  app.post('/revoke', tokenForm, (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.status(200).end(); });
  app.get('/jwks', async (_req, res) => res.json(await auth.jwks()));

  const allowedHosts = csv(env.ALLOWED_HOSTS);
  const protectedApp = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: allowedHosts.length ? allowedHosts : ['localhost', '127.0.0.1'],
    allowedOrigins: csv(env.ALLOWED_ORIGINS)
  });
  // Every request: a valid token, then the app's grant as it is right now.
  protectedApp.all(mcpPath, async (req, res) => {
    const challenge = () => {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${issuer}${resourceMetadataPath}"`);
      res.status(401).json({ error: 'unauthorized' });
    };
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) { refusals.record('token_missing'); return challenge(); }
    let who;
    try { who = await auth.verifyAccess(header.slice(7)); }
    catch (error) { refusals.record((error as { reason?: string }).reason ?? 'token_invalid'); return challenge(); }
    const grant = auth.grants.get(who.appId);
    // Disconnected, or a token from an earlier connection.
    if (!grant || grant.connection !== who.grantVersion) { refusals.record('disconnected', who.appId); return challenge(); }
    lastUsed.set(who.appId, clock.now());
    const access = getMail().forGrant(grant.accounts);
    await toNodeHandler(createMcpHandler(() => buildMcpServer(access)))(req, res, req.body);
  });
  // The check (design §7): only setup's check token opens it. Setup says which
  // version it installed; the answer is the report, redacted by construction.
  protectedApp.post(checkPath, express.json({ limit: '4kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const refuse = (reason: string) => {
      console.log(JSON.stringify({ event: 'check_refused', reason }));
      res.status(401).json({ error: 'unauthorized' });
    };
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) return refuse('token_missing');
    try { await auth.verifyCheck(header.slice(7)); }
    catch (error) { return refuse((error as { reason?: string }).reason ?? 'token_invalid'); }

    const expectedVersion = typeof req.body?.expectedVersion === 'string' ? req.body.expectedVersion : '';
    res.json(await serverCheck(expectedVersion));
  });
  app.use(protectedApp);

  // The same answer for every unknown address: it never repeats the path.
  app.use((_req: Request, res: Response) => { res.status(404).json({ error: 'not_found' }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const status = (error as { status?: number })?.status;
    res.status(status === 400 || status === 413 ? status : 500).json({ error: 'Request could not be processed.' });
  });
  // The sign-in core, for the approval page and your page to act through.
  return Object.assign(app, { signin: {
    auth, grants: auth.grants, disconnect: approval.disconnect, owner: approval.owner, refusals: refusals.counts,
    saved: () => deps.saved?.settled() ?? Promise.resolve(),
    // The mail access as it is right now (it changes when your page changes an account).
    mail: () => getMail(),
    accountNames: () => getMail().names,
    noteCheck
  } });
}
