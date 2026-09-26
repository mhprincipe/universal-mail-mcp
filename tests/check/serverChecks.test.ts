import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { runChecks } from '../../src/check/runner.js';
import { serverStages, type CheckableService } from '../../src/check/serverChecks.js';
import { CHECK_CODES } from '../../src/check/codes.js';

// DIA-06 (added): the stages the server runs on itself (design §7.1), against
// fake mail services. Real servers: checkRoute.protocol.test.ts.
const clock = { now: () => Date.parse('2026-09-25T15:02:11Z') };
const facts = { accounts: 2, providers: ['yahoo', 'gmail'] };

// failAt: that live step throws; ignores: that change is "accepted" but never
// happens; unsafeMove: the provider can't move safely (no MOVE or UIDPLUS).
type Behaviour = { connect?: unknown; tool?: unknown; inbox?: number; failAt?: string; ignores?: 'read' | 'unread' | 'flag' | 'unflag' | 'trash'; unsafeMove?: boolean };
type Kept = { uid: number; mailbox: string; messageId: string; read: boolean; flagged: boolean };
// A mail service that records every method called on it, with a small
// mailbox for the live check's test message.
function fakeService(behaviour: Behaviour = {}) {
  const calls: string[] = [];
  const box = new Map<number, Kept>();
  let next = 100;
  const envelope = <T>(data: T) => ({ ok: true, status: 'SUCCESS', code: 'OK', message: 'Success', data });
  const fail = (step: string) => { if (behaviour.failAt === step) throw new MailError('MAIL_OPERATION_FAILED', `the server refused ${step}`); };
  const service = {
    verifyConnectivity: async () => { if (behaviour.connect) throw behaviour.connect; return { imap: true, smtp: true, folders: 6 }; },
    listFolders: async () => envelope([{ path: 'INBOX' }]),
    searchEmail: async (input: { mailbox: string; messageId?: string }) => {
      if (input.messageId) return envelope([...box.values()].filter(m => m.mailbox === input.mailbox && m.messageId === input.messageId));
      if (behaviour.tool) throw behaviour.tool;
      return envelope((behaviour.inbox ?? 1) ? [{ mailbox: 'INBOX', uid: 7 }] : []);
    },
    getEmail: async () => envelope({ uid: 7 }),
    getThread: async () => envelope([{ uid: 7 }]),
    createFolder: async (path: string) => { fail('folder'); return envelope({ path, created: true }); },
    saveCheckMessage: async (folder: string) => {
      fail('save');
      const uid = next++;
      box.set(uid, { uid, mailbox: folder, messageId: '<check-1@check.universal-mail.invalid>', read: false, flagged: false });
      return envelope({ messageId: '<check-1@check.universal-mail.invalid>' });
    },
    markRead: async (_m: string, uid: number) => { fail('read'); if (behaviour.ignores !== 'read') box.get(uid)!.read = true; return envelope({}); },
    markUnread: async (_m: string, uid: number) => { fail('unread'); if (behaviour.ignores !== 'unread') box.get(uid)!.read = false; return envelope({}); },
    flagEmail: async (_m: string, uid: number, flagged: boolean) => {
      fail(flagged ? 'flag' : 'unflag');
      if (behaviour.ignores !== (flagged ? 'flag' : 'unflag')) box.get(uid)!.flagged = flagged;
      return envelope({});
    },
    trashEmail: async (_m: string, uid: number) => {
      if (behaviour.unsafeMove) throw new MailError('SAFE_MOVE_UNAVAILABLE', 'Moving requires MOVE or UIDPLUS to avoid expunging unrelated messages.');
      fail('trash');
      if (behaviour.ignores === 'trash') return envelope({ destination: 'Trash', destinationUid: 999 });
      const kept = box.get(uid)!;
      box.delete(uid);
      const moved = next++;
      box.set(moved, { ...kept, uid: moved, mailbox: 'Trash' });
      return envelope({ destination: 'Trash', destinationUid: moved });
    }
  };
  const recorded = new Proxy(service, { get: (target, name: string) => { const value = (target as any)[name]; return typeof value === 'function' ? (...args: unknown[]) => { calls.push(name); return value(...args); } : value; } });
  return { service: recorded as unknown as CheckableService, calls, box };
}

const account = (name: string, imapHost: string, behaviour: Behaviour = {}, sentCopyMode: 'unverified' | 'yahoo' | 'append' = 'yahoo') => {
  const fake = fakeService(behaviour);
  return { account: { name, imapHost, sentCopyMode, service: fake.service }, calls: fake.calls, box: fake.box };
};
const base = { expectedVersion: '2.0.0', runningVersion: '2.0.0', signinRoundTrip: async () => true };
const summary = (report: Awaited<ReturnType<typeof runChecks>>) => report.stages.map(s => `${s.stage}=${s.status}${s.status === 'FAIL' ? `:${s.code}` : ''}`);

