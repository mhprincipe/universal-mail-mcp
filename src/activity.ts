import { randomUUID } from 'node:crypto';
import type { ToolEnvelope } from './errors.js';

// The activity log (ACT-01..05, principle 1: the person stays in charge): what
// each app did in your mail, in plain words, for 30 days, with what undo needs.
// Never content: no subjects, bodies or addresses, only the action, account,
// folders, how many and when.

export type ActivityUndo =
  | { kind: 'move'; mailbox: string; uids: number[]; destination: string }
  | { kind: 'flag'; mailbox: string; uids: number[]; flag: 'read' | 'flagged'; value: boolean };
export type ActivityEntry = {
  // email: the account's address, so undo finds it after a rename, and
  // never acts on another account that later took the name (ACT-08).
  id: string; at: number; app: string; account: string; email?: string;
  action: string; count: number; recipients?: number;
  // How many files went with a message (2.4.1): a count, never their names.
  attachments?: number;
  // Sent to someone new on the AI's word that the owner confirmed (RCP): shown.
  newRecipients?: boolean;
  from?: string; to?: string;
  undo?: ActivityUndo; undone?: number;
};
type Described = Omit<ActivityEntry, 'id' | 'at' | 'app' | 'account' | 'email' | 'undone'>;

export type ActivityLog = {
  record(entry: Omit<ActivityEntry, 'id' | 'at'>): ActivityEntry;
  list(): ActivityEntry[];
  get(id: string): ActivityEntry | undefined;
  markUndone(id: string): void;
  // Saves now what's waiting (at shutdown, and in tests).
  flush(): Promise<void>;
};

const MAX_ENTRIES = 100;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 16_384;

function valid(entry: unknown): entry is ActivityEntry {
  const e = entry as Partial<ActivityEntry> | null;
  return !!e && typeof e.id === 'string' && typeof e.at === 'number' && typeof e.app === 'string' && typeof e.account === 'string'
    && typeof e.action === 'string' && typeof e.count === 'number';
}

// Saved with your settings, but not on every action: after a quiet spell
// (debounceMs), or on flush, one save carries everything since the last.
export function createActivityLog(options: {
  clock: { now(): number }; saved?: unknown; save?: (entries: ActivityEntry[]) => void | Promise<void>; debounceMs?: number;
}): ActivityLog {
  const { clock } = options;
  let entries: ActivityEntry[] = Array.isArray(options.saved) ? options.saved.filter(valid) : [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const prune = () => {
    const oldest = clock.now() - MAX_AGE_MS;
    entries = entries.filter(e => e.at > oldest).sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
    // Saved inside the settings record, which Google caps at 64 KB: the log
    // keeps to 16 KB of it, oldest dropped first (ACT-07, security review).
    let size = JSON.stringify(entries).length;
    while (size > MAX_BYTES && entries.length) size -= JSON.stringify(entries.pop()).length + 1;
  };
  prune();
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!dirty || !options.save) return;
    dirty = false;
    await options.save(entries.map(e => ({ ...e })));
  };
  const changed = () => {
    dirty = true;
    if (!options.save || timer) return;
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
      if (entry) { entry.undone = clock.now(); changed(); }
    },
    flush
  };
}

const MOVES: Record<string, string> = { move_email: 'moved', archive_email: 'archived', trash_email: 'trashed', restore_email: 'restored', junk_email: 'moved to junk' };
const SENDS: Record<string, string> = { send_email: 'sent', reply_email: 'replied', forward_email: 'forwarded' };
const targets = (args: { uid?: number; uids?: number[] }) => args.uids ?? (args.uid !== undefined ? [args.uid] : []);

// What a successful organize or send tool did, or undefined when it's not an
// action worth listing (a read, a failure, nothing changed).
export function activityFor(tool: string, args: Record<string, any>, envelope: ToolEnvelope<any>): Described | undefined {
  if (!envelope?.ok || envelope.code === 'ALREADY_THERE') return undefined;
  const data = envelope.data ?? {};
  if (MOVES[tool]) {
    const count = targets(args).length;
    const uids: number[] = Array.isArray(data.moved)
      ? data.moved.map((m: { destinationUid?: number }) => m.destinationUid).filter((u: unknown): u is number => typeof u === 'number')
      : typeof data.destinationUid === 'number' ? [data.destinationUid] : [];
    return {
      action: MOVES[tool]!, count, from: args.mailbox, to: data.destination,
      ...(uids.length && data.destination ? { undo: { kind: 'move', mailbox: data.destination, uids, destination: args.mailbox } } : {})
    };
  }
  // Only what really changed (ACT-10): undo then puts back just those; an
  // answer that doesn't say means all of them.
  const changed: number[] = Array.isArray(data.changed) ? data.changed : targets(args);
  if ((tool === 'mark_read' || tool === 'mark_unread' || tool === 'flag_email') && !changed.length) return undefined;
  if (tool === 'mark_read' || tool === 'mark_unread') {
    const read = tool === 'mark_read';
    return { action: read ? 'marked read' : 'marked unread', count: changed.length, from: args.mailbox, undo: { kind: 'flag', mailbox: args.mailbox, uids: changed, flag: 'read', value: !read } };
  }
  if (tool === 'flag_email') {
    return { action: args.flagged ? 'flagged' : 'unflagged', count: changed.length, from: args.mailbox, undo: { kind: 'flag', mailbox: args.mailbox, uids: changed, flag: 'flagged', value: !args.flagged } };
  }
  const attachments = Array.isArray(data.attachments) && data.attachments.length ? { attachments: data.attachments.length } : {};
  if (SENDS[tool]) {
    const recipients = tool === 'reply_email' ? undefined : [...(args.to ?? []), ...(args.cc ?? []), ...(args.bcc ?? [])].length;
    return { action: SENDS[tool]!, count: 1, ...(recipients !== undefined ? { recipients } : {}), ...attachments, ...(args.newRecipientsConfirmed ? { newRecipients: true } : {}) };
  }
  if (tool === 'create_draft') return { action: 'drafted', count: 1, ...attachments };
  if (tool === 'update_draft') return { action: 'updated a draft', count: 1, ...attachments };
  if (tool === 'unsubscribe') return { action: 'unsubscribed', count: 1 };
  if (tool === 'create_folder') return data.created ? { action: 'created folder', count: 1, to: data.path } : undefined;
  return undefined;
}
