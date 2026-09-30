import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import express from 'express';
import { loadAccounts } from './accountsConfig.js';
import { csv } from './config.js';
import { createMailRouter } from './multiMail.js';
import { createSigninApp } from './signin/server.js';
import { CREDENTIALS_SECRET_NAME, STATE_SECRET_NAME, createInstallStore, readInstalled } from './installed.js';
import { createSecretWriter } from './secretWriter.js';
import { createMailCheck } from './setup/realMail.js';
// The server's own log for the mail checks it runs from your page: one JSON
// line per event (secrets are never passed to it).
const serverLog = { secret: () => undefined, event: (event) => console.log(JSON.stringify({ event: 'mail_check', ...event })) };
import { buildMcpServer } from './tools.js';
import { VERSION } from './version.js';
// A server that can't serve yet: healthy while it waits for its address,
// unhealthy when its settings are wrong. Nothing else answers.
function holdingApp(health, status) {
    const app = express();
    app.get('/health', (_req, res) => res.status(health).json({ status }));
    app.use((_req, res) => res.status(503).json({ error: 'not_ready' }));
    return Object.assign(app, { signin: undefined });
}
// Installed by setup: everything comes from the two saved records (design §6.3).
function createInstalledApp(env, deps) {
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
export function createApp(env = process.env, deps = {}) {
    if (env.UNIVERSAL_MAIL_STATE !== undefined || env.UNIVERSAL_MAIL_CREDENTIALS !== undefined)
        return createInstalledApp(env, deps);
    if (env.AUTH_MODE === 'builtin')
        return createSigninApp(env);
    // The shared-secret test mode is never a default (SIG-86): it runs only when
    // chosen by name. v1's Auth0 modes are retired (SIG-85). Anything else stops
    // the start, rather than quietly running with another way in.
    if (env.AUTH_MODE === 'bearer')
        return createDirectApp(env);
    throw new Error(env.AUTH_MODE ? `AUTH_MODE ${env.AUTH_MODE} isn't supported: use builtin.` : 'AUTH_MODE must be chosen: builtin (what setup installs) or bearer (tests and local development).');
}
// Direct mode: one shared secret, no sign-in server. It drives the product in
// the test kit and in local development; setup never installs it (installs are
// always builtin, above).
function createDirectApp(env) {
    let mail;
    const getMail = () => mail ??= createMailRouter(loadAccounts(env));
    const allowedHosts = csv(env.ALLOWED_HOSTS);
    const app = express();
    app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'universal-mail', version: VERSION }));
    const protectedApp = createMcpExpressApp({
        host: '0.0.0.0',
        allowedHosts: allowedHosts.length ? allowedHosts : ['localhost', '127.0.0.1'],
        allowedOrigins: csv(env.ALLOWED_ORIGINS)
    });
    function sameSecret(presented, expected) {
        if (!presented || !expected || expected.length < 24)
            return false;
        const a = Buffer.from(presented);
        const b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
    }
    function bearer(req, res, next) {
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
            const accounts = await Promise.all(router.names.map(async (name) => ({ name, ...(await router.service(name, 'read').verifyConnectivity()) })));
            res.json({ status: 'ready', accounts });
        }
        catch {
            res.status(503).json({ status: 'not_ready', error: 'Mail connectivity check failed.' });
        }
    });
    const handler = createMcpHandler(() => buildMcpServer(getMail()));
    const node = toNodeHandler(handler);
    protectedApp.all('/mcp', bearer, async (req, res) => { await node(req, res, req.body); });
    app.use(protectedApp);
    // Avoid Express's default error logger, which can expose invalid request bodies.
    app.use((error, _req, res, _next) => {
        if (res.headersSent) {
            res.end();
            return;
        }
        const status = error?.status;
        res.status(status === 400 || status === 413 ? status : 500).json({ error: 'Request could not be processed.' });
    });
    return Object.assign(app, { signin: undefined });
}
//# sourceMappingURL=app.js.map