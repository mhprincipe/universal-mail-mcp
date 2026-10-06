// Provider shapes the protocol tier runs against (TEST-PLAN-V2 §6).
// Each profile states exactly what its test mail server advertises, and how
// its special folders are laid out.

export type ProfileName = 'yahoo-like' | 'minimal' | 'hostile' | 'gmail-like' | 'outlook-like';

// The capabilities whose presence changes what the engine does.
export const controlledCapabilities = ['MOVE', 'UIDPLUS', 'SPECIAL-USE'] as const;

export type SpecialFolders = { sent: string; drafts: string; junk: string; trash: string; archive?: string; all?: string };

const base = ['IMAP4rev1', 'SASL-IR', 'LOGIN-REFERRALS', 'ID', 'ENABLE', 'IDLE', 'LITERAL+', 'NAMESPACE', 'CHILDREN', 'ESEARCH', 'LIST-EXTENDED', 'LIST-STATUS'];
const yahooFolders: SpecialFolders = { sent: 'Sent', drafts: 'Draft', junk: 'Bulk', trash: 'Trash', archive: 'Archive' };

// token: signs in only with XOAUTH2 and an access token (its password), as Outlook does (2.5).
export const profiles: Record<ProfileName, { advertises: string[]; folders: SpecialFolders; token?: true }> = {
  // Yahoo: native MOVE and UIDPLUS, special-use folders.
  'yahoo-like': { advertises: [...base, 'MOVE', 'UIDPLUS', 'SPECIAL-USE'], folders: yahooFolders },
  // Moves must fall back to the UIDPLUS copy-and-expunge path.
  'minimal': { advertises: [...base, 'UIDPLUS', 'SPECIAL-USE'], folders: yahooFolders },
  // Neither safe move primitive: every move must be refused.
  'hostile': { advertises: [...base, 'SPECIAL-USE'], folders: yahooFolders },
  // Gmail's layout: everything under [Gmail]/, an All Mail folder, no Archive.
  // (Gmail's own thread-ID extension can't be reproduced on Dovecot; THR-01
  // covers it with a scripted client.)
  // Outlook.com: Microsoft's folder names, and sign-in by access token only (XOAUTH2).
  'outlook-like': {
    advertises: [...base, 'MOVE', 'UIDPLUS', 'SPECIAL-USE'], token: true,
    folders: { sent: 'Sent Items', drafts: 'Drafts', junk: 'Junk Email', trash: 'Deleted Items', archive: 'Archive' }
  },
  'gmail-like': {
    advertises: [...base, 'MOVE', 'UIDPLUS', 'SPECIAL-USE'],
    folders: { sent: '[Gmail]/Sent Mail', drafts: '[Gmail]/Drafts', junk: '[Gmail]/Spam', trash: '[Gmail]/Trash', all: '[Gmail]/All Mail' }
  }
};
