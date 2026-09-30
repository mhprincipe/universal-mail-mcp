import { phase, timedClient } from '../timing.js';
import { cautionsFor } from '../cautions.js';
import { ImapFlow } from 'imapflow';
import { imapTransport } from '../config.js';
import { MailError, classify, isTransient, mutationFailure } from '../errors.js';
import { isSystemMessageId } from '../systemMail.js';
import { unsubscribeKind } from '../unsubscribe.js';
// How many of a folder's newest messages a missed Message-ID search checks.
// A message just moved or saved has the folder's highest UID, so it's among them.
const RECENT_SCAN = 200;
const DAY_MS = 24 * 60 * 60_000;
// One connection per account, kept and reused (ENG-18: in the owner's live
// baseline a new connection and login cost ~3.3 s on every call). One call
// at a time uses it. After a pause it's checked before use; after a failure
// that isn't the mail's own refusal, it's closed and never reused.
// Two minutes (ENG-26, measured live): the check cost Yahoo about a second,
// people often pause longer than 30 s, and a connection the server has closed
// is known without asking (it isn't `usable`).
const CHECK_AFTER_IDLE_MS = 120_000;
const NOOP_TIMEOUT_MS = 5_000;
// One address from an envelope. A "name" that is only the address again (as
// Yahoo lists it) is no name (POL-15, found live), so a search and get_email
// show the same.
const person = (x) => {
    const name = x.name?.trim();
    return name && name.toLowerCase() !== x.address.toLowerCase() ? { name, address: x.address } : { address: x.address };
};
// Header lines as the server sends them (any case, folded over lines), by
// lowercase name; the first of each wins.
export function headerValues(raw) {
    const values = {};
    for (const line of (raw?.toString('utf8') ?? '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        values[name] ??= line.slice(colon + 1).trim();
    }
    return values;
}
// The attachments a message's structure shows (FND-01), by name: parts sent
// as attachments, and named ones without a content id (a picture a newsletter
// shows in its text has one). An attached email counts as one, not its insides.
function attachmentsIn(root) {
    if (!root)
        return undefined;
    const names = [];
    const walk = (part) => {
        const type = String(part?.type ?? '').toLowerCase();
        if (Array.isArray(part?.childNodes) && part.childNodes.length && type !== 'message/rfc822') {
            part.childNodes.forEach(walk);
            return;
        }
        const filename = part?.dispositionParameters?.filename ?? part?.parameters?.name;
        if (String(part?.disposition ?? '').toLowerCase() === 'attachment' || (filename && !part?.id))
            names.push(filename ?? `(unnamed ${type})`);
    };
    walk(root);
    return names.length ? names : undefined;
}
// A page reads candidates 50 at a time when it checks them itself, and looks
// at 1,000 at most (FND-03).
const FILTERED_BATCH = 50;
const MAX_EXAMINED = 1000;
const withCautions = (from, replyTo) => {
    const cautions = cautionsFor({ from, replyTo });
    return cautions.length ? { cautions } : {};
};
export class ImapGateway {
    config;
    options;
    session;
    turn = Promise.resolve();
    clock;
    constructor(config, options = {}) {
        this.config = config;
        this.options = options;
        this.clock = options.clock ?? Date;
    }
    client() {
        if (this.options.createClient)
            return this.options.createClient();
        const c = new ImapFlow({
            host: this.config.IMAP_HOST,
            port: this.config.IMAP_PORT,
            ...imapTransport(this.config),
            auth: { user: this.config.MAIL_ADDRESS, pass: this.config.MAIL_APP_PASSWORD },
            logger: false
        });
        c.on('error', () => undefined);
        return c;
    }
    // Calls take turns: one IMAP connection has one selected folder at a time.
    run(fn) {
        const mine = phase('imap.wait', () => this.turn).then(() => this.runNow(fn));
        this.turn = mine.catch(() => undefined);
        return mine;
    }
    async runNow(fn) {
        const client = await this.connection();
        try {
            const value = await fn(client);
            this.session = { client, lastUsed: this.clock.now() };
            return value;
        }
        catch (error) {
            // The mail's own refusal says nothing about the connection; anything
            // else leaves its state unknown, so it's never handed out again.
            if (error instanceof MailError)
                this.session = { client, lastUsed: this.clock.now() };
            else
                this.drop(client);
            throw error;
        }
    }
    async connection() {
        const kept = this.session;
        if (kept?.client.usable) {
            if (this.clock.now() - kept.lastUsed < CHECK_AFTER_IDLE_MS)
                return kept.client;
            if (await this.answers(kept.client))
                return kept.client;
        }
        if (kept)
            this.drop(kept.client);
        // Each command it sends is timed, for the tool's log line (DIA-13).
        const client = timedClient(this.client(), 'imap');
        await client.connect();
        this.session = { client, lastUsed: this.clock.now() };
        return client;
    }
    // To read a folder. One already open for changes serves reads too (ENG-27,
    // measured live): reads only ever peek (BODY.PEEK), and opening it again
    // read-only cost Yahoo 0.4-1 s after every change. Otherwise it's opened
    // read-only, as before.
    openToRead(client, path) {
        const open = client.mailbox;
        if (open && open.path === path && !open.readOnly)
            return client.getMailboxLock(path);
        return client.getMailboxLock(path, { readOnly: true });
    }
    // A kept connection after a pause: does the server still answer, promptly?
    async answers(client) {
        let timer;
        const late = new Promise(resolve => { timer = setTimeout(() => resolve(false), this.options.noopTimeoutMs ?? NOOP_TIMEOUT_MS); });
        try {
            return await Promise.race([client.noop().then(() => true, () => false), late]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    drop(client) {
        if (this.session?.client === client)
            this.session = undefined;
        try {
            client.close();
        }
        catch { /* already gone */ }
    }
    // Logs out of the kept connection (tests, and a server shutting down).
    async close() {
        await this.turn;
        const kept = this.session;
        this.session = undefined;
        if (kept) {
            try {
                await kept.client.logout();
            }
            catch { /* best effort */ }
        }
    }
    async read(fn) {
        try {
            return await this.run(fn);
        }
        catch (error) {
            if (!isTransient(error))
                throw classify(error);
            return await this.run(fn).catch(e => { throw classify(e); });
        }
    }
    // A bulk archive resolved the special folder and validated the destination
    // from two separate LIST round trips per message. Folder layout changes
    // rarely, so a short cache removes that without risking a stale destination;
    // createFolder clears it so a new folder is usable immediately.
    folders;
    static folderTtlMs = 30_000;
    async listFolders() {
        if (this.folders && Date.now() - this.folders.at < ImapGateway.folderTtlMs)
            return this.folders.value;
        const value = await this.read(async (client) => (await client.list()).map(m => ({
            path: m.path,
            specialUse: m.specialUse || undefined,
            selectable: !m.flags.has('\\Noselect'),
            delimiter: m.delimiter || undefined
        })));
        this.folders = { at: Date.now(), value };
        return value;
    }
    async specialFolders() {
        const list = (await this.listFolders()).filter(m => m.selectable);
        const bySpecial = (flag) => list.find(m => m.specialUse?.toLowerCase() === flag.toLowerCase())?.path;
        const byName = (...names) => list.find(m => names.some(n => m.path.toLowerCase() === n.toLowerCase()))?.path;
        return {
            inbox: bySpecial('\\Inbox') ?? byName('INBOX'),
            sent: bySpecial('\\Sent'),
            drafts: bySpecial('\\Drafts'),
            trash: bySpecial('\\Trash'),
            // Gmail has no Archive folder: archiving there means leaving only All Mail.
            // Still a folder the server marked, never one guessed from its name.
            archive: bySpecial('\\Archive') ?? bySpecial('\\All'),
            junk: bySpecial('\\Junk')
        };
    }
    async search(input) {
        return (await this.searchPage(input)).messages;
    }
    // One page, newest first. next: the cursor for the page after it (the
    // lowest UID on this page), when more matched than the limit. New mail gets
    // higher UIDs, so paging never repeats or skips a message.
    async searchPage(input) {
        if (input.beforeUid !== undefined && input.beforeUid <= 1)
            return { messages: [] };
        return this.read(async (client) => {
            const lock = await this.openToRead(client, input.mailbox);
            try {
                const query = { all: true };
                if (input.beforeUid !== undefined)
                    query.uid = `1:${input.beforeUid - 1}`;
                // Message-ID is the only handle that survives a move, so it is the
                // reliable way to re-find a message after any write.
                if (input.messageId)
                    query.header = { 'Message-ID': input.messageId };
                if (input.from)
                    query.from = input.from;
                if (input.to)
                    query.to = input.to;
                if (input.subject)
                    query.subject = input.subject;
                // IMAP compares whole days only, so "BEFORE today" drops all of today
                // (POL-12, found live). The server is asked for a day either side;
                // the exact times are applied below, to what it returns.
                if (input.since)
                    query.since = new Date(input.since.getTime() - DAY_MS);
                if (input.before)
                    query.before = new Date(input.before.getTime() + DAY_MS);
                if (input.read !== undefined)
                    query.seen = input.read;
                if (input.flagged !== undefined)
                    query.flagged = input.flagged;
                // Gmail's standard search matches the words anywhere, so a phrase found
                // unrelated mail (FND-06, found live). Its own search takes the phrase
                // in quotes, over the same fields.
                if (input.text && client.capabilities?.has?.('X-GM-EXT-1'))
                    query.gmraw = `"${input.text.replace(/"/g, '')}"`;
                else if (input.text)
                    query.or = [{ from: input.text }, { to: input.text }, { subject: input.text }, { body: input.text }];
                const result = await this.withinSearchLimit(client, client.search(query, { uid: true }));
                let remaining = Array.isArray(result) ? [...result].sort((a, b) => a - b) : [];
                if (!remaining.length && input.messageId && this.options.unreliableHeaderSearch) {
                    remaining = await this.scanForMessageId(client, input.messageId, input.beforeUid);
                }
                const inTime = (m) => {
                    if (!m.date)
                        return true;
                    const at = Date.parse(m.date);
                    return !(input.since && at < input.since.getTime()) && !(input.before && at >= input.before.getTime());
                };
                // Yahoo's subject search ignores reply prefixes ("Re: X" finds "X"
                // too: POL-13, found live), so what it returns is checked here: the
                // subject must really contain what was asked (case and spacing aside).
                const plain = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
                const wantedSubject = input.subject ? plain(input.subject) : undefined;
                const subjectMatches = (m) => !wantedSubject || plain(m.subject ?? '').includes(wantedSubject);
                // A server's search can't see attachments, so they're checked here too
                // (FND-02, found live: a search for "pdf" found nothing).
                const wantedName = input.attachmentName ? plain(input.attachmentName) : undefined;
                const attachmentsMatch = (m) => {
                    const names = m.attachmentNames ?? [];
                    if (input.hasAttachments !== undefined && input.hasAttachments !== names.length > 0)
                        return false;
                    return !wantedName || names.some(name => plain(name).includes(wantedName));
                };
                const checkedHere = Boolean(input.since || input.before || wantedSubject || input.hasAttachments !== undefined || wantedName);
                // System emails don't exist, as far as a search is concerned, so they
                // mustn't use up the page either (SIG-82, found live: "asked for 5, got
                // 3"). Older messages fill in until the page is full, looked at newest
                // first; the cursor is the lowest UID looked at, so paging never skips
                // or repeats. When results are checked here, many may be thrown away,
                // so they're read 50 at a time (FND-03, found live: a loose subject
                // match read 5 at a time took 20 round trips), and a page looks at
                // 1,000 at most before answering with a cursor to go on.
                const messages = [];
                let lowest;
                let examined = 0;
                while (messages.length < input.limit && remaining.length && examined < MAX_EXAMINED) {
                    const needed = input.limit - messages.length;
                    const batch = remaining.slice(-(checkedHere ? Math.max(needed, FILTERED_BATCH) : needed));
                    lowest = batch[0];
                    const rows = await client.fetchAll(batch, { envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true });
                    for (const row of [...rows].sort((a, b) => b.uid - a.uid)) {
                        examined++;
                        const m = this.summary(input.mailbox, row);
                        if (!isSystemMessageId(m.messageId) && inTime(m) && subjectMatches(m) && attachmentsMatch(m))
                            messages.push(m);
                        if (messages.length >= input.limit) {
                            lowest = row.uid;
                            break;
                        }
                    }
                    remaining = remaining.filter(uid => uid < lowest);
                }
                const more = remaining.length > 0 && lowest !== undefined;
                const stopped = more && messages.length < input.limit;
                return {
                    messages, ...(more ? { next: lowest } : {}),
                    ...(stopped ? { warning: `Looked at the newest ${MAX_EXAMINED.toLocaleString('en-US')} messages that could match and found ${messages.length}. Pass the cursor to look further back.` } : {})
                };
            }
            finally {
                lock.release();
            }
        });
    }
    // A search the server takes too long over (a full-text search of a big
    // folder) is stopped: the connection is closed, never reused mid-command.
    async withinSearchLimit(client, search) {
        let timer;
        const limit = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                client.close();
                reject(new MailError('SEARCH_TOO_SLOW', 'The search took too long and was stopped.'));
            }, this.config.SEARCH_TIMEOUT_MS);
        });
        try {
            return await Promise.race([search, limit]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    summary(mailbox, m) {
        const map = (items) => (items ?? []).filter(x => x?.address).map(person);
        return {
            mailbox,
            uid: m.uid,
            messageId: m.envelope?.messageId || undefined,
            subject: m.envelope?.subject || undefined,
            date: m.envelope?.date?.toISOString?.() || undefined,
            from: map(m.envelope?.from), to: map(m.envelope?.to),
            read: Boolean(m.flags?.has('\\Seen')),
            flagged: Boolean(m.flags?.has('\\Flagged')),
            size: m.size || undefined,
            untrustedContent: true,
            ...withCautions(map(m.envelope?.from), map(m.envelope?.replyTo)),
            ...(attachmentsIn(m.bodyStructure) ? { attachmentNames: attachmentsIn(m.bodyStructure) } : {})
        };
    }
    // includeSystem: only for the server's own handling of system emails, never for a tool.
    async fetchSummary(mailbox, uid, options = {}) {
        return this.read(async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const m = await this.fetchOneFresh(client, uid, { envelope: true, flags: true, size: true });
                if (!m || (!options.includeSystem && isSystemMessageId(m.envelope?.messageId)))
                    throw new MailError('MESSAGE_NOT_FOUND', `UID ${uid} was not found in ${mailbox}.`, 'NOT_FOUND');
                return this.summary(mailbox, m);
            }
            finally {
                lock.release();
            }
        });
    }
    async fetchRaw(mailbox, uid, options = {}) {
        const inspect = async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const meta = await this.fetchOneFresh(client, uid, { size: true, envelope: true });
                // A system email gets exactly the answer a missing one does.
                if (!meta || isSystemMessageId(meta.envelope?.messageId))
                    throw new MailError('MESSAGE_NOT_FOUND', 'Message not found.', 'NOT_FOUND');
                if (meta.size === undefined || meta.size > this.config.MAX_MESSAGE_BYTES)
                    throw new MailError('MESSAGE_TOO_LARGE', 'Message size is unavailable or exceeds the configured size limit.');
                const m = await client.fetchOne(uid, { envelope: true, flags: true, size: true, source: true }, { uid: true });
                if (!m)
                    throw new MailError('MESSAGE_NOT_FOUND', `UID ${uid} was not found in ${mailbox}.`, 'NOT_FOUND');
                if ((m.size ?? 0) > this.config.MAX_MESSAGE_BYTES) {
                    throw new MailError('MESSAGE_TOO_LARGE', `Message is larger than the ${this.config.MAX_MESSAGE_BYTES} byte safety limit.`);
                }
                return { summary: this.summary(mailbox, m), raw: m.source, envelope: m.envelope };
            }
            finally {
                lock.release();
            }
        };
        return options.client ? inspect(options.client) : this.read(inspect);
    }
    // One message by UID, on a folder the kept connection may have had open
    // since before that message arrived (ENG-25, tuning): a server needn't tell
    // an open folder about new mail until asked, so "not there" is checked once
    // more after a NOOP, which is that asking. Found ones cost nothing extra.
    async fetchOneFresh(client, uid, query) {
        const first = await client.fetchOne(uid, query, { uid: true });
        if (first)
            return first;
        await client.noop();
        return client.fetchOne(uid, query, { uid: true });
    }
    // What a reply needs of the original, and nothing more (ENG-24, tuning):
    // its envelope and References header, read-only, never the whole message.
    async fetchReplyHeaders(mailbox, uid) {
        return this.read(async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const m = await this.fetchOneFresh(client, uid, { envelope: true, headers: ['references'] });
                // A system email gets exactly the answer a missing one does.
                if (!m || isSystemMessageId(m.envelope?.messageId))
                    throw new MailError('MESSAGE_NOT_FOUND', 'Message not found.', 'NOT_FOUND');
                const map = (items) => (items ?? []).filter(x => x?.address).map(person);
                // Every <id> in the header, on however many folded lines.
                const references = (m.headers?.toString('utf8') ?? '').match(/<[^>\r\n]+>/g) ?? [];
                return {
                    messageId: m.envelope?.messageId || undefined, subject: m.envelope?.subject || undefined,
                    from: map(m.envelope?.from), replyTo: map(m.envelope?.replyTo), to: map(m.envelope?.to), cc: map(m.envelope?.cc), references
                };
            }
            finally {
                lock.release();
            }
        });
    }
    // A mailing list's unsubscribe headers (UNS-07), with the message's summary
    // (for its cautions), read-only, never the message itself.
    async fetchListHeaders(mailbox, uid) {
        return this.read(async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const m = await this.fetchOneFresh(client, uid, { envelope: true, flags: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] });
                if (!m || isSystemMessageId(m.envelope?.messageId))
                    throw new MailError('MESSAGE_NOT_FOUND', 'Message not found.', 'NOT_FOUND');
                const headers = headerValues(m.headers);
                return {
                    summary: this.summary(mailbox, m),
                    ...(headers['list-unsubscribe'] ? { listUnsubscribe: headers['list-unsubscribe'] } : {}),
                    ...(headers['list-unsubscribe-post'] ? { listUnsubscribePost: headers['list-unsubscribe-post'] } : {})
                };
            }
            finally {
                lock.release();
            }
        });
    }
    // Who sends to this folder (WHO-03): its newest n messages by position,
    // read-only: each one's sender, date, whether it's been read, how it offers
    // to unsubscribe (WHO-06), and its cautions, Reply-To included (WHO-07).
    // Envelopes, flags and two headers; never a body.
    async senderStats(mailbox, n) {
        return this.read(async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const rows = await this.newest(client, n, { envelope: true, flags: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] });
                const map = (items) => (items ?? []).filter(x => x?.address).map(person);
                return rows.filter(row => !isSystemMessageId(row.envelope?.messageId)).map(row => {
                    const sender = map(row.envelope?.from)[0];
                    const date = row.envelope?.date?.toISOString?.();
                    const headers = headerValues(row.headers);
                    return {
                        ...(sender ? { from: sender } : {}), ...(date ? { date } : {}),
                        read: Boolean(row.flags?.has('\\Seen')),
                        unsubscribe: unsubscribeKind(headers['list-unsubscribe'], headers['list-unsubscribe-post']),
                        ...withCautions(map(row.envelope?.from), map(row.envelope?.replyTo))
                    };
                });
            }
            finally {
                lock.release();
            }
        });
    }
    // Has this account ever written to this address (RCP-01)? Its Sent folder,
    // To or Cc, read-only.
    async hasSentTo(sent, address) {
        const own = this.config.MAIL_ADDRESS.toLowerCase();
        const wanted = address.toLowerCase();
        return this.read(async (client) => {
            const lock = await this.openToRead(client, sent);
            try {
                // The server's search is a first pass: it matches parts of addresses,
                // and Sent can hold mail someone else wrote (RCP-05, security review).
                // A hit counts only when it's from this account and names the address
                // exactly. The newest 50 are enough to find one.
                const hits = await client.search({ or: [{ to: address }, { cc: address }] }, { uid: true });
                if (!Array.isArray(hits) || !hits.length)
                    return false;
                const newest = [...hits].sort((x, y) => x - y).slice(-50);
                const rows = await client.fetchAll(newest, { envelope: true }, { uid: true });
                const names = (list) => (list ?? []).map(x => x.address?.toLowerCase());
                return rows.some(row => names(row.envelope?.from).includes(own)
                    && [...names(row.envelope?.to), ...names(row.envelope?.cc)].includes(wanted));
            }
            finally {
                lock.release();
            }
        });
    }
    async findByMessageId(mailbox, messageId) {
        return this.read(async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const r = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
                const found = Array.isArray(r) ? r : [];
                if (found.length || !this.options.unreliableHeaderSearch)
                    return found;
                return await this.scanForMessageId(client, messageId);
            }
            finally {
                lock.release();
            }
        });
    }
    // Found live (ENG-21): Yahoo's header search missed a message just moved into
    // a folder. The newest messages' Message-IDs are read directly (read-only,
    // envelope only) in the folder already selected.
    async scanForMessageId(client, messageId, beforeUid) {
        const rows = await this.newest(client, RECENT_SCAN, { envelope: true });
        return rows.filter(row => row.envelope?.messageId === messageId && (beforeUid === undefined || row.uid < beforeUid)).map(row => row.uid).sort((a, b) => a - b);
    }
    // The selected folder's newest n messages, by position (ENG-22, tuning):
    // asking for every UID the folder holds, to keep the last n, cost a large
    // answer per folder on a mailbox numbered in the hundreds of thousands.
    async newest(client, n, query) {
        const exists = client.mailbox ? client.mailbox.exists : 0;
        if (!exists)
            return [];
        return client.fetchAll(`${Math.max(1, exists - n + 1)}:*`, query);
    }
    async findThreadUids(mailbox, rootMessageId, options = {}) {
        const inspect = async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const anchors = [...new Set([rootMessageId, options.relatedMessageId].filter((id) => Boolean(id)))];
                const r = await client.search({ or: anchors.flatMap(id => ['Message-ID', 'References', 'In-Reply-To'].map(name => ({ header: { [name]: id } }))) }, { uid: true });
                const hits = new Set(Array.isArray(r) ? r : []);
                if (options.scanRecent === false)
                    return [...hits].sort((a, b) => a - b);
                // Yahoo can return no HEADER References/In-Reply-To matches even when
                // those headers are present. Inspect only threading headers of a bounded
                // recent window, using read-only BODY.PEEK via ImapFlow's headers query.
                for (const row of await this.newest(client, RECENT_SCAN, { headers: ['Message-ID', 'References', 'In-Reply-To'] })) {
                    const headerIds = (row.headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? '').match(/<[^>\r\n]+>/g) ?? [];
                    if (anchors.some(id => headerIds.includes(id)))
                        hits.add(row.uid);
                }
                return [...hits].sort((a, b) => a - b);
            }
            finally {
                lock.release();
            }
        };
        return options.client ? inspect(options.client) : this.read(inspect);
    }
    // Gmail files every message once in All Mail, and gives each conversation a
    // thread ID (X-GM-THRID). One search there returns the whole thread.
    async findGmailThread(seedMailbox, seedUid, allMail, options) {
        const { client } = options;
        let threadId;
        const seedLock = await this.openToRead(client, seedMailbox);
        try {
            threadId = (await client.fetchOne(seedUid, { threadId: true }, { uid: true }) || undefined)?.threadId;
        }
        finally {
            seedLock.release();
        }
        if (!threadId)
            return [];
        const lock = await this.openToRead(client, allMail);
        try {
            const r = await client.search({ threadId }, { uid: true });
            return Array.isArray(r) ? r : [];
        }
        finally {
            lock.release();
        }
    }
    async append(path, raw, flags = []) {
        return this.run(async (client) => {
            const result = await client.append(path, raw, flags);
            if (!result)
                throw new MailError('APPEND_FAILED', `The mail server did not confirm saving to ${path}.`, 'UNKNOWN');
            return result.uid || undefined;
        }).catch(e => { throw mutationFailure(e); });
    }
    async deleteMessage(mailbox, uid) {
        return this.run(async (client) => {
            const lock = await client.getMailboxLock(mailbox);
            try {
                if (!client.capabilities.has('UIDPLUS'))
                    throw new MailError('SAFE_DELETE_UNAVAILABLE', 'Draft cleanup requires UIDPLUS to avoid deleting unrelated messages.');
                const ok = await client.messageDelete(uid, { uid: true });
                if (!ok)
                    throw new MailError('DELETE_FAILED', `The mail server did not confirm deleting UID ${uid}.`, 'UNKNOWN');
            }
            finally {
                lock.release();
            }
        }).catch(e => { throw mutationFailure(e); });
    }
    async move(mailbox, uid, destination, options = {}) {
        const seed = await this.fetchSummary(mailbox, uid, options);
        const messageId = seed.messageId;
        const attempt = async () => this.run(async (client) => {
            const lock = await client.getMailboxLock(mailbox);
            try {
                if (!client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS'))
                    throw new MailError('SAFE_MOVE_UNAVAILABLE', 'Moving requires MOVE or UIDPLUS to avoid expunging unrelated messages.');
                const result = await client.messageMove(uid, destination, { uid: true });
                if (!result)
                    throw new MailError('MOVE_STATUS_UNKNOWN', 'Move was not confirmed.', 'UNKNOWN');
                return result && result.uidMap instanceof Map ? result.uidMap.get(uid) : undefined;
            }
            finally {
                lock.release();
            }
        });
        try {
            return await attempt();
        }
        catch (error) {
            // A connection lost mid-move surfaces as "not confirmed" (ImapFlow
            // resolves false) as often as a network error: either way, look first.
            const unconfirmed = isTransient(error) || (error instanceof MailError && error.code === 'MOVE_STATUS_UNKNOWN');
            if (!unconfirmed)
                throw mutationFailure(error);
            if (!messageId)
                throw mutationFailure(error);
            const [sourceHits, destHits] = await Promise.all([
                this.findByMessageId(mailbox, messageId).catch(() => null),
                this.findByMessageId(destination, messageId).catch(() => null)
            ]);
            if (sourceHits && destHits && !sourceHits.length && destHits.length === 1)
                return destHits[0];
            if (sourceHits && destHits && sourceHits.length === 1 && sourceHits[0] === uid && !destHits.length) {
                try {
                    return await attempt();
                }
                catch (retryError) {
                    throw mutationFailure(retryError);
                }
            }
            throw new MailError('MOVE_STATUS_UNKNOWN', `Could not safely determine whether UID ${uid} moved to ${destination}.`, 'UNKNOWN', false, { mailbox, uid, destination, messageId });
        }
    }
    // IMAP UID MOVE takes a sequence set, so a batch is one command on one
    // connection. There is deliberately no retry: a partially applied batch
    // cannot be verified cheaply, so an unconfirmed outcome stays UNKNOWN and the
    // caller re-resolves by Message-ID.
    // Found live (ENG-20): Yahoo's report of a batch paired the old UIDs, sorted,
    // with the new UIDs in the order they were asked for. The batch is now sent
    // sorted, and every pair is checked by Message-ID in the destination: a
    // message it can't confirm is left unmapped (re-resolve), never guessed.
    async moveMany(mailbox, uids, destination) {
        const sorted = [...new Set(uids)].sort((a, b) => a - b);
        return this.run(async (client) => {
            let sources;
            let reported;
            const lock = await client.getMailboxLock(mailbox);
            try {
                if (!client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS'))
                    throw new MailError('SAFE_MOVE_UNAVAILABLE', 'Moving requires MOVE or UIDPLUS to avoid expunging unrelated messages.');
                const rows = await this.refuseSystemOn(client, sorted);
                sources = new Map(rows.map(row => [row.uid, row.envelope?.messageId || undefined]));
                const result = await client.messageMove(sorted.join(','), destination, { uid: true });
                if (!result)
                    throw new MailError('MOVE_STATUS_UNKNOWN', 'Batch move was not confirmed.', 'UNKNOWN', false, { mailbox, destination, uids: sorted });
                reported = result.uidMap instanceof Map ? result.uidMap : new Map();
            }
            finally {
                lock.release();
            }
            // The move is done; checking it can only improve the answer, never undo it.
            try {
                return await this.pairByMessageId(client, destination, sorted, sources, reported);
            }
            catch {
                return new Map(sorted.map(uid => [uid, undefined]));
            }
        }).catch(e => { throw mutationFailure(e); });
    }
    async pairByMessageId(client, destination, sorted, sources, reported) {
        const newUids = [...new Set(reported.values())].filter(Boolean);
        if (!newUids.length)
            return new Map(sorted.map(uid => [uid, undefined]));
        const lock = await this.openToRead(client, destination);
        let seen;
        try {
            seen = await client.fetchAll(newUids.join(','), { envelope: true }, { uid: true });
        }
        finally {
            lock.release();
        }
        // Copies of one message (same Message-ID) are paired in order.
        const byId = new Map();
        for (const row of [...seen].sort((a, b) => a.uid - b.uid)) {
            const id = row.envelope?.messageId;
            if (id)
                byId.set(id, [...(byId.get(id) ?? []), row.uid]);
        }
        return new Map(sorted.map(uid => {
            const id = sources.get(uid);
            // Without a Message-ID there is nothing to check: the server's word stands.
            return [uid, id ? byId.get(id)?.shift() : reported.get(uid)];
        }));
    }
    // A change that includes a system email is refused whole, and touches
    // nothing. Checked on the connection making the change, just before it.
    // With each one's flags, so a change can say what it really changed (ACT-10).
    async refuseSystemOn(client, uids) {
        const rows = await client.fetchAll(uids.join(','), { envelope: true, flags: true }, { uid: true });
        if (rows.some(m => isSystemMessageId(m.envelope?.messageId)))
            throw new MailError('MESSAGE_NOT_FOUND', 'Message not found.', 'NOT_FOUND');
        return rows;
    }
    async refuseSystem(mailbox, uids) {
        await this.read(async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                await this.refuseSystemOn(client, uids);
            }
            finally {
                lock.release();
            }
        });
    }
    // Whether it changed (ACT-10): false when it was already so; true when it
    // wasn't, or when a lost answer means it can't be told.
    async setFlag(mailbox, uid, flag, value) {
        const desired = async () => this.read(async (client) => {
            const lock = await this.openToRead(client, mailbox);
            try {
                const m = await this.fetchOneFresh(client, uid, { flags: true });
                if (!m)
                    return null;
                return Boolean(m.flags?.has(flag));
            }
            finally {
                lock.release();
            }
        });
        const mutate = async () => this.run(async (client) => {
            const lock = await client.getMailboxLock(mailbox);
            try {
                const [before] = await this.refuseSystemOn(client, [uid]);
                const ok = value
                    ? await client.messageFlagsAdd(uid, [flag], { uid: true })
                    : await client.messageFlagsRemove(uid, [flag], { uid: true });
                if (!ok)
                    throw new Error('Flag update not confirmed');
                return !before || Boolean(before.flags?.has(flag)) !== value;
            }
            finally {
                lock.release();
            }
        });
        try {
            return await mutate();
        }
        catch (error) {
            // Refused before any change (a system email): nothing to reconcile.
            if (error instanceof MailError && error.code === 'MESSAGE_NOT_FOUND')
                throw error;
            const state = await desired().catch(() => { throw mutationFailure(error); });
            if (state === value)
                return true;
            if (state === null)
                throw new MailError('MESSAGE_NOT_FOUND', `UID ${uid} was not found in ${mailbox}.`, 'NOT_FOUND');
            if (isTransient(error)) {
                await mutate().catch(e => { throw mutationFailure(e); });
                return true;
            }
            throw mutationFailure(error);
        }
    }
    // Many messages, one STORE command. If the outcome isn't confirmed, each
    // message's flags are read back: all as asked is success, anything else is
    // reported as unknown (never retried blindly).
    // The UIDs it changed (ACT-10): those that weren't already so, read in the
    // same step that checks them; all of them when a lost answer hides which.
    async setFlags(mailbox, uids, flag, value) {
        const set = uids.join(',');
        try {
            return await this.run(async (client) => {
                const lock = await client.getMailboxLock(mailbox);
                try {
                    const before = await this.refuseSystemOn(client, uids);
                    const ok = value
                        ? await client.messageFlagsAdd(set, [flag], { uid: true })
                        : await client.messageFlagsRemove(set, [flag], { uid: true });
                    if (!ok)
                        throw new Error('Flag update not confirmed');
                    return before.filter(m => Boolean(m.flags?.has(flag)) !== value).map(m => m.uid).sort((a, b) => a - b);
                }
                finally {
                    lock.release();
                }
            });
        }
        catch (error) {
            if (error instanceof MailError && error.code === 'MESSAGE_NOT_FOUND')
                throw error;
            const states = await this.read(async (client) => {
                const lock = await this.openToRead(client, mailbox);
                try {
                    return await client.fetchAll(set, { flags: true }, { uid: true });
                }
                finally {
                    lock.release();
                }
            }).catch(() => { throw mutationFailure(error); });
            if (states.length === uids.length && states.every(m => Boolean(m.flags?.has(flag)) === value))
                return [...uids];
            throw mutationFailure(error);
        }
    }
    async createFolder(path) {
        // Already there (ENG-23, tuning): one LIST on the kept connection. Asking
        // Yahoo to create it anyway was refused, and the refusal cost a new login.
        this.folders = undefined;
        const existing = (await this.listFolders()).find(f => f.path === path);
        if (existing)
            return { path: existing.path, created: false };
        this.folders = undefined;
        try {
            return await this.run(async (client) => {
                const r = await client.mailboxCreate(path);
                return { path: r.path, created: Boolean(r.created) };
            });
        }
        catch (error) {
            const folders = await this.listFolders().catch(() => []);
            const found = folders.find(f => f.path === path);
            if (found)
                return { path: found.path, created: false };
            throw mutationFailure(error);
        }
    }
}
//# sourceMappingURL=imap.js.map