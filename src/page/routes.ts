import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { OwnerAuth } from '../signin/owner.js';
import { PASSKEY_SCRIPT } from '../signin/pages.js';
import { FINGERPRINT_SCRIPT, codeEntryPage, dashboard, signInPage, type AccountView, type AppView } from './views.js';

// Your Universal Mail page (design §3.6), at the server's secret address
// /{key}: sign in with an emailed code or a fingerprint; a session ends after
// 15 minutes idle; every form carries the session's own token.

export const IDLE_MS = 15 * 60_000;

type Session = { owner: string; csrf: string; lastSeen: number };

export type PageDeps = {
  key: string;
  owner: OwnerAuth;
  signInAddress: () => string;
  clock: { now(): number };
  notify(subject: string, text: string): Promise<void>;
  // What the dashboard shows, as it is right now.
  view(): { accounts: AccountView[]; apps: AppView[] };
  // Routes the later slices add, given the same guard, session and helpers.
  extend?(tools: PageTools): void;
};

export type PageTools = {
  base: string;
  post(path: string, handler: (req: Request, res: Response, session: Session) => Promise<void> | void): void;
  // Back to the page, with a message for its next showing.
  back(res: Response, session: Session, message?: { kind: 'ok' | 'error'; text: string }, extra?: { report?: string; problem?: string }): void;
  canGrantSend(session: Session): boolean;
};

