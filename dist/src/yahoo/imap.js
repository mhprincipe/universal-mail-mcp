import { ImapFlow } from 'imapflow';
import { imapTransport } from '../config.js';
import { MailError, classify, isTransient, mutationFailure } from '../errors.js';
import { isSystemMessageId } from '../systemMail.js';
export class ImapGateway {
    config;
    constructor(config) {
        this.config = config;
    }
    client() {
        const c = new ImapFlow({
            host: this.config.IMAP_HOST,
            port: this.config.IMAP_PORT,
            ...imapTransport(this.config),
            auth: { user: this.config.YAHOO_EMAIL, pass: this.config.YAHOO_APP_PASSWORD },
            logger: false
        });
        c.on('error', () => undefined);
        return c;
    }
    async run(fn) {
        const client = this.client();
        try {
            await client.connect();
            return await fn(client);
        }
        finally {
            try {
                await client.logout();
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
            const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
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
                if (input.since)
                    query.since = input.since;
                if (input.before)
                    query.before = input.before;
                if (input.read !== undefined)
                    query.seen = input.read;
                if (input.flagged !== undefined)
                    query.flagged = input.flagged;
                if (input.text)
                    query.or = [{ from: input.text }, { to: input.text }, { subject: input.text }, { body: input.text }];
                const result = await this.withinSearchLimit(client, client.search(query, { uid: true }));
                const all = Array.isArray(result) ? [...result].sort((a, b) => a - b) : [];
                const uids = all.slice(-input.limit);
                if (!uids.length)
                    return { messages: [] };
                const rows = await client.fetchAll(uids, { envelope: true, flags: true, size: true }, { uid: true });
                // System emails don't exist, as far as a search is concerned.
                const messages = rows.sort((a, b) => b.uid - a.uid).map(m => this.summary(input.mailbox, m)).filter(m => !isSystemMessageId(m.messageId));
                return { messages, ...(all.length > uids.length ? { next: uids[0] } : {}) };
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
        const map = (items) => (items ?? []).filter(x => x?.address).map(x => ({ name: x.name || undefined, address: x.address }));
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
            untrustedContent: true
        };
    }
    // includeSystem: only for the server's own handling of system emails, never for a tool.
    async fetchSummary(mailbox, uid, options = {}) {
        return this.read(async (client) => {
            const lock = await client.getMailboxLock(mailbox, { readOnly: true });
            try {
                const m = await client.fetchOne(uid, { envelope: true, flags: true, size: true }, { uid: true });
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
            const lock = await client.getMailboxLock(mailbox, { readOnly: true });
            try {
                const meta = await client.fetchOne(uid, { size: true, envelope: true }, { uid: true });
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
    async findByMessageId(mailbox, messageId) {
        return this.read(async (client) => {
            const lock = await client.getMailboxLock(mailbox, { readOnly: true });
            try {
                const r = await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
                return Array.isArray(r) ? r : [];
            }
            finally {
                lock.release();
            }
        });
    }
    async findThreadUids(mailbox, rootMessageId, options = {}) {
        const inspect = async (client) => {
            const lock = await client.getMailboxLock(mailbox, { readOnly: true });
            try {
                const anchors = [...new Set([rootMessageId, options.relatedMessageId].filter((id) => Boolean(id)))];
                const r = await client.search({ or: anchors.flatMap(id => ['Message-ID', 'References', 'In-Reply-To'].map(name => ({ header: { [name]: id } }))) }, { uid: true });
                const hits = new Set(Array.isArray(r) ? r : []);
                if (options.scanRecent === false)
                    return [...hits].sort((a, b) => a - b);
                // Yahoo can return no HEADER References/In-Reply-To matches even when
                // those headers are present. Inspect only threading headers of a bounded
                // recent window, using read-only BODY.PEEK via ImapFlow's headers query.
                const all = await client.search({ all: true }, { uid: true });
                const recent = Array.isArray(all) ? all.slice(-200) : [];
                if (recent.length) {
                    const rows = await client.fetchAll(recent, { headers: ['Message-ID', 'References', 'In-Reply-To'] }, { uid: true });
                    for (const row of rows) {
                        const headerIds = (row.headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? '').match(/<[^>\r\n]+>/g) ?? [];
                        if (anchors.some(id => headerIds.includes(id)))
                            hits.add(row.uid);
                    }
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
        const seedLock = await client.getMailboxLock(seedMailbox, { readOnly: true });
        try {
            threadId = (await client.fetchOne(seedUid, { threadId: true }, { uid: true }) || undefined)?.threadId;
        }
        finally {
            seedLock.release();
        }
        if (!threadId)
            return [];
        const lock = await client.getMailboxLock(allMail, { readOnly: true });
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
    async moveMany(mailbox, uids, destination) {
        return this.run(async (client) => {
            const lock = await client.getMailboxLock(mailbox);
            try {
                if (!client.capabilities.has('MOVE') && !client.capabilities.has('UIDPLUS'))
                    throw new MailError('SAFE_MOVE_UNAVAILABLE', 'Moving requires MOVE or UIDPLUS to avoid expunging unrelated messages.');
                await this.refuseSystemOn(client, uids);
                const result = await client.messageMove(uids.join(','), destination, { uid: true });
                if (!result)
                    throw new MailError('MOVE_STATUS_UNKNOWN', 'Batch move was not confirmed.', 'UNKNOWN', false, { mailbox, destination, uids });
                const map = result.uidMap instanceof Map ? result.uidMap : new Map();
                return new Map(uids.map(uid => [uid, map.get(uid)]));
            }
            finally {
                lock.release();
            }
        }).catch(e => { throw mutationFailure(e); });
    }
    // A change that includes a system email is refused whole, and touches
    // nothing. Checked on the connection making the change, just before it.
    async refuseSystemOn(client, uids) {
        const rows = await client.fetchAll(uids.join(','), { envelope: true }, { uid: true });
        if (rows.some(m => isSystemMessageId(m.envelope?.messageId)))
            throw new MailError('MESSAGE_NOT_FOUND', 'Message not found.', 'NOT_FOUND');
    }
    async refuseSystem(mailbox, uids) {
        await this.read(async (client) => {
            const lock = await client.getMailboxLock(mailbox, { readOnly: true });
            try {
                await this.refuseSystemOn(client, uids);
            }
            finally {
                lock.release();
            }
        });
    }
    async setFlag(mailbox, uid, flag, value) {
        const desired = async () => this.read(async (client) => {
            const lock = await client.getMailboxLock(mailbox, { readOnly: true });
            try {
                const m = await client.fetchOne(uid, { flags: true }, { uid: true });
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
                await this.refuseSystemOn(client, [uid]);
                const ok = value
                    ? await client.messageFlagsAdd(uid, [flag], { uid: true })
                    : await client.messageFlagsRemove(uid, [flag], { uid: true });
                if (!ok)
                    throw new Error('Flag update not confirmed');
            }
            finally {
                lock.release();
            }
        });
        try {
            await mutate();
        }
        catch (error) {
            // Refused before any change (a system email): nothing to reconcile.
            if (error instanceof MailError && error.code === 'MESSAGE_NOT_FOUND')
                throw error;
            const state = await desired().catch(() => { throw mutationFailure(error); });
            if (state === value)
                return;
            if (state === null)
                throw new MailError('MESSAGE_NOT_FOUND', `UID ${uid} was not found in ${mailbox}.`, 'NOT_FOUND');
            if (isTransient(error)) {
                await mutate().catch(e => { throw mutationFailure(e); });
                return;
            }
            throw mutationFailure(error);
        }
    }
    // Many messages, one STORE command. If the outcome isn't confirmed, each
    // message's flags are read back: all as asked is success, anything else is
    // reported as unknown (never retried blindly).
    async setFlags(mailbox, uids, flag, value) {
        const set = uids.join(',');
        try {
            await this.run(async (client) => {
                const lock = await client.getMailboxLock(mailbox);
                try {
                    await this.refuseSystemOn(client, uids);
                    const ok = value
                        ? await client.messageFlagsAdd(set, [flag], { uid: true })
                        : await client.messageFlagsRemove(set, [flag], { uid: true });
                    if (!ok)
                        throw new Error('Flag update not confirmed');
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
                const lock = await client.getMailboxLock(mailbox, { readOnly: true });
                try {
                    return await client.fetchAll(set, { flags: true }, { uid: true });
                }
                finally {
                    lock.release();
                }
            }).catch(() => { throw mutationFailure(error); });
            if (states.length === uids.length && states.every(m => Boolean(m.flags?.has(flag)) === value))
                return;
            throw mutationFailure(error);
        }
    }
    async createFolder(path) {
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