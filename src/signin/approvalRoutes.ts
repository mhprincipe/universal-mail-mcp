import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { MailRouter } from '../multiMail.js';
import type { AuthorizationServer, PendingRequest } from './authorization.js';
import { createSigninCodes, formatCode } from './codes.js';
import type { AccountGrant, Action, GrantStore } from './grants.js';
import type { WebAuthnCredential } from '@simplewebauthn/server';
import { createOwnerAuth } from './owner.js';
import { PASSKEY_SCRIPT, codePage, errorPage, permissionsPage, startPage, type AppShown } from './pages.js';
import type { Refusals } from './refusals.js';

// The server's own emails: sent and filed through an account, never via a tool.
export type SystemMail = {
  send(account: string, to: string, subject: string, text: string): Promise<string>;
  discard(account: string, messageId: string): Promise<void>;
};

type Flow = { request: PendingRequest; app: AppShown; owner: string; csrf: string; expires: number };

const FLOW_MS = 15 * 60_000;
const ACTIONS: Action[] = ['read', 'organize', 'send'];

export function mountApproval(app: Express, options: {
  issuer: string; auth: AuthorizationServer & { grants: GrantStore }; getMail: () => MailRouter;
  signInAddress: string; system: SystemMail; clock: { now(): number }; refusals: Refusals;
  fingerprints?: WebAuthnCredential[]; onFingerprintsChange?: (fingerprints: WebAuthnCredential[]) => void;
}) {
  const { auth, clock, system, signInAddress } = options;
  const flows = new Map<string, Flow>();
  // The sign-in account sends first; any other working account after it.
  const senders = () => {
    const mail = options.getMail();
    const own = mail.names.find(name => mail.service(name, 'read').address.toLowerCase() === signInAddress.toLowerCase());
    return own ? [own, ...mail.names.filter(n => n !== own)] : mail.names;
  };
  // Which email carried which code, so a used code's email can be filed away.
  const codeEmails = new Map<string, { account: string; messageId: string }>();
  const codes = createSigninCodes({
    clock, signInAddress, senders,
    send: async (account, to, code) => {
      const messageId = await system.send(account, to, `Your Universal Mail code: ${formatCode(code)}`,
        `Your code is ${formatCode(code)}. It works once, for 10 minutes.\n\nSomeone is trying to connect an AI app to your mail or sign in to your Universal Mail page. If you didn't just do this yourself, ignore this email and never share the code.`);
      codeEmails.set(code, { account, messageId });
    }
  });
  const owner = createOwnerAuth({
    rpId: new URL(options.issuer).hostname, origin: options.issuer, codes,
    fingerprints: options.fingerprints, onFingerprintsChange: options.onFingerprintsChange
  });

  const notify = async (subject: string, text: string) => {
    for (const account of senders()) {
      try { await system.send(account, signInAddress, subject, text); return; } catch { /* next account */ }
    }
  };

  const form = express.urlencoded({ extended: false, limit: '16kb' });
  // Every approval response: never framed, never cached, never leaks a referrer.
  const guard = (req: Request, res: Response, next: () => void) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };

  // The flow a POST belongs to: its cookie, and a CSRF token that matches.
  const flowOf = (req: Request): Flow | undefined => {
    const id = /(?:^|;\s*)um_flow=([A-Za-z0-9_-]+)/.exec(req.header('cookie') ?? '')?.[1];
    const flow = id ? flows.get(id) : undefined;
    const presented = Buffer.from(String(req.body?.csrf ?? ''));
    const expected = Buffer.from(flow?.csrf ?? '');
    if (!flow || flow.expires < clock.now() || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
    return flow;
  };
  const refuse = (res: Response) => (options.refusals.record('csrf'), res.status(403)).send(errorPage('This page expired or was opened somewhere else. Start again from your app.'));

  app.get('/authorize', guard, async (req, res) => {
    const begun = await auth.begin(Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, typeof v === 'string' ? v : undefined])));
    if (!begun.ok) {
      options.refusals.record(begun.error, typeof req.query.client_id === 'string' ? req.query.client_id : undefined);
      if (begun.redirect) return res.redirect(302, begun.redirect);
      return res.status(400).send(errorPage("This app couldn't be verified, so it can't connect."));
    }
    for (const [id, f] of flows) if (f.expires < clock.now()) flows.delete(id);
    const id = randomBytes(24).toString('base64url');
    const flow: Flow = {
      request: begun.request, owner: owner.start(), csrf: randomBytes(24).toString('base64url'), expires: clock.now() + FLOW_MS,
      app: { name: begun.request.clientName ?? new URL(begun.request.clientId).host, origin: new URL(begun.request.clientId).origin }
    };
    flows.set(id, flow);
    res.setHeader('Set-Cookie', `um_flow=${id}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=${FLOW_MS / 1000}`);
    res.send(startPage(flow.app, signInAddress, flow.csrf, owner.hasFingerprint()));
  });

  // A fingerprint instead of a code (SIG-65): the ceremony's two halves.
  app.get('/authorize/passkey.js', guard, (_req, res) => { res.type('application/javascript').send(PASSKEY_SCRIPT); });
  app.post('/authorize/passkey/options', guard, form, async (req, res) => {
    const flow = flowOf(req);
    if (!flow) return refuse(res);
    const started = await owner.beginAuthentication(flow.owner);
    if (!started.ok) return res.status(400).json({ error: started.reason });
    res.json(started.options);
  });
  app.post('/authorize/passkey/verify', guard, express.json({ limit: '16kb' }), async (req, res) => {
    const flow = flowOf(req);
    if (!flow) return refuse(res);
    const verified = await owner.finishAuthentication(flow.owner, req.body.response);
    if (!verified.ok) {
      options.refusals.record('fingerprint_invalid', flow.request.clientId);
      return res.status(403).send(errorPage("That fingerprint didn't match. Try again, or use an emailed code."));
    }
    res.send(permissionsPage(flow.app, options.getMail().names, true, flow.csrf));
  });

  app.post('/authorize/code', guard, form, async (req, res) => {
    const flow = flowOf(req);
    if (!flow) return refuse(res);
    const sent = await owner.requestCode(flow.owner, req.ip ?? 'unknown');
    if (!sent.ok) {
      if (sent.reason === 'rate_limited') return res.status(429).send(errorPage('Too many codes were asked for. Try again in an hour.'));
      return res.status(503).send(errorPage("The code couldn't be emailed. Check your accounts on your Universal Mail page."));
    }
    res.send(codePage(flow.app, flow.csrf));
  });

  app.post('/authorize/verify', guard, form, async (req, res) => {
    const flow = flowOf(req);
    if (!flow) return refuse(res);
    const entered = String(req.body.code ?? '');
    const checked = owner.enterCode(flow.owner, entered);
    if (!checked.ok) {
      const message = checked.reason === 'wrong' ? "That code didn't match. Check it and try again." : 'That code has ended. Start again from your app.';
      return res.send(codePage(flow.app, flow.csrf, message));
    }
    // The code email has done its job: file it in Trash.
    const typed = entered.toUpperCase().replace(/[\s-]/g, '');
    const email = codeEmails.get(typed);
    codeEmails.delete(typed);
    if (email) await system.discard(email.account, email.messageId).catch(() => undefined);
    res.send(permissionsPage(flow.app, options.getMail().names, owner.level(flow.owner) === 'fingerprint', flow.csrf));
  });

  app.post('/authorize/approve', guard, form, async (req, res) => {
    const flow = flowOf(req);
    if (!flow) return refuse(res);
    const names = options.getMail().names;
    const grant: AccountGrant = {};
    for (const name of names) {
      const actions = ACTIONS.filter(action => req.body[`${name}:${action}`] === 'on');
      if (actions.length) grant[name] = actions;
    }
    const allowed = owner.mayGrant(flow.owner, grant);
    if (!allowed.ok || !Object.keys(grant).length) {
      const message = !allowed.ok && allowed.reason === 'fingerprint_required' ? 'Sending needs your fingerprint.' : 'Choose at least one account.';
      return res.send(permissionsPage(flow.app, names, owner.level(flow.owner) === 'fingerprint', flow.csrf, message));
    }
    const redirect = await auth.approve(flow.request, grant);
    for (const [id, f] of flows) if (f === flow) flows.delete(id);
    await notify(`${flow.app.name} is now connected to your email`,
      `${flow.app.name} (${new URL(flow.app.origin).host}) can now use: ${Object.entries(grant).map(([a, acts]) => `${a} (${acts.join(', ')})`).join('; ')}.\n\nIf this wasn't you, disconnect it on your Universal Mail page.`);
    res.redirect(302, redirect);
  });

  app.post('/authorize/deny', guard, form, (req, res) => {
    const flow = flowOf(req);
    if (!flow) return refuse(res);
    for (const [id, f] of flows) if (f === flow) flows.delete(id);
    const url = new URL(flow.request.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (flow.request.state) url.searchParams.set('state', flow.request.state);
    url.searchParams.set('iss', options.issuer);
    res.redirect(302, url.href);
  });

  // Disconnecting takes effect on the next request, and the owner is told.
  const disconnect = async (appId: string) => {
    const grant = auth.grants.get(appId);
    auth.grants.disconnect(appId);
    const name = grant?.appName ?? new URL(appId).host;
    await notify(`${name} was disconnected from your email`, `${name} can no longer use your email. Reconnecting will need your approval again.`);
  };
  return { disconnect, owner, notify };
}
