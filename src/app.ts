import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import express, { type Request, type Response, type NextFunction } from 'express';
import { loadAccounts } from './accountsConfig.js';
import { csv } from './config.js';
import { createMailRouter, type MailRouter } from './multiMail.js';
import { createSigninApp } from './signin/server.js';
import type { SystemMail } from './signin/approvalRoutes.js';
import { CREDENTIALS_SECRET_NAME, STATE_SECRET_NAME, createInstallStore, readInstalled } from './installed.js';
import { createSecretWriter } from './secretWriter.js';
import type { MailCheck } from './setup/flow.js';
import { createMailCheck } from './setup/realMail.js';

// The server's own log for the mail checks it runs from your page: one JSON
// line per event (secrets are never passed to it).
const serverLog = { secret: () => undefined, event: (event: Record<string, unknown>) => console.log(JSON.stringify({ event: 'mail_check', ...event })) };
import { buildMcpServer } from './tools.js';
import { VERSION } from './version.js';

export type AppDeps = {
  // Save a new version of each saved record (Secret Manager, in production).
  saveState?: (json: string) => Promise<void>;
  saveCredentials?: (json: string) => Promise<void>;
  system?: SystemMail;
  clock?: { now(): number };
  // Checking an account's app password from your page (setup's own checks).
  mailCheck?: MailCheck;
  // For the update-available check.
  fetchImpl?: typeof fetch;
};

// A server that can't serve yet: healthy while it waits for its address,
// unhealthy when its settings are wrong. Nothing else answers.
function holdingApp(health: 200 | 503, status: 'starting' | 'not_configured') {
  const app = express();
  app.get('/health', (_req, res) => res.status(health).json({ status }));
  app.use((_req, res) => res.status(503).json({ error: 'not_ready' }));
  return Object.assign(app, { signin: undefined });
}

// Installed by setup: everything comes from the two saved records (design §6.3).
function createInstalledApp(env: NodeJS.ProcessEnv, deps: AppDeps) {
  const installed = readInstalled(env);
  if (installed.status === 'invalid') {
    console.log(JSON.stringify({ event: 'settings_invalid', setting: installed.setting, problem: installed.problem }));
    return holdingApp(503, 'not_configured');
  }
  if (installed.status === 'starting') {
    console.log(JSON.stringify({ event: 'waiting_for_address' }));
    return holdingApp(200, 'starting');
  }
  console.log(JSON.stringify({ event: 'settings_loaded', accounts: installed.state.accounts.length }));
  const store = createInstallStore(installed, {
    state: deps.saveState ?? createSecretWriter({ secret: STATE_SECRET_NAME }),
    credentials: deps.saveCredentials ?? createSecretWriter({ secret: CREDENTIALS_SECRET_NAME })
  });
  return createSigninApp(installed.env, {
    saved: store, store, mailCheck: deps.mailCheck ?? createMailCheck({ log: serverLog }),
    ...(deps.system ? { system: deps.system } : {}), ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  });
}

export function createApp(env: NodeJS.ProcessEnv = process.env, deps: AppDeps = {}) {
  if (env.UNIVERSAL_MAIL_STATE !== undefined || env.UNIVERSAL_MAIL_CREDENTIALS !== undefined) return createInstalledApp(env, deps);
  if (env.AUTH_MODE === 'builtin') return createSigninApp(env);
  // v1's Auth0 modes are retired (SIG-85): a setting naming one stops the
  // start, rather than quietly running with another way in.
  if (env.AUTH_MODE !== undefined && env.AUTH_MODE !== 'bearer') throw new Error(`AUTH_MODE ${env.AUTH_MODE} isn't supported: use builtin.`);
  return createDirectApp(env);
}

// Direct mode: one shared secret, no sign-in server. It drives the product in
// the test kit and in local development; setup never installs it (installs are
// always builtin, above).
function createDirectApp(env: NodeJS.ProcessEnv) {
  let mail: MailRouter | undefined;
  const getMail = () => mail ??= createMailRouter(loadAccounts(env));
  const allowedHosts = csv(env.ALLOWED_HOSTS);
  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'universal-mail', version: VERSION }));
  const protectedApp = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: allowedHosts.length ? allowedHosts : ['localhost', '127.0.0.1'],
    allowedOrigins: csv(env.ALLOWED_ORIGINS)
  });

  function sameSecret(presented: string | undefined, expected: string | undefined): boolean {
    if (!presented || !expected || expected.length < 24) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function bearer(req: Request, res: Response, next: NextFunction) {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!sameSecret(token, env.MCP_ACCESS_SECRET)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  }

  protectedApp.get('/ready', bearer, async (_req, res) => {
    try {
      const router = getMail();
      const accounts = await Promise.all(router.names.map(async name => ({ name, ...(await router.service(name, 'read').verifyConnectivity()) })));
      res.json({ status: 'ready', accounts });
    }
    catch { res.status(503).json({ status: 'not_ready', error: 'Mail connectivity check failed.' }); }
  });
  const handler = createMcpHandler(() => buildMcpServer(getMail()));
  const node = toNodeHandler(handler);
  protectedApp.all('/mcp', bearer, async (req, res) => { await node(req, res, req.body); });
  app.use(protectedApp);
  // Avoid Express's default error logger, which can expose invalid request bodies.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const status = (error as { status?: number })?.status;
    res.status(status === 400 || status === 413 ? status : 500).json({ error: 'Request could not be processed.' });
  });
  return Object.assign(app, { signin: undefined });
}