export function mountPage(app: Express, deps: PageDeps) {
  const base = `/${deps.key}`;
  const sessions = new Map<string, Session>();
  // A message (or report) for the next time the page is shown in this session.
  const flash = new Map<string, { message?: { kind: 'ok' | 'error'; text: string }; report?: string; problem?: string }>();
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  const json = express.json({ limit: '16kb' });

  const guard = (_req: Request, res: Response, next: () => void) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };

  // The session this browser holds, if it hasn't been idle too long; else a new one.
  const sessionOf = (req: Request, res: Response): [string, Session] => {
    const now = deps.clock.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > IDLE_MS) { sessions.delete(id); flash.delete(id); }
    const id = /(?:^|;\s*)um_page=([A-Za-z0-9_-]+)/.exec(req.header('cookie') ?? '')?.[1];
    const found = id ? sessions.get(id) : undefined;
    if (id && found) { found.lastSeen = now; return [id, found]; }
    const fresh = randomBytes(24).toString('base64url');
    const session: Session = { owner: deps.owner.start(), csrf: randomBytes(24).toString('base64url'), lastSeen: now };
    sessions.set(fresh, session);
    res.setHeader('Set-Cookie', `um_page=${fresh}; HttpOnly; Secure; SameSite=Strict; Path=${base}; Max-Age=${IDLE_MS / 1000}`);
    return [fresh, session];
  };
  // A POST: its session, and a token that matches; else nothing.
  const verified = (req: Request, res: Response): [string, Session] | undefined => {
    const [id, session] = sessionOf(req, res);
    const presented = Buffer.from(String(req.body?.csrf ?? ''));
    const expected = Buffer.from(session.csrf);
    return presented.length === expected.length && timingSafeEqual(presented, expected) ? [id, session] : undefined;
  };
  const signedIn = (s: Session) => deps.owner.level(s.owner) !== 'none';
  const refuse = (res: Response) => res.status(403).send(signInPage(base, deps.signInAddress(), '', false, 'This page expired. Sign in again.'));
  const back = (res: Response, id: string, message?: { kind: 'ok' | 'error'; text: string }, extra: { report?: string; problem?: string } = {}) => {
    flash.set(id, { message, ...extra });
    res.redirect(303, base);
  };

  app.get(base, guard, (req, res) => {
    const [id, session] = sessionOf(req, res);
    if (!signedIn(session)) return res.send(signInPage(base, deps.signInAddress(), session.csrf, deps.owner.hasFingerprint()));
    const shown = flash.get(id) ?? {};
    flash.delete(id);
    res.send(dashboard({ base, csrf: session.csrf, now: deps.clock.now(), ...deps.view(), canGrantSend: deps.owner.level(session.owner) === 'fingerprint', ...shown }));
  });
  app.get(`${base}/passkey.js`, guard, (_req, res) => { res.type('application/javascript').send(PASSKEY_SCRIPT); });
  app.get(`${base}/fingerprint.js`, guard, (_req, res) => { res.type('application/javascript').send(FINGERPRINT_SCRIPT); });

  app.post(`${base}/signin/code`, guard, form, async (req, res) => {
    const found = verified(req, res);
    if (!found) return refuse(res);
    const [, session] = found;
    const sent = await deps.owner.requestCode(session.owner, req.ip ?? 'unknown');
    if (!sent.ok) {
      const text = sent.reason === 'rate_limited' ? 'Too many codes were asked for. Try again in an hour.' : 'The code couldn\'t be emailed. Try again in a few minutes.';
      return res.status(sent.reason === 'rate_limited' ? 429 : 503).send(signInPage(base, deps.signInAddress(), session.csrf, deps.owner.hasFingerprint(), text));
    }
    res.send(codeEntryPage(base, session.csrf));
  });

  app.post(`${base}/signin/verify`, guard, form, (req, res) => {
    const found = verified(req, res);
    if (!found) return refuse(res);
    const [, session] = found;
    const checked = deps.owner.enterCode(session.owner, String(req.body.code ?? ''));
    if (!checked.ok) return res.send(codeEntryPage(base, session.csrf, checked.reason === 'wrong' ? 'That code didn\'t match. Check it and try again.' : 'That code has ended. Ask for a new one.'));
    res.redirect(303, base);
  });

  app.post(`${base}/signin/passkey/options`, guard, form, async (req, res) => {
    const found = verified(req, res);
    if (!found) return refuse(res);
    const started = await deps.owner.beginAuthentication(found[1].owner);
    if (!started.ok) return res.status(400).json({ error: started.reason });
    res.json(started.options);
  });
  app.post(`${base}/signin/passkey/verify`, guard, json, async (req, res) => {
    const found = verified(req, res);
    if (!found) return refuse(res);
    const outcome = await deps.owner.finishAuthentication(found[1].owner, req.body.response);
    if (!outcome.ok) return res.status(403).json({ error: outcome.reason });
    res.json({ ok: true });
  });

  // Adding a fingerprint: from a signed-in session (a second one needs the first).
  app.post(`${base}/fingerprint/options`, guard, form, async (req, res) => {
    const found = verified(req, res);
    if (!found || !signedIn(found[1])) return refuse(res);
    const started = await deps.owner.beginRegistration(found[1].owner);
    if (!started.ok) return res.status(400).json({ error: started.reason });
    res.json(started.options);
  });
  app.post(`${base}/fingerprint/save`, guard, json, async (req, res) => {
    const found = verified(req, res);
    if (!found || !signedIn(found[1])) return refuse(res);
    const outcome = await deps.owner.finishRegistration(found[1].owner, req.body.response);
    if (!outcome.ok) return res.status(403).json({ error: outcome.reason });
    await deps.notify('A fingerprint was added to Universal Mail', 'A fingerprint was added for signing in to your Universal Mail page and approving apps. If this wasn\'t you, remove it on your Universal Mail page and change your sign-in address\'s password.');
    res.json({ ok: true });
  });

  app.post(`${base}/signout`, guard, form, (req, res) => {
    const found = verified(req, res);
    if (!found) return refuse(res);
    sessions.delete(found[0]);
    flash.delete(found[0]);
    res.setHeader('Set-Cookie', `um_page=; HttpOnly; Secure; SameSite=Strict; Path=${base}; Max-Age=0`);
    res.redirect(303, base);
  });

  deps.extend?.({
    base,
    post: (path, handler) => {
      app.post(`${base}${path}`, guard, form, async (req, res) => {
        const found = verified(req, res);
        if (!found || !signedIn(found[1])) return refuse(res);
        await handler(req, res, found[1]);
      });
    },
    back: (res, session, message, extra) => {
      const id = [...sessions].find(([, s]) => s === session)?.[0];
      if (!id) { res.redirect(303, base); return; }
      back(res, id, message, extra);
    },
    canGrantSend: session => deps.owner.level(session.owner) === 'fingerprint'
  });
}