describe('the server\'s own checks', () => {
  it('DIA-06 all passing: server, sign-in, then each account\'s sign-in, read tools and Sent mode, in order (added)', async () => {
    const me = account('me', 'imap.mail.yahoo.com');
    const fleet = account('fleet', 'imap.gmail.com', {}, 'append');
    const report = await runChecks(serverStages({ ...base, accounts: [me.account, fleet.account] }), { version: '2.0.0', clock, facts });
    expect(summary(report)).toEqual([
      'server=PASS', 'signin=PASS',
      'account:me=PASS', 'tools:me=PASS', 'live:me=PASS', 'sent:me=PASS',
      'account:fleet=PASS', 'tools:fleet=PASS', 'live:fleet=PASS', 'sent:fleet=PASS'
    ]);
    expect(me.calls.slice(0, 5)).toEqual(['verifyConnectivity', 'listFolders', 'searchEmail', 'getEmail', 'getThread']);
  });

  it('DIA-09 live: a test message in its own folder is found, marked read and unread, flagged and unflagged, and moved to Trash; each step confirmed (added)', async () => {
    const me = account('me', 'imap.mail.yahoo.com');
    const report = await runChecks(serverStages({ ...base, accounts: [me.account] }), { version: '2.0.0', clock, facts });
    expect(summary(report)).toContain('live:me=PASS');
    const writes = me.calls.slice(5).filter(c => c !== 'searchEmail');
    expect(writes).toEqual(['createFolder', 'saveCheckMessage', 'markRead', 'markUnread', 'flagEmail', 'flagEmail', 'trashEmail']);
    // Each change was looked for afterwards, by the message's ID.
    expect(me.calls.slice(5).filter(c => c === 'searchEmail').length).toBeGreaterThanOrEqual(7);
    // Left behind: the folder, and the test message in Trash; nothing else.
    expect([...me.box.values()].map(m => `${m.mailbox}:${m.read}:${m.flagged}`)).toEqual(['Trash:false:false']);
  });

  it('DIA-09 live: a change the server says it made but didn\'t is caught, and the log names the step', async () => {
    for (const step of ['read', 'unread', 'flag', 'unflag', 'trash'] as const) {
      const me = account('me', 'imap.mail.yahoo.com', { ignores: step });
      const failed: unknown[] = [];
      const report = await runChecks(serverStages({ ...base, accounts: [me.account] }), { version: '2.0.0', clock, facts, onError: (_s, e) => failed.push(e) });
      expect(summary(report), step).toContain('live:me=FAIL:MAIL-WRITE-FAILED');
      expect(report.stages.find(s => s.stage === 'live:me')).toMatchObject({ cause: 'Yahoo Mail didn\'t let Universal Mail change a test message.' });
      expect((failed[0] as Error).message, step).toBe(step);
    }
  });

  it('DIA-09 live: a step the server refuses fails the stage; a provider that can\'t move safely keeps the test message in its folder, and passes', async () => {
    const refused = account('me', 'imap.mail.yahoo.com', { failAt: 'save' });
    expect(summary(await runChecks(serverStages({ ...base, accounts: [refused.account] }), { version: '2.0.0', clock, facts }))).toContain('live:me=FAIL:MAIL-WRITE-FAILED');

    const unsafe = account('me', 'imap.example.org', { unsafeMove: true });
    expect(summary(await runChecks(serverStages({ ...base, accounts: [unsafe.account] }), { version: '2.0.0', clock, facts }))).toContain('live:me=PASS');
    expect([...unsafe.box.values()].map(m => m.mailbox)).toEqual(['Universal Mail check']);
  });

  it('DIA-09 live runs only after the read tools pass', async () => {
    const broken = account('me', 'imap.gmail.com', { tool: new MailError('MAIL_OPERATION_FAILED', 'The mail server operation failed.') });
    const report = await runChecks(serverStages({ ...base, accounts: [broken.account] }), { version: '2.0.0', clock, facts });
    expect(summary(report)).toContain('live:me=NOT_RUN');
    expect(broken.calls).not.toContain('saveCheckMessage');
  });

  it('DIA-06 a different running version fails "server", and nothing else runs', async () => {
    const me = account('me', 'imap.mail.yahoo.com');
    const report = await runChecks(serverStages({ ...base, runningVersion: '1.9.0', accounts: [me.account] }), { version: '2.0.0', clock, facts });
    expect(summary(report)).toEqual(['server=FAIL:SERVER-VERSION-MISMATCH', 'signin=NOT_RUN', 'account:me=NOT_RUN', 'tools:me=NOT_RUN', 'live:me=NOT_RUN', 'sent:me=NOT_RUN']);
    expect(me.calls).toEqual([]);
  });

  it('DIA-06 sign-in that can\'t issue and verify a test token fails "signin"; the accounts still run', async () => {
    const me = account('me', 'imap.mail.yahoo.com');
    for (const signinRoundTrip of [async () => false, async () => { throw new Error('bad key'); }]) {
      const report = await runChecks(serverStages({ ...base, signinRoundTrip, accounts: [me.account] }), { version: '2.0.0', clock, facts });
      expect(summary(report)).toEqual(['server=PASS', 'signin=FAIL:SIGNIN-TEST-FAILED', 'account:me=PASS', 'tools:me=PASS', 'live:me=PASS', 'sent:me=PASS']);
    }
  });

  it('DIA-06 a revoked password, an outage and a refused encryption each get their own code, naming the provider', async () => {
    const cases: Array<[unknown, string]> = [
      [new MailError('AUTH_FAILED', 'Yahoo rejected the mail credentials.'), 'MAIL-APP-PASSWORD-REJECTED'],
      [Object.assign(new Error('Invalid login: 535 5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 }), 'MAIL-APP-PASSWORD-REJECTED'],
      [Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), 'MAIL-UNREACHABLE'],
      [new MailError('SMTP_ENCRYPTION_UNAVAILABLE', 'The mail server wouldn\'t encrypt the connection, so nothing was sent.'), 'MAIL-INSECURE'],
      [Object.assign(new Error('Error upgrading connection with STARTTLS'), { code: 'ETLS' }), 'MAIL-INSECURE']
    ];
    for (const [error, code] of cases) {
      const me = account('me', 'imap.mail.yahoo.com', { connect: error });
      const other = account('other', 'imap.gmail.com');
      const report = await runChecks(serverStages({ ...base, accounts: [me.account, other.account] }), { version: '2.0.0', clock, facts });
      expect(summary(report)).toEqual(['server=PASS', 'signin=PASS', `account:me=FAIL:${code}`, 'tools:me=NOT_RUN', 'live:me=NOT_RUN', 'sent:me=NOT_RUN', 'account:other=PASS', 'tools:other=PASS', 'live:other=PASS', 'sent:other=PASS']);
      expect(report.stages[2]).toMatchObject({ cause: CHECK_CODES[code as keyof typeof CHECK_CODES].cause.replace('{provider}', 'Yahoo Mail') });
    }
  });

  it('DIA-06 a read tool that fails is "MAIL-TOOL-FAILED"; an empty inbox still passes', async () => {
    const broken = account('me', 'imap.gmail.com', { tool: new MailError('MAIL_OPERATION_FAILED', 'The mail server operation failed.') });
    const empty = account('quiet', 'imap.gmail.com', { inbox: 0 });
    const report = await runChecks(serverStages({ ...base, accounts: [broken.account, empty.account] }), { version: '2.0.0', clock, facts });
    expect(summary(report)).toEqual(['server=PASS', 'signin=PASS', 'account:me=PASS', 'tools:me=FAIL:MAIL-TOOL-FAILED', 'live:me=NOT_RUN', 'sent:me=PASS', 'account:quiet=PASS', 'tools:quiet=PASS', 'live:quiet=PASS', 'sent:quiet=PASS']);
    expect(report.stages[3]).toMatchObject({ cause: 'A mail tool didn\'t work as expected with Gmail.' });
    expect(empty.calls.slice(0, 4)).toEqual(['verifyConnectivity', 'listFolders', 'searchEmail', 'createFolder']);
  });

  it('DIA-06 a Sent mode never settled is reported; a provider nobody recognises is "your provider"', async () => {
    const me = account('me', 'mail.example.org', {}, 'unverified');
    const report = await runChecks(serverStages({ ...base, accounts: [me.account] }), { version: '2.0.0', clock, facts });
    expect(summary(report)).toContain('sent:me=FAIL:SENT-MODE-UNKNOWN');
    expect(report.stages.at(-1)).toMatchObject({ cause: 'It isn\'t known yet where your provider keeps the mail you send.' });
    // At the start of a sentence, it's capitalised.
    const down = account('me', 'mail.example.org', { connect: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    const outage = await runChecks(serverStages({ ...base, accounts: [down.account] }), { version: '2.0.0', clock, facts });
    expect(outage.stages[2]).toMatchObject({ cause: 'Your provider\'s mail servers couldn\'t be reached.' });
  });
});
