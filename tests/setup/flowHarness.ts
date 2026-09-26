import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup, type MailCheck, type SetupDeps } from '../../src/setup/flow.js';
import { createSetupLog } from '../../src/setup/log.js';
import { createProgressStore } from '../../src/setup/progress.js';
import { createUi } from '../../src/setup/ui.js';
import { profiles } from '../../src/providers.js';
import { render, type MessageCode } from '../../src/setup/messages.js';
import { createFakeGoogle, type FakeGoogleOptions } from '../../testkit/src/fakeGoogle.js';
import { createCanary } from '../../testkit/src/canary.js';

export const IMAGE = 'us-docker.pkg.dev/universal-mail/release/server@sha256:2f00';
export const NEW_IMAGE = 'us-docker.pkg.dev/universal-mail/release/server@sha256:3a11';

// failing: the first `times` checks fail for a reason other than the password.
export type FakeAccount = { provider: 'yahoo' | 'gmail' | 'fastmail'; password: string; folders?: number; safeMove?: boolean; copies?: 0 | 1 | 2; failing?: { reason: 'unreachable' | 'insecure'; times: number } };
// The real launch profiles: detection itself is tested in providers.test.ts.
const PROVIDERS = Object.fromEntries(profiles.map(p => [p.id, p])) as Record<FakeAccount['provider'], (typeof profiles)[number]>;

