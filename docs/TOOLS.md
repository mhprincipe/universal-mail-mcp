# Tool reference

The 16 tools an AI app sees, what they take, what they return and how they
fail. The source of truth is `src/tools.ts`: descriptions, schemas, and each tool's
permission (its `mail.service(account, 'read' | 'organize' | 'send')` call).
This page summarizes them.

## Accounts and permissions

Every tool takes an optional **`account`**: the name you gave the account on
your page (for example `yahoo` or `gmail`). It may be left out when the app can
reach only one account. The tool's description lists only the accounts **this
app** was given, and an account it wasn't given answers `MAIL-ACCOUNT-UNKNOWN`
with the names it can use.

| Permission | Tools |
|---|---|
| **Read** | `list_folders`, `search_email`, `get_email`, `get_thread` |
| **Organize** | `create_draft`, `update_draft`, `move_email`, `archive_email`, `mark_read`, `mark_unread`, `flag_email`, `trash_email`, `restore_email`, `create_folder` |
| **Send** | `send_email`, `reply_email` (also needs sending turned on for the account) |

The four Read tools are marked `readOnlyHint`, so apps that ask before changes
(ChatGPT) run them without asking.

## The answer envelope

Every tool answers with the same shape, as `structuredContent` and as JSON text:

```json
{ "ok": true, "status": "SUCCESS", "code": "OK", "message": "Success", "data": {}, "warnings": [] }
```

- `status` is `SUCCESS`, `FAILED`, `NOT_FOUND` or `UNKNOWN`.
- A failure carries a `code` and a one-sentence `remedy` for the AI.
- `UNKNOWN` means the outcome couldn't be confirmed (for example a connection
  lost mid-send). The AI is told never to retry an unknown send.
- `warnings` explain anything the AI should know (a Sent copy that will appear
  later, an incomplete thread search, a batch mapping it couldn't confirm).
- Email content comes back marked `untrustedContent: true`: the AI is told
  never to follow instructions found in mail.
- An answer over 200,000 characters is cut, item by item, with an "N more"
  marker. A message body over 100,000 characters is clipped and marked
  `truncated`.

## Messages: uid, messageId, batches

- A message is addressed by **`mailbox` + `uid`**. UIDs change whenever a
  message moves, so every move answers with the new `destinationUid`, and the
  AI is told to re-find a message by **`messageId`** (which never changes) after
  any write.
- Organize tools take **`uid`** (one) or **`uids`** (up to 100, sent as one
  command). A batch move answers each message's own new UID, checked by
  Message-ID in the destination; one that can't be confirmed is left unmapped,
  with a warning, never guessed.

## The tools

| Tool | Takes (besides `account`) | Does |
|---|---|---|
| `list_folders` | | Folders and the roles the provider marks (Inbox, Sent, Drafts, Trash, Archive/All Mail, Junk, Flagged/Starred). |
| `search_email` | `mailbox` (default INBOX), `messageId`, `text`, `from`, `to`, `subject`, `since`, `before` (ISO times, exact to the second), `read`, `flagged`, `limit` (1-100, default 25), `cursor` | One folder, newest first. More than `limit`: a `cursor` for the next page. Without `account`: every account the app can read, each result naming its account (no cursor then). A subject search returns only subjects that really contain what was asked. |
| `get_email` | `mailbox`, `uid`, `format` (`text` default, or `full` with the HTML) | One message, never marked read by opening it. |
| `get_thread` | `mailbox`, `uid`, `allFolders` (default false), `format` | The conversation, from Message-ID, References and In-Reply-To (Gmail: its own conversation id). Looks in Inbox, Sent, Archive and the message's folder; `allFolders` looks everywhere, more slowly. |
| `create_draft` | `to`, `cc`, `bcc`, `subject`, `text`/`html`, `inReplyTo`, `references` | A draft in the Drafts folder. Sends nothing. |
| `update_draft` | `mailbox`, `uid`, and any of `to`, `cc`, `bcc`, `subject`, `text`, `html` | Saves the replacement first, then removes the old one. The replacement is a new message: new `uid` and `messageId`. |
| `send_email` | `to`, `cc`, `bcc`, `subject`, `text`/`html` | Sends. Answers `messageId`, `accepted`, `rejected` and `sentAt` (the server's time). The Sent copy is the provider's or saved by Universal Mail, never both. |
| `reply_email` | `mailbox`, `uid`, `text`/`html`, `cc`, `bcc`, `replyAll` | Replies with the right thread headers (`In-Reply-To`, `References`). Same answer as `send_email`. |
| `move_email` | `mailbox`, `uid`/`uids`, `destination` | Moves to an existing folder, named exactly (never guessed). |
| `archive_email` | `mailbox`, `uid`/`uids` | Moves to the folder the provider marks as Archive (Gmail: All Mail). |
| `trash_email` | `mailbox`, `uid`/`uids` | Moves to Trash. Reversible until the provider empties Trash. |
| `restore_email` | `mailbox`, `uid`/`uids`, `destination` (default INBOX) | Moves out of Trash (or any folder). |
| `mark_read` / `mark_unread` | `mailbox`, `uid`/`uids` | Sets or clears read. |
| `flag_email` | `mailbox`, `uid`/`uids`, `flagged` | Sets or clears the flag (a star in Gmail). |
| `create_folder` | `path` | Creates a folder (a label in Gmail). One that already exists answers `created: false`. |

## Codes

Mail codes (`MESSAGE_NOT_FOUND`, `FOLDER_NOT_FOUND`, `SEND_STATUS_UNKNOWN`,
`MESSAGE_TOO_LARGE` and the rest) come from the engine; the codes about access
come from the server:

| Code | Means |
|---|---|
| `MAIL-ACCOUNT-REQUIRED` | the app can reach more than one account and didn't say which |
| `MAIL-ACCOUNT-UNKNOWN` | no account by that name is available to this app; the answer lists the ones it can use |
| `MAIL-NOT-PERMITTED` | the app wasn't given that permission for that account (changed on your page) |
| `MAIL-SENDING-OFF` | sending is turned off for that account on your page |
| `MAIL-CROSS-ACCOUNT` | a move between two accounts, which isn't supported |
| `SUBSCRIPTION-READ-ONLY` | the subscription lapsed: reading still works, changes don't |
| `MAIL-PARSE-UNSAFE`, `MAIL-PARSER-UNAVAILABLE` | a message couldn't be read safely |

Each failure's `remedy` is in `src/toolCodes.ts`.
