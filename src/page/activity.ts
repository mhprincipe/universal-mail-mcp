import type { ActivityEntry, ActivityLog } from '../activity.js';
import type { MailAccess } from '../multiMail.js';
import type { PageTools } from './routes.js';

// Your page: undoing what an app did (ACT-02, ACT-03). Done as the owner,
// through the same mail rules the apps use; a message that has moved since
// is left where it is, and the page says so.

const plural = (n: number) => `${n} message${n === 1 ? '' : 's'}`;

// The words the page shows for one entry.
export function activityLine(e: ActivityEntry): string {
  if (e.action === 'sent') return `${e.app} sent 1 message${e.recipients ? ` (${e.recipients} recipient${e.recipients === 1 ? '' : 's'})` : ''} from ${e.account}`;
  if (e.action === 'replied') return `${e.app} replied to 1 message from ${e.account}`;
  if (e.action === 'created folder') return `${e.app} created the folder ${e.to} in ${e.account}`;
  return `${e.app} ${e.action} ${plural(e.count)} in ${e.account}`;
}

// What the undo button says.
export function undoLabel(e: ActivityEntry): string | undefined {
  const u = e.undo;
  if (!u || e.undone) return undefined;
  if (u.kind === 'move') return 'Put back';
  if (u.flag === 'read') return u.value ? 'Mark read again' : 'Mark unread again';
  return u.value ? 'Flag again' : 'Unflag again';
}

export function activityActions(tools: PageTools, deps: { activity: ActivityLog; getMail(): MailAccess }) {
  tools.post('/activity/undo', async (req, res, session) => {
    const entry = deps.activity.get(String(req.body.id ?? ''));
    if (!entry) return tools.back(res, session, { kind: 'error', text: 'That entry isn\'t here any more.' });
    if (entry.undone) return tools.back(res, session, { kind: 'error', text: 'That has already been undone.' });
    const undo = entry.undo;
    if (!undo) return tools.back(res, session, { kind: 'error', text: 'That can\'t be undone.' });
    try {
      const service = deps.getMail().service(entry.account, 'organize');
      if (undo.kind === 'move') await service.moveEmail(undo.mailbox, undo.uids, undo.destination);
      else if (undo.flag === 'read') await (undo.value ? service.markRead(undo.mailbox, undo.uids) : service.markUnread(undo.mailbox, undo.uids));
      else await service.flagEmail(undo.mailbox, undo.uids, undo.value);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const text = code === 'MESSAGE_NOT_FOUND'
        ? 'That couldn\'t be undone: the messages have moved since. Nothing was changed.'
        : `That couldn't be undone: ${(error as Error)?.message ?? 'the mail server refused'}. Nothing was changed.`;
      return tools.back(res, session, { kind: 'error', text });
    }
    deps.activity.markUndone(entry.id);
    tools.back(res, session, { kind: 'ok', text: undo.kind === 'move' ? `Put back ${plural(undo.uids.length)} in ${undo.destination}.` : `Undone: ${undoLabel({ ...entry, undone: undefined })!.toLowerCase()}.` });
  });
}
