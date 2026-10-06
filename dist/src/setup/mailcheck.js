import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { systemMessageId } from '../systemMail.js';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
class Unreachable extends Error {
}
class Insecure extends Error {
}
// A line-by-line conversation over a socket, which can switch to TLS midway.
class Conversation {
    socket;
    timeoutMs;
    tls;
    buffer = '';
    waiting = [];
    lines = [];
    failed;
    constructor(socket, timeoutMs, tls = {}) {
        this.socket = socket;
        this.timeoutMs = timeoutMs;
        this.tls = tls;
        this.listen(socket);
    }
    listen(socket) {
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            this.buffer += chunk;
            let at;
            while ((at = this.buffer.indexOf('\r\n')) >= 0) {
                const line = this.buffer.slice(0, at);
                this.buffer = this.buffer.slice(at + 2);
                const waiter = this.waiting.shift();
                if (waiter)
                    waiter(line);
                else
                    this.lines.push(line);
            }
        });
        const fail = () => { this.failed = new Unreachable(); for (const w of this.waiting.splice(0))
            w(''); };
        socket.on('error', fail);
        socket.on('close', fail);
    }
    line() {
        const ready = this.lines.shift();
        if (ready !== undefined)
            return Promise.resolve(ready);
        if (this.failed)
            return Promise.reject(this.failed);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Unreachable()), this.timeoutMs);
            this.waiting.push(line => { clearTimeout(timer); if (this.failed && !line)
                reject(this.failed);
            else
                resolve(line); });
        });
    }
    // Lines until one matches: an IMAP tagged reply, or the last line of an SMTP reply.
    async until(done) {
        const lines = [];
        for (;;) {
            const line = await this.line();
            lines.push(line);
            if (done(line))
                return lines;
        }
    }
    send(text) { this.socket.write(`${text}\r\n`); }
    async upgrade(host) {
        this.socket.removeAllListeners('data');
        const secure = tlsConnect({ socket: this.socket, servername: host, ...this.tls });
        // A failed upgrade is a certificate or encryption problem, not an unreachable server.
        await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', () => reject(new Insecure())); });
        this.socket = secure;
        this.listen(secure);
    }
    close() { this.socket.destroy(); }
}
async function open(endpoint, timeoutMs, tls) {
    if (endpoint.tls === 'none' && !LOOPBACK.has(endpoint.host))
        throw new Insecure();
    const socket = await new Promise((resolve, reject) => {
        const s = endpoint.tls === 'implicit'
            ? tlsConnect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host, ...tls }, () => resolve(s))
            : netConnect({ host: endpoint.host, port: endpoint.port }, () => resolve(s));
        s.once('error', () => reject(new Unreachable()));
        s.setTimeout(timeoutMs, () => { s.destroy(); reject(new Unreachable()); });
    });
    socket.setTimeout(0);
    return new Conversation(socket, timeoutMs, tls);
}
const quoted = (text) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// An IMAP session, signed in: each command gets its own tag, and returns its
// lines up to and including the tagged reply. undefined: the password was refused.
async function imapSession(address, password, endpoint, timeoutMs, tls) {
    const c = await open(endpoint, timeoutMs, tls);
    let n = 0;
    const command = async (text) => {
        const tag = `a${n++}`;
        c.send(`${tag} ${text}`);
        const lines = await c.until(l => l.startsWith(`${tag} `));
        return { lines, ok: lines.at(-1).startsWith(`${tag} OK`) };
    };
    try {
        if (!/^\* (OK|PREAUTH)/.test(await c.line()))
            throw new Unreachable();
        if (endpoint.tls === 'starttls') {
            if (!(await command('STARTTLS')).ok)
                throw new Insecure();
            await c.upgrade(endpoint.host);
        }
        if (!(await command(`LOGIN ${quoted(address)} ${quoted(password)}`)).ok) {
            c.close();
            return undefined;
        }
    }
    catch (error) {
        c.close();
        throw error;
    }
    return { command, close: () => { c.send(`a${n++} LOGOUT`); c.close(); } };
}
async function readMail(address, password, endpoint, timeoutMs, tls) {
    const s = await imapSession(address, password, endpoint, timeoutMs, tls);
    if (!s)
        return { ok: false };
    try {
        const capabilities = (await s.command('CAPABILITY')).lines.filter(l => l.startsWith('* CAPABILITY')).join(' ').toUpperCase().split(/\s+/);
        const folders = (await s.command('LIST "" "*"')).lines.filter(l => l.startsWith('* LIST')).length;
        return { ok: true, folders, safeMove: capabilities.includes('MOVE') || capabilities.includes('UIDPLUS'), capabilities };
    }
    finally {
        s.close();
    }
}
// An SMTP session, signed in. reply() reads one whole reply: it ends at the
// line with a space after the code ("250 OK", not "250-…"). undefined: refused.
async function smtpSession(address, password, endpoint, timeoutMs, tls) {
    const c = await open(endpoint, timeoutMs, tls);
    const reply = async () => (await c.until(l => /^\d{3}( |$)/.test(l))).at(-1);
    try {
        if (!(await reply()).startsWith('220'))
            throw new Unreachable();
        c.send('EHLO universal-mail-setup');
        await reply();
        if (endpoint.tls === 'starttls') {
            c.send('STARTTLS');
            if (!(await reply()).startsWith('220'))
                throw new Insecure();
            await c.upgrade(endpoint.host);
            c.send('EHLO universal-mail-setup');
            await reply();
        }
        c.send(`AUTH PLAIN ${Buffer.from(`\0${address}\0${password}`).toString('base64')}`);
        if (!(await reply()).startsWith('235')) {
            c.send('QUIT');
            c.close();
            return undefined;
        }
    }
    catch (error) {
        c.close();
        throw error;
    }
    return { send: (text) => c.send(text), reply, close: () => { c.send('QUIT'); c.close(); } };
}
async function sendMail(address, password, endpoint, timeoutMs, tls) {
    const s = await smtpSession(address, password, endpoint, timeoutMs, tls);
    s?.close();
    return { ok: Boolean(s) };
}
// ── Step 7's sending test ──────────────────────────────────────────────
// Where providers keep sent mail when the server doesn't flag it \Sent.
const SENT_NAMES = ['sent', 'sent items', 'sent messages', 'sent mail', '[gmail]/sent mail', 'inbox.sent', 'inbox/sent'];
// The newest messages looked at in Sent: the test email is among them if filed.
const NEWEST = 20;
class SendTestFailed extends Error {
}
function testEmail(address, messageId, now) {
    return [
        `From: ${address}`, `To: ${address}`, 'Subject: Universal Mail test', `Date: ${now.toUTCString()}`,
        `Message-ID: ${messageId}`, 'X-Universal-Mail: system', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
        'Universal Mail setup sent this to see where your provider keeps the mail you send.',
        'You can delete it.'
    ].join('\r\n');
}
// A LIST line's attributes and mailbox name; a name sent as a literal is on the next line.
function listed(lines) {
    const found = [];
    lines.forEach((line, i) => {
        const m = /^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)$/i.exec(line);
        if (!m)
            return;
        const raw = m[2].trim();
        const name = /^\{\d+\}$/.test(raw) ? lines[i + 1] ?? ''
            : raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
        found.push({ flags: m[1].toLowerCase(), name });
    });
    return found;
}
async function countInSent(address, password, endpoint, timeoutMs, tls, messageId, poll) {
    const s = await imapSession(address, password, endpoint, timeoutMs, tls);
    if (!s)
        throw new SendTestFailed('rejected');
    try {
        const folders = listed((await s.command('LIST "" "*"')).lines);
        const sent = folders.find(f => f.flags.split(/\s+/).includes('\\sent')) ?? folders.find(f => SENT_NAMES.includes(f.name.toLowerCase()));
        if (!sent)
            return { folder: null, copies: 0, polls: 0 };
        const id = messageId.toLowerCase();
        for (let polls = 1;; polls++) {
            // EXAMINE: read-only, so nothing in Sent is marked read or changed.
            const exists = Math.max(0, ...(await s.command(`EXAMINE ${quoted(sent.name)}`)).lines.map(l => Number(/^\* (\d+) EXISTS/i.exec(l)?.[1] ?? 0)));
            // Whole header blocks (SET-85): Yahoo answers nothing to named lines
            // (HEADER.FIELDS, UNS-12), so a filed copy went uncounted. Only a
            // Message-ID line counts.
            const copies = exists === 0 ? 0 : (await s.command(`FETCH ${Math.max(1, exists - NEWEST + 1)}:${exists} (BODY.PEEK[HEADER])`))
                .lines.filter(l => /^message-id:/i.test(l) && l.toLowerCase().includes(id)).length;
            if (copies || polls >= poll.tries)
                return { folder: sent.name, copies, polls };
            await new Promise(resolve => setTimeout(resolve, poll.everyMs));
        }
    }
    finally {
        s.close();
    }
}
// Sends one test email from the account to itself, then counts the copies the
// provider filed in Sent: 0, Universal Mail must file them; 1, the provider
// does; 2, it filed two. Marked as a system email, so the AI never sees it.
export async function sendTestEmail(address, password, endpoints, options) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const tls = options.tls ?? {};
    const domain = address.split('@')[1];
    const detail = (fields) => options.log.event({ type: 'mail', op: 'send-test-detail', domain, ...fields });
    const reason = (error) => error instanceof SendTestFailed ? error.message : error instanceof Insecure ? 'insecure' : 'unreachable';
    const messageId = systemMessageId();
    try {
        const s = await smtpSession(address, password, endpoints.smtp, timeoutMs, tls);
        if (!s)
            throw new SendTestFailed('rejected');
        try {
            for (const [command, expected] of [[`MAIL FROM:<${address}>`, '250'], [`RCPT TO:<${address}>`, '25'], ['DATA', '354']]) {
                s.send(command);
                const answer = await s.reply();
                if (!answer.startsWith(expected))
                    throw new SendTestFailed(`refused ${answer.slice(0, 3)}`);
            }
            // No line of the test email starts with ".", so none needs dot-stuffing.
            s.send(`${testEmail(address, messageId, new Date())}\r\n.`);
            const accepted = await s.reply();
            if (!accepted.startsWith('250'))
                throw new SendTestFailed(`refused ${accepted.slice(0, 3)}`);
        }
        finally {
            s.close();
        }
    }
    catch (error) {
        detail({ sending: reason(error) });
        throw new Error(`the test email was not sent: ${reason(error)}`);
    }
    try {
        const found = await countInSent(address, password, endpoints.imap, timeoutMs, tls, messageId, options.poll ?? { tries: 8, everyMs: 2_500 });
        const copies = Math.min(found.copies, 2);
        detail({ sending: 'ok', counting: 'ok', sentFolder: found.folder, copies, polls: found.polls });
        return { copies };
    }
    catch (error) {
        detail({ sending: 'ok', counting: reason(error) });
        throw new Error(`the Sent folder could not be read: ${reason(error)}`);
    }
}
// tls: extra TLS options, such as a certificate authority to trust (tests;
// perhaps a company's own mail server). Certificates are always checked.
export async function checkAccount(address, password, endpoints, options) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const domain = address.split('@')[1];
    const outcome = (error) => (error instanceof Insecure ? 'insecure' : 'unreachable');
    let reading;
    const tls = options.tls ?? {};
    try {
        reading = await readMail(address, password, endpoints.imap, timeoutMs, tls);
    }
    catch (error) {
        options.log.event({ type: 'mail', op: 'check-detail', domain, reading: outcome(error) });
        return { ok: false, reason: outcome(error) };
    }
    if (!reading.ok) {
        options.log.event({ type: 'mail', op: 'check-detail', domain, reading: 'rejected' });
        return { ok: false, reason: 'rejected' };
    }
    let sending;
    try {
        sending = await sendMail(address, password, endpoints.smtp, timeoutMs, tls);
    }
    catch (error) {
        options.log.event({ type: 'mail', op: 'check-detail', domain, reading: 'ok', sending: outcome(error) });
        return { ok: false, reason: outcome(error) };
    }
    options.log.event({ type: 'mail', op: 'check-detail', domain, reading: 'ok', sending: sending.ok ? 'ok' : 'rejected', folders: reading.folders, capabilities: reading.capabilities });
    if (!sending.ok)
        return { ok: false, reason: 'rejected' };
    return { ok: true, folders: reading.folders, safeMove: reading.safeMove };
}
//# sourceMappingURL=mailcheck.js.map