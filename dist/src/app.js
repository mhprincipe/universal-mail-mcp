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
import { loadOAuthConfig, createTokenVerifier, requiredScopes } from './oauth.js';
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
    const oauth = loadOAuthConfig(env);
    const verifyToken = oauth?.AUTH_MODE === 'oauth' ? createTokenVerifier(oauth) : undefined;
    const metadataUrl = oauth ? new URL('/.well-known/oauth-protected-resource/mcp', oauth.OAUTH_RESOURCE).href : '';
    let mail;
    const getMail = () => mail ??= createMailRouter(loadAccounts(env));
    const allowedHosts = csv(env.ALLOWED_HOSTS);
    const app = express();
    app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'yahoo-mail-mcp', version: '0.1.0' }));
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
    // Discovery carries no credentials and must stay reachable from a browser
    // origin, so it sits beside /health rather than behind Host/Origin validation.
    // offline_access is advertised because access tokens are capped at 900 seconds.
    if (oauth) {
        app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json({
            resource: oauth.OAUTH_RESOURCE, authorization_servers: [oauth.OAUTH_ISSUER],
            scopes_supported: ['mail.read', 'mail.write', 'mail.send', 'offline_access'], bearer_methods_supported: ['header']
        }));
    }
    async function bearer(req, res, next) {
        // Discovery is public during setup; no credential can unlock mailbox access.
        if (oauth?.AUTH_MODE === 'oauth-setup') {
            res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="mail.read"`);
            res.status(401).json({ error: 'unauthorized' });
            return;
        }
        const header = req.header('authorization');
        const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        if (verifyToken) {
            let scopes;
            try {
                scopes = (await verifyToken(token ?? '')).scopes;
            }
            catch (error) {
                // Reason only: which check failed, never a token or claim value.
                console.log(JSON.stringify({ event: 'token_rejected', reason: error?.reason ?? 'unknown' }));
                res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="mail.read"`);
                res.status(401).json({ error: 'unauthorized' });
                return;
            }
            if (Array.isArray(req.body)) {
                res.status(400).json({ error: 'Batch requests are not supported' });
                return;
            }
            let needed = ['mail.read'];
            if (req.body?.method === 'tools/call') {
                try {
                    needed = requiredScopes(req.body?.params?.name);
                }
                catch {
                    res.status(400).json({ error: 'Unknown tool' });
                    return;
                }
            }
            if (needed.some(scope => !scopes.includes(scope))) {
                res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", resource_metadata="${metadataUrl}", scope="${needed.join(' ')}"`);
                res.status(403).json({ error: 'insufficient_scope' });
                return;
            }
            next();
            return;
        }
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
    const handler = createMcpHandler(() => buildMcpServer(getMail(), !!oauth));
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