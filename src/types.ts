export type Address = { name?: string; address: string };
// index: its position in the email, which get_attachment takes.
export type AttachmentMeta = { index: number; filename?: string; contentType: string; size: number; contentId?: string };
// Every message the tools return is marked untrusted: a subject or a sender's
// name is written by whoever sent the email, just as the body is.
export type MessageSummary = {
  mailbox: string; uid: number; messageId?: string; subject?: string; date?: string;
  from: Address[]; to: Address[]; read: boolean; flagged: boolean; size?: number;
  untrustedContent: true;
};
export type MessageDetail = MessageSummary & {
  cc: Address[]; bcc: Address[]; replyTo: Address[]; text?: string; html?: string;
  inReplyTo?: string; references: string[]; attachments: AttachmentMeta[];
  truncated?: true;
};
export type FolderInfo = { path: string; specialUse?: string; selectable: boolean; delimiter?: string };
