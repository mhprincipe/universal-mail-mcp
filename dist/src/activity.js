import { randomUUID } from 'node:crypto';
const MAX_ENTRIES = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 16_384;
function valid(entry) {
    const e = entry;
    return !!e && typeof e.id === 'string' && typeof e.at === 'number' && typeof e.app === 'string' && typeof e.account === 'string'
        && typeof e.action === 'string' && typeof e.count === 'number';
}
// Saved with your settings, but not on every action: after a quiet spell
// (debounceMs), or on flush, one save carries everything since the last.
export function createActivityLog(options) {
    const { clock } = options;
    let entries = Array.isArray(options.saved) ? options.saved.filter(valid) : [];
    let timer;
    let dirty = false;
    const prune = () => {
        const oldest = clock.now() - MAX_AGE_MS;
        entries = entries.filter(e => e.at > oldest).sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
        // Saved inside the settings record, which Google caps at 64 KB: the log
        // keeps to 16 KB of it, oldest dropped first (ACT-07, security review).
        let size = JSON.stringify(entries).length;
        while (size > MAX_BYTES && entries.length)
            size -= JSON.stringify(entries.pop()).length + 1;
    };
    prune();
    const flush = async () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (!dirty || !options.save)
            return;
        dirty = false;
        await options.save(entries.map(e => ({ ...e })));
    };
    const changed = () => {
        dirty = true;
        if (!options.save || timer)
            return;
        timer = setTimeout(() => { void flush(); }, options.debounceMs ?? 30_000);
        timer.unref?.();
    };
    return {
        record(entry) {
            const full = { ...entry, id: randomUUID(), at: clock.now() };
            entries.unshift(full);
            prune();
            changed();
            return full;
        },
        list: () => { prune(); return entries; },
        get: id => entries.find(e => e.id === id),
        markUndone(id) {
            const entry = entries.find(e => e.id === id);
            if (entry) {
                entry.undone = clock.now();
                changed();
            }
        },
        flush
    };
}
const MOVES = { move_email: 'moved', archive_email: 'archived', trash_email: 'trashed', restore_email: 'restored' };
const targets = (args) => args.uids ?? (args.uid !== undefined ? [args.uid] : []);
// What a successful organize or send tool did, or undefined when it's not an
// action worth listing (a read, a failure, nothing changed).
export function activityFor(tool, args, envelope) {
    if (!envelope?.ok || envelope.code === 'ALREADY_THERE')
        return undefined;
    const data = envelope.data ?? {};
    if (MOVES[tool]) {
        const count = targets(args).length;
        const uids = Array.isArray(data.moved)
            ? data.moved.map((m) => m.destinationUid).filter((u) => typeof u === 'number')
            : typeof data.destinationUid === 'number' ? [data.destinationUid] : [];
        return {
            action: MOVES[tool], count, from: args.mailbox, to: data.destination,
            ...(uids.length && data.destination ? { undo: { kind: 'move', mailbox: data.destination, uids, destination: args.mailbox } } : {})
        };
    }
    if (tool === 'mark_read' || tool === 'mark_unread') {
        const read = tool === 'mark_read';
        return { action: read ? 'marked read' : 'marked unread', count: targets(args).length, from: args.mailbox, undo: { kind: 'flag', mailbox: args.mailbox, uids: targets(args), flag: 'read', value: !read } };
    }
    if (tool === 'flag_email') {
        return { action: args.flagged ? 'flagged' : 'unflagged', count: targets(args).length, from: args.mailbox, undo: { kind: 'flag', mailbox: args.mailbox, uids: targets(args), flag: 'flagged', value: !args.flagged } };
    }
    if (tool === 'send_email' || tool === 'reply_email') {
        const recipients = tool === 'send_email' ? [...(args.to ?? []), ...(args.cc ?? []), ...(args.bcc ?? [])].length : undefined;
        return { action: tool === 'send_email' ? 'sent' : 'replied', count: 1, ...(recipients !== undefined ? { recipients } : {}), ...(args.newRecipientsConfirmed ? { newRecipients: true } : {}) };
    }
    if (tool === 'create_draft')
        return { action: 'drafted', count: 1 };
    if (tool === 'update_draft')
        return { action: 'updated a draft', count: 1 };
    if (tool === 'create_folder')
        return data.created ? { action: 'created folder', count: 1, to: data.path } : undefined;
    return undefined;
}
//# sourceMappingURL=activity.js.map