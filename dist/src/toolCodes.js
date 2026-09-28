// Every tool error code, with its remedy: what the AI should do next (design
// §6.6: "every error carries a plain-English remedy"). failure() attaches it.
// POL-07 keeps this list and the codes the source uses the same.
export const TOOL_CODES = {
    // ── Reaching the mail server ──
    AUTH_FAILED: { remedy: 'The mail provider refused the saved app password. Tell the owner to use Fix it on their Universal Mail page.' },
    TRANSIENT_NETWORK: { remedy: 'The mail server could not be reached just now. Wait a minute, then try once more.' },
    MAIL_OPERATION_FAILED: { remedy: 'The mail server refused this request. Check the folder and message, then try once more; if it fails again, stop and tell the owner.' },
    SMTP_ENCRYPTION_UNAVAILABLE: { remedy: 'Nothing was sent, because the connection could not be encrypted. Tell the owner; do not retry.' },
    SMTP_REJECTED: { remedy: 'The mail provider refused the message. Check the recipients and content; tell the owner before trying again.' },
    // ── Outcomes that are not known: never guess, never repeat blindly ──
    OPERATION_STATUS_UNKNOWN: { remedy: 'Check the mailbox (search by messageId) to see whether it happened before repeating it.' },
    MOVE_STATUS_UNKNOWN: { remedy: 'Search the destination folder by messageId to see whether the move happened before moving again.' },
    SEND_STATUS_UNKNOWN: { remedy: 'The message may have been sent. Look in Sent for it; never send it again automatically.' },
    // ── Finding things ──
    MESSAGE_NOT_FOUND: { remedy: 'The UID may have changed after a move. Search the folder by messageId to find the message again.' },
    DRAFT_NOT_FOUND: { remedy: 'Search the Drafts folder again to find the draft\'s current UID.' },
    FOLDER_NOT_FOUND: { remedy: 'Call list_folders and use a folder name exactly as it is listed, or create_folder first.' },
    SPECIAL_FOLDER_NOT_FOUND: { remedy: 'This account has no such folder marked by its provider. Call list_folders and move to a named folder instead.' },
    NOT_A_DRAFT_MAILBOX: { remedy: 'Only drafts can be updated. Use the Drafts folder and a draft\'s UID.' },
    NO_REPLY_ADDRESS: { remedy: 'The original has no address to reply to. Use send_email with the recipients spelled out.' },
    // ── Limits that protect the mailbox ──
    MESSAGE_TOO_LARGE: { remedy: 'This message is too large to open here. Tell the owner to open it in their mail app.' },
    ATTACHMENTS_UNSUPPORTED: { remedy: 'Drafts with attachments can\'t be edited here. Create a new draft instead; the original is untouched.' },
    SAFE_MOVE_UNAVAILABLE: { remedy: 'This provider can\'t move mail safely, so moving is off for this account. Leave the message where it is.' },
    SAFE_DELETE_UNAVAILABLE: { remedy: 'This provider can\'t remove drafts safely. The new draft was saved; the old one remains for the owner to delete.' },
    SENT_POLICY_UNVERIFIED: { remedy: 'Sending isn\'t set up for this account yet. Tell the owner to run Check and fix in Cloud Shell.' },
    APPEND_FAILED: { remedy: 'The message could not be saved to the folder. Try once more; if it fails again, tell the owner.' },
    DELETE_FAILED: { remedy: 'The old draft could not be removed. The new one is saved; tell the owner the old draft remains.' },
    SEARCH_TOO_SLOW: { remedy: 'This search took too long. Narrow your search: add from, subject, or a since/before date range.' },
    // ── Accounts and permissions ──
    'MAIL-ACCOUNT-REQUIRED': { remedy: 'More than one account is connected. Ask the owner which account to use, then pass it as account.' },
    'MAIL-ACCOUNT-UNKNOWN': { remedy: 'Use one of the account names listed in the tool\'s account description.' },
    'MAIL-NOT-PERMITTED': { remedy: 'Tell the owner this app needs that permission; they can grant it on their Universal Mail page.' },
    'MAIL-SENDING-OFF': { remedy: 'The owner turned sending off for this account. Tell them; they can turn it on on their Universal Mail page. Do not send from another account instead unless they ask.' },
    'MAIL-CROSS-ACCOUNT': { remedy: 'Mail can only move within one account. Move it within its own account instead.' },
    'SUBSCRIPTION-READ-ONLY': { remedy: 'The owner\'s Universal Mail subscription has ended. Reading still works; tell them, and that they can renew on their Universal Mail page. Do not retry.' },
    NOT_A_SYSTEM_EMAIL: { remedy: 'Only the server\'s own emails can be discarded this way. Nothing was changed.' },
    // ── Opening messages safely ──
    'MAIL-PARSE-UNSAFE': { remedy: 'This email couldn\'t be opened safely. Tell the owner to open it in their mail app; don\'t try again.' },
    'MAIL-PARSER-UNAVAILABLE': { remedy: 'Emails can\'t be opened right now. Wait a minute, then try once more.' }
};
// A code nothing has a remedy for gets the general one (POL-07 prevents it).
export const remedyFor = (code) => TOOL_CODES[code]?.remedy ?? TOOL_CODES.MAIL_OPERATION_FAILED.remedy;
//# sourceMappingURL=toolCodes.js.map