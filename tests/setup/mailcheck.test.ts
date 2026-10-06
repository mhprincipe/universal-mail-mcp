import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { TLSSocket } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAccount, sendTestEmail, type Endpoints } from '../../src/setup/mailcheck.js';
import { createSetupLog } from '../../src/setup/log.js';
import { createMailCheck } from '../../src/setup/realMail.js';
import { createCanary } from '../../testkit/src/canary.js';
import { startSmtpCapture, type SmtpCapture } from '../../testkit/src/smtpCapture.js';
import { localhostTls as makeLocalhostTls } from '../../testkit/src/localhostTls.js';

// This run's certificate for "localhost": the only one these tests trust.
const localhostTls = await makeLocalhostTls();
const trustLocalhost = { ca: localhostTls.cert, servername: 'localhost' };

// A tiny IMAP server: just enough of the conversation setup has. sent: the
// Message-IDs in its Sent folder, read at the moment of asking. That folder is
// "Posted", flagged \Sent (a name nothing would guess), or, with sentUnflagged,
// a plain "Sent Items" beside it, as a server without special-use flags shows.
// sentAsLiteral: the flagged name is sent as a literal, on a line of its own.
// namedHeadersEmpty: like Yahoo (UNS-12, SET-85), named header lines
// (HEADER.FIELDS) come back empty; the whole header block comes back whole.
type TinyOptions = { password: string; capabilities?: string; folders?: number; starttls?: boolean; sent?: () => string[]; sentUnflagged?: boolean; sentAsLiteral?: boolean; namedHeadersEmpty?: boolean };
async function tinyImap(options: TinyOptions) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const server: Server = createServer(plain => {
    let socket: Socket = plain;
    sockets.add(socket);
    // The client hangs up after signing out; a reset here is expected.
    socket.on('error', () => undefined);
    socket.write('* OK tiny IMAP ready\r\n');
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const line = buffer.slice(0, buffer.indexOf('\r\n'));
        buffer = buffer.slice(buffer.indexOf('\r\n') + 2);
        const [tag, command] = line.split(' ');
        commands.push(command!.toUpperCase());
        if (command === 'STARTTLS' && options.starttls) {
          socket.write(`${tag} OK Begin TLS\r\n`);
          socket.removeListener('data', onData);
          const secure = new TLSSocket(socket, { isServer: true, key: localhostTls.key, cert: localhostTls.cert });
          secure.on('error', () => undefined);
          secure.on('data', onData);
          socket = secure;
          return;
        }
        // Like Yahoo: where encryption is offered, signing in without it is refused.
        if (command === 'LOGIN' && options.starttls && !(socket instanceof TLSSocket)) socket.write(`${tag} NO [PRIVACYREQUIRED] Encryption required\r\n`);
        else if (command === 'LOGIN') socket.write(line.endsWith(` "${options.password}"`) ? `${tag} OK LOGIN completed\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else if (command === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 ${options.capabilities ?? 'MOVE UIDPLUS'}\r\n${tag} OK\r\n`);
        else if (command === 'LIST') {
          for (let i = 0; i < (options.folders ?? 6); i++) socket.write(`* LIST (\\HasNoChildren) "/" "Folder${i}"\r\n`);
          if (options.sent) socket.write(options.sentUnflagged ? '* LIST (\\HasNoChildren) "/" "Sent Items"\r\n'
            : options.sentAsLiteral ? '* LIST (\\HasNoChildren \\Sent) "/" {6}\r\nPosted\r\n' : '* LIST (\\HasNoChildren \\Sent) "/" Posted\r\n');
          socket.write(`${tag} OK LIST completed\r\n`);
        } else if (command === 'EXAMINE' && options.sent && line.endsWith(options.sentUnflagged ? '"Sent Items"' : '"Posted"')) {
          socket.write(`* ${options.sent().length} EXISTS\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        } else if (command === 'FETCH' && options.sent) {
          // Literal header blocks, as a real server sends them.
          const named = line.includes('HEADER.FIELDS');
          options.sent().forEach((id, i) => {
            const header = named && options.namedHeadersEmpty ? '\r\n'
              : named ? `Message-ID: ${id}\r\n\r\n`
              : `From: me@example.invalid\r\nSubject: Universal Mail test\r\nMessage-ID: ${id}\r\nX-Universal-Mail: system\r\n\r\n`;
            socket.write(`* ${i + 1} FETCH (BODY[${named ? 'HEADER.FIELDS (MESSAGE-ID)' : 'HEADER'}] {${header.length}}\r\n${header})\r\n`);
          });
          socket.write(`${tag} OK FETCH completed\r\n`);
        } else if (command === 'LOGOUT') socket.end(`* BYE\r\n${tag} OK\r\n`);
        else socket.write(`${tag} BAD unknown\r\n`);
      }
    };
    socket.on('data', onData);
    plain.on('close', () => sockets.delete(plain));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    commands,
    stop: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); })
  };
}

let stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops) await stop(); stops = []; });

// filedCopies: how many times the "provider" files each email it sends in
// Sent, after three older messages; undefined for no Sent folder at all.
async function world(options: { imapPassword: string; smtpPassword?: string; capabilities?: string; folders?: number; starttls?: boolean; filedCopies?: number; sentUnflagged?: boolean; sentAsLiteral?: boolean; namedHeadersEmpty?: boolean }) {
  let smtp: SmtpCapture | undefined;
  const older = ['<old-1@example.invalid>', '<old-2@example.invalid>', '<old-3@example.invalid>'];
  const sent = options.filedCopies === undefined ? undefined : () => [...older, ...(smtp?.messages ?? []).flatMap(m =>
    Array<string>(options.filedCopies!).fill(/^Message-ID: (.+)$/mi.exec(m.raw.toString('utf8'))![1]!.trim()))];
  const imap = await tinyImap({ password: options.imapPassword, capabilities: options.capabilities, folders: options.folders, starttls: options.starttls, sent, sentUnflagged: options.sentUnflagged, sentAsLiteral: options.sentAsLiteral, namedHeadersEmpty: options.namedHeadersEmpty });
  smtp = await startSmtpCapture({ password: options.smtpPassword ?? options.imapPassword, starttls: options.starttls });
  const home = mkdtempSync(join(tmpdir(), 'mailcheck-'));
  stops.push(imap.stop, smtp.stop, async () => rmSync(home, { recursive: true, force: true }));
  const tls = options.starttls ? 'starttls' as const : 'none' as const;
  const endpoints: Endpoints = {
    imap: { host: '127.0.0.1', port: imap.port, tls },
    smtp: { host: '127.0.0.1', port: smtp.port, tls }
  };
  const log = createSetupLog(home, Date);
  const logText = () => readFileSync(join(home, '.universal-mail', 'setup-log.jsonl'), 'utf8');
  return { endpoints, log, logText, imap, smtp, entries: () => logText().trim().split('\n').map(l => JSON.parse(l)) };
}
const quick = { tries: 3, everyMs: 20 };

describe('the email password check', () => {
  it('SET-68 reading and sending both sign in; folders are counted and safe moves detected (added)', async () => {
    const password = createCanary('app-password');
    const w = await world({ imapPassword: password, folders: 28 });
    w.log.secret(password);
    expect(await checkAccount('me@example.invalid', password, w.endpoints, { log: w.log })).toEqual({ ok: true, folders: 28, safeMove: true });
    expect(w.logText()).not.toContain(password);
    expect(w.logText()).toContain('"reading":"ok"');
    expect(w.logText()).toContain('"sending":"ok"');
  });

  it('SET-68 a server with neither MOVE nor UIDPLUS is reported as unable to move safely', async () => {
    const w = await world({ imapPassword: 'app-password-1', capabilities: 'IDLE' });
    expect(await checkAccount('me@example.invalid', 'app-password-1', w.endpoints, { log: w.log })).toEqual({ ok: true, folders: 6, safeMove: false });
  });

  it('SET-68 a wrong password, for reading or for sending, is rejected, and the log says which', async () => {
    const reading = await world({ imapPassword: 'right-password' });
    expect(await checkAccount('me@example.invalid', 'wrong-password', reading.endpoints, { log: reading.log })).toEqual({ ok: false, reason: 'rejected' });
    expect(reading.logText()).toContain('"reading":"rejected"');

    const sending = await world({ imapPassword: 'right-password', smtpPassword: 'other-password' });
    expect(await checkAccount('me@example.invalid', 'right-password', sending.endpoints, { log: sending.log })).toEqual({ ok: false, reason: 'rejected' });
    expect(sending.logText()).toContain('"sending":"rejected"');
  });

  it('SET-68 nothing listening is "unreachable", reported within the time limit', async () => {
    const w = await world({ imapPassword: 'x-password' });
    const closed = { ...w.endpoints, imap: { host: '127.0.0.1', port: 1, tls: 'none' as const } };
    const started = Date.now();
    expect(await checkAccount('me@example.invalid', 'x-password', closed, { log: w.log, timeoutMs: 2_000 })).toEqual({ ok: false, reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('SET-68 a server that accepts but never answers is "unreachable" within the time limit', async () => {
    const held = new Set<Socket>();
    const silent = createServer(socket => { held.add(socket); socket.on('error', () => undefined); });
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
    stops.push(() => new Promise<void>(resolve => { for (const s of held) s.destroy(); silent.close(() => resolve()); }));
    const w = await world({ imapPassword: 'x-password' });
    const stalled = { ...w.endpoints, imap: { host: '127.0.0.1', port: (silent.address() as AddressInfo).port, tls: 'none' as const } };
    const started = Date.now();
    expect(await checkAccount('me@example.invalid', 'x-password', stalled, { log: w.log, timeoutMs: 1_000 })).toEqual({ ok: false, reason: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('SET-68 STARTTLS, as Yahoo\'s sending server uses: both reading and sending upgrade to encryption and sign in', async () => {
    const w = await world({ imapPassword: 'app-password-2', starttls: true });
    expect(await checkAccount('me@example.invalid', 'app-password-2', w.endpoints, { log: w.log, tls: trustLocalhost })).toEqual({ ok: true, folders: 6, safeMove: true });
  });

  it('SET-68 a certificate that can\'t be trusted is "insecure", not "unreachable"', async () => {
    const w = await world({ imapPassword: 'app-password-3', starttls: true });
    expect(await checkAccount('me@example.invalid', 'app-password-3', w.endpoints, { log: w.log, tls: { servername: 'localhost' } })).toEqual({ ok: false, reason: 'insecure' });
    expect(w.logText()).toContain('"reading":"insecure"');
  });

  it('SET-72 the real MailCheck checks an address against the servers detection found (added)', async () => {
    const w = await world({ imapPassword: 'app-password-4', starttls: true });
    const found = { imap: { ...w.endpoints.imap, host: 'localhost', tls: 'starttls' as const }, smtp: { ...w.endpoints.smtp, host: 'localhost', tls: 'starttls' as const } };
    const mail = createMailCheck({ log: w.log, tls: trustLocalhost, lookups: { resolveMx: async () => [], resolveSrv: async () => [], autoconfig: async () => found } });
    expect(await mail.detect('me@example.invalid')).toBeDefined();
    expect(await mail.check('me@example.invalid', 'app-password-4')).toEqual({ ok: true, folders: 6, safeMove: true });
    expect(await mail.check('me@example.invalid', 'wrong-password')).toEqual({ ok: false, reason: 'rejected' });
  });

  it('SET-73 the sending test counts the copies filed in Sent, opening it read-only (added)', async () => {
    for (const filed of [0, 1, 2] as const) {
      const w = await world({ imapPassword: 'app-password-5', starttls: true, filedCopies: filed });
      expect(await sendTestEmail('me@example.invalid', 'app-password-5', w.endpoints, { log: w.log, tls: trustLocalhost, poll: quick })).toEqual({ copies: filed });
      expect(w.imap.commands).toContain('EXAMINE');
      expect(w.imap.commands).not.toContain('SELECT');
      expect(w.imap.commands).not.toContain('STORE');
      expect(w.entries().find(e => e.op === 'send-test-detail')).toMatchObject({ sending: 'ok', counting: 'ok', sentFolder: 'Posted', copies: filed, polls: filed ? 1 : 3 });
    }
  });

  it('SET-85 the copies in Sent are counted from whole header blocks: a server that answers nothing to named header lines (Yahoo) still shows the one it filed (added: 2.4.6)', async () => {
    const w = await world({ imapPassword: 'app-password-10', filedCopies: 1, namedHeadersEmpty: true });
    expect(await sendTestEmail('me@example.invalid', 'app-password-10', w.endpoints, { log: w.log, poll: quick })).toEqual({ copies: 1 });
  });

  it('SET-73 without special-use flags, Sent is found by its usual name', async () => {
    const w = await world({ imapPassword: 'app-password-8', filedCopies: 1, sentUnflagged: true });
    expect(await sendTestEmail('me@example.invalid', 'app-password-8', w.endpoints, { log: w.log, poll: quick })).toEqual({ copies: 1 });
    expect(w.entries().find(e => e.op === 'send-test-detail')).toMatchObject({ sentFolder: 'Sent Items' });
  });

  it('SET-73 a Sent folder name sent as a literal is read from the line after', async () => {
    const w = await world({ imapPassword: 'app-password-9', filedCopies: 1, sentAsLiteral: true });
    expect(await sendTestEmail('me@example.invalid', 'app-password-9', w.endpoints, { log: w.log, poll: quick })).toEqual({ copies: 1 });
    expect(w.entries().find(e => e.op === 'send-test-detail')).toMatchObject({ sentFolder: 'Posted' });
  });

  it('SET-73 a refused test email says so, in the error and the log; the count is never started', async () => {
    const w = await world({ imapPassword: 'app-password-6', smtpPassword: 'changed-since', filedCopies: 1 });
    await expect(sendTestEmail('me@example.invalid', 'app-password-6', w.endpoints, { log: w.log, poll: quick })).rejects.toThrow('the test email was not sent: rejected');
    expect(w.entries().find(e => e.op === 'send-test-detail')).toMatchObject({ sending: 'rejected' });
    expect(w.imap.commands).not.toContain('LOGIN');
  });

  it('SET-73 no Sent folder at all: none counted, and the log says none was found', async () => {
    const w = await world({ imapPassword: 'app-password-7' });
    expect(await sendTestEmail('me@example.invalid', 'app-password-7', w.endpoints, { log: w.log, poll: quick })).toEqual({ copies: 0 });
    expect(w.entries().find(e => e.op === 'send-test-detail')).toMatchObject({ sending: 'ok', counting: 'ok', sentFolder: null, copies: 0 });
  });

  it('SET-68 an unencrypted connection to anywhere but this machine is refused before connecting', async () => {
    const w = await world({ imapPassword: 'x-password' });
    const remote = { ...w.endpoints, imap: { host: 'imap.example.com', port: 143, tls: 'none' as const } };
    expect(await checkAccount('me@example.invalid', 'x-password', remote, { log: w.log })).toEqual({ ok: false, reason: 'insecure' });
  });
});