// A whole setup world: Google, mail, time, a home folder, and a person
// answering prompts from a script.
// selfTest.failingImage: a server started from this image fails its check (Update's rollback).
export function createWorld(options: { google?: FakeGoogleOptions; accounts?: Record<string, FakeAccount>; selfTest?: { failing?: string; failingImage?: string }; cloudShell?: boolean; image?: string } = {}) {
  let now = Date.parse('2026-09-25T10:00:00Z');
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const fake = createFakeGoogle({ trustedImages: [IMAGE, NEW_IMAGE], clock, ...options.google });
  // The image this run of setup installs; a later run can bring a newer one (Update).
  let image = options.image ?? IMAGE;
  const accounts: Record<string, FakeAccount> = options.accounts ?? {
    'me@yahoo.com': { provider: 'yahoo', password: createCanary('yahoo-password'), folders: 28, copies: 1 },
    'fleet@gmail.com': { provider: 'gmail', password: createCanary('gmail-password'), folders: 9, copies: 1 }
  };
  // Every call to Google and every mail check, in order.
  const events: string[] = [];
  const mail: MailCheck = {
    detect: async address => {
      events.push(`detect ${address}`);
      const account = accounts[address];
      return account ? { provider: PROVIDERS[account.provider] } : undefined;
    },
    check: async (address, password) => {
      events.push(`check ${address}`);
      const account = accounts[address]!;
      if (account.failing && account.failing.times > 0) { account.failing.times--; return { ok: false, reason: account.failing.reason }; }
      return password === account.password ? { ok: true, folders: account.folders ?? 10, safeMove: account.safeMove ?? true } : { ok: false, reason: 'rejected' };
    },
    sendTest: async address => { events.push(`sendTest ${address}`); return { copies: accounts[address]!.copies ?? 1 }; }
  };
  const home = mkdtempSync(join(tmpdir(), 'setup-home-'));
  let screen = '';
  const asked: Array<{ code: MessageCode; hidden: boolean }> = [];
  let script: string[] = [];
  let unscripted = 0;
  const selfTests: string[] = [];

  const deps = (): SetupDeps => ({
    google: new Proxy(fake.google, { get: (target, name: string) => (...args: unknown[]) => { events.push(`google ${name}`); return (target as any)[name](...args); } }),
    mail, clock, version: '2.0.0', image, isCloudShell: options.cloudShell ?? true,
    ui: createUi({ write: text => { screen += text; } }),
    // A prompt shows its text, then takes the next scripted answer (Enter if
    // none). A loop that keeps asking after the script ran out would spin
    // forever without yielding to the test timer, so it fails fast, by name.
    ask: async (code, values, opts) => {
      asked.push({ code, hidden: Boolean(opts?.hidden) });
      screen += `${render(code, values)}\n`;
      if (script.length) { unscripted = 0; return script.shift()!; }
      if (++unscripted > 25) throw new Error(`stuck: '${code}' keeps being asked after the script ran out`);
      return '';
    },
    progress: createProgressStore(home),
    log: createSetupLog(home, clock),
    // Checks the server as it really is: with the settings and passwords it
    // read when it started, as the real check does. A password the provider
    // no longer accepts, or a Sent mode still unknown, fails its stage.
    selfTest: async target => {
      selfTests.push(target.url);
      events.push('selfTest');
      const server = fake.state.server;
      const loaded = JSON.parse(server?.loadedState ?? '{"accounts":[]}') as { accounts: Array<{ name: string; email: string; sentCopyMode: string }> };
      const passwords = (JSON.parse(server?.loadedCredentials ?? '{}') as { passwords?: Record<string, string> }).passwords ?? {};
      type Stage = { stage: string; status: 'PASS' | 'FAIL' | 'NOT_RUN'; code?: string; cause?: string };
      const stages: Stage[] = [{ stage: 'server', status: 'PASS' }, { stage: 'signin', status: 'PASS' }];
      for (const a of loaded.accounts) {
        const accepted = passwords[a.name] === accounts[a.email]?.password;
        stages.push(accepted ? { stage: `account:${a.name}`, status: 'PASS' }
          : { stage: `account:${a.name}`, status: 'FAIL', code: 'MAIL-APP-PASSWORD-REJECTED', cause: 'Your provider no longer accepts the app password.' });
        stages.push(!accepted ? { stage: `sent:${a.name}`, status: 'NOT_RUN' }
          : a.sentCopyMode === 'unverified' ? { stage: `sent:${a.name}`, status: 'FAIL', code: 'SENT-MODE-UNKNOWN', cause: 'It isn\'t known yet where your provider keeps the mail you send.' }
          : { stage: `sent:${a.name}`, status: 'PASS' });
      }
      if (options.selfTest?.failing || (server && server.image === options.selfTest?.failingImage)) {
        stages.push({ stage: 'apps', status: 'FAIL', code: 'CHECK-UNEXPECTED', cause: options.selfTest?.failing ?? 'Something unexpected went wrong during this check.' });
      }
      const failed = stages.find(s => s.status === 'FAIL');
      return {
        passed: stages.filter(s => s.status === 'PASS').length, total: stages.length,
        stages: stages.map(({ cause: _cause, ...s }) => s),
        ...(failed ? { failing: failed.cause } : {})
      };
    }
  });

  return {
    fake, accounts, events, home, asked, selfTests, clock,
    screen: () => screen,
    // The screen as flowing text: a phrase wrapped across lines still matches.
    text: () => screen.replace(/\s+/g, ' '),
    clearScreen: () => { screen = ''; },
    // A newer release of setup, with its own image.
    useImage: (next: string) => { image = next; },
    // Cloud Shell cleared its home folder (months away): no progress file, no log.
    clearHome: () => rmSync(join(home, '.universal-mail'), { recursive: true, force: true }),
    // The setup log, as its entries.
    logEntries: (): Array<Record<string, unknown>> => readFileSync(join(home, '.universal-mail', 'setup-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)),
    // The person's answers, in order; anything unscripted is Enter.
    answers: (...lines: string[]) => { script = lines; },
    run: () => runSetup(deps()),
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

// The usual answers: two addresses, then each password; Enter for the rest.
export const typical = (w: ReturnType<typeof createWorld>) =>
  w.answers('me@yahoo.com', 'fleet@gmail.com', '', w.accounts['me@yahoo.com']!.password, '', w.accounts['fleet@gmail.com']!.password, '');
