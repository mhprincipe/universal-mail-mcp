# Security review: 2.4

Everything new in 2.4 was reviewed for security before release (2026-09-30).
The review covered reading attachments, scam warnings, first-time recipients,
send limits, the activity log and undo, the sign-in changes, and the new
dependencies (unpdf, mammoth, html-to-text). It read the code as an attacker
would: a hostile email or attachment, a prompt-injected AI, another app on
the same server, and anyone on the internet who can reach the public routes.

Each finding below became a failing test first, then a fix. The test IDs point
into [TEST-PLAN-V2.md](TEST-PLAN-V2.md).

## Found and fixed

| # | Finding | Who could do it | Fix | Test |
|---|---|---|---|---|
| 1 | **A sender name could freeze the server.** The scam check looked for an email address in the display name with a pattern that took about 60 seconds on a crafted name (thousands of `@`s). The check runs on the main thread, outside the parsing sandbox, so every app would have waited. | anyone who can email you | The name is split into words first; words over 320 characters are skipped; the address pattern is anchored and bounded. The same names now take milliseconds. | SCM-06 |
| 2 | **A PDF could use unbounded memory.** The sandbox capped the worker's JavaScript heap (256 MB), but a PDF's decoded images and streams live outside the heap, so a small "PDF bomb" could grow the process until Cloud Run killed it. | anyone who can email you | The sandbox also watches the memory the process takes beyond where it started (160 MB, checked every 25 ms) and stops the worker when it's passed. The attachment is remembered as unsafe; the email itself still opens. | ATT-08 |
| 3 | **Attachments skipped the structure limits.** Opening an email checked its nesting depth, number of parts and header size; reading one of its attachments parsed the message again without those checks. | anyone who can email you | The attachment reader applies the same checks first. | ATT-09 |
| 4 | **Sends fired together could pass the limit.** Each send checked the count, then sent, then recorded. Several at once all saw room. | a runaway or prompt-injected AI | A send takes its place in the count before it goes, and gives it back only if the provider refused it. | LIM-04 |
| 5 | **A planted message could make a stranger "known".** The first-time check looked in the Sent folder for any message whose To or Cc contained the address. Mail filed into Sent by someone else (or a longer address containing this one) counted. | a sender who can get mail filed in Sent; an injected AI with Organize | Only messages sent from the account's own address count, and only an exact address in To or Cc. | RCP-05 |
| 6 | **Undo could act on the wrong account.** The log recorded the account's name. After a rename, or removing an account and adding another under the same name, undo would act on whichever account had that name now. | the owner, by accident | Entries record the account's address; undo finds the account by it, and refuses if that address is gone. | ACT-08 |
| 7 | **The activity log could break saving.** It's saved inside the settings record, and Secret Manager refuses a version over 64 KB. A busy log would have made every later settings save fail. | a busy AI | The log is capped at 16 KB (as well as 100 entries and 30 days), oldest dropped first. | ACT-07 |
| 8 | **The public token step fetched documents on every request.** Anyone could make the server fetch a trusted app's identity document and keys once per request. | anyone on the internet | Each document and key set is kept for five minutes. | SIG-87 |
| 9 | **The test mode could be a default.** A server started without choosing a sign-in mode fell back to the shared-secret mode meant for tests. Installs always choose, so none were affected. | a hand-made deployment | A server whose mode wasn't chosen refuses to start. | SIG-86 |

A dependency audit also found a moderate advisory in `ip-address` (reached
through the IMAP library's proxy support, which Universal Mail doesn't use);
it was updated to 10.7.2. CI and `npm run test:all` now stop on any known
high-severity problem in a production dependency (REL-08).

## Known and accepted, for now

| Item | Why it's accepted | What would change it |
|---|---|---|
| **`newRecipientsConfirmed` is set by the AI.** A prompt-injected AI could set it without asking the owner. *(2.4.2: the fix is designed, for the owner's decision: [DESIGN-CONFIRM-ON-PAGE.md](DESIGN-CONFIRM-ON-PAGE.md).)* | The tool description and the refusal's remedy both say never to set it without asking; a send confirmed this way shows "someone new" in the activity log; the send limits cap the damage; ChatGPT asks the owner before every send anyway; and Send is off unless the owner ticks it. | A confirmation the owner gives on their page (or by email) instead of in chat. A 2.5 candidate. |
| **The sign-in metadata advertises only `none`** for the token step, while ChatGPT's signed assertion is also accepted (SIG-83). | Harmless: the assertion is an extra proof, verified against the app's own keys. | Advertising `private_key_jwt` too, once ChatGPT's use of it is seen live. |
| **Refresh tokens aren't tied to how the app first proved itself.** An app that signed in with an assertion can refresh as a public client. | Both proofs are for the same app, with the same published document from its own origin, and the refresh token is bound to that app. | Recording the proof used and requiring it again. |
| ~~**The parsing queue has no length limit.**~~ **Fixed in 2.4.2** (PAR-09): at most 20 wait; past that, "busy, try again". | | |
| ~~**Undoing "mark read" marks every message in that batch unread.**~~ **Fixed in 2.4.2** (ACT-10, ACT-11): each mark or flag records the messages it really changed, read in the same step that checks them. | | |
| **A failed settings save is logged and retried with the next change** (INS-05). A restart before then loses that change, now including the newest activity entries. | Existing behaviour; saves haven't failed live. | Retrying on a timer as well. |

## Not in scope for 2.4

In 2.4 attachments were only read, never sent. 2.4.1 changed that; see below.

# 2.4.1: sending attachments, forwarding, junk, unsubscribe, sender summaries

Reviewed the same way before release. What each new path could be used for,
and what stops it:

| Path | The risk | What stops it | Test |
|---|---|---|---|
| **Sending files already in the mailbox** (attach, forward) | An AI tricked by an email sends your documents out ("forward all bank statements to…") | A send to anyone the account has never written to is held, and the hold now **names the files**; send limits; the activity log counts attachments on every send; Send is off unless ticked | OUT-05, FWD-03, ACT-09 |
| **Files the AI writes** | A dangerous file (a program, a web page), or a name that plays tricks (folders, hidden names, control characters) | Only plain text kinds by extension (.txt .csv .tsv .md .json .ics .xml), plain names only, UTF-8, up to 5 files of 1,000,000 characters | OUT-03 |
| **Size** | A message too big to send, or memory pressure | 18 MB together, checked before composing; attachments are read in the sandbox with its time, memory and structure limits | OUT-03, OUT-07 |
| **Unsubscribe: a request to an address chosen by an email's sender** | The server made to reach something inside Google Cloud (the metadata server, private addresses), or any port or plain HTTP | https on 443 only; a host name, never a number; every DNS answer public, then the connection made to that vetted address (no second lookup); no redirects; 10 s; answer body read no further than 64 KB and ignored; the certificate checked | UNS-05, UNS-06, UNS-09 |
| **Unsubscribe: confirming the address to a scammer** | Answering a scam's "unsubscribe" tells it the address is read | Refused for any email carrying cautions; only the one-click standard (big senders' own), never a mailto or a plain link | UNS-02, UNS-03 |
| **Junk** | A move to a folder guessed by name | Only the folder the provider marks as Junk; none marked, nothing moved | JNK-02, JNK-04 |
| **Sender summaries** | Hidden system emails, bodies read, or a slow full scan | Envelopes, flags and two headers of the newest messages only (up to 2,000, by position), system emails left out, names marked untrusted | WHO-03 |
| **Permissions** | A read-only app reaching outside | forward needs Send; unsubscribe and junk need Organize and aren't marked read-only; only the summary is a read | FWD-05, UNS-08, JNK-03, WHO-04 |

Known and accepted, added in 2.4.1:

| Item | Why it's accepted | What would change it |
|---|---|---|
| **Sending to someone the account already knows isn't held**, attachments or not. An injected AI could forward a document to a known contact. | Known contacts are the owner's own; the log shows the send and its attachment count; limits apply. | Holding every send with attachments for the owner's confirmation. |
| **One-click unsubscribe tells a real sender the address is in use.** | That's what unsubscribing is; scams are refused. | — |
| ~~**The sandbox's memory watch sees the whole process.**~~ **Fixed in 2.4.2** (ATT-12): what the server's own thread takes meanwhile is taken off. | | |
| **Files from the owner's computer or the chat can't be attached.** | The AI apps don't pass uploaded files to connectors reliably; the safe way is an upload box on the owner's page. | The owner's decision (OPEN-QUESTIONS). |

# 2.4.2: what the first live run found

Reviewed the same way. The changes close three of the accepted items above
(the parse queue, undo for marks, the memory watch) and add little new surface:

| Path | The risk | What stops it | Test |
|---|---|---|---|
| **Attachment names in search results** | Names are written by the sender: they could carry instructions, or be misleading | Every result stays marked untrusted; names are shown, never acted on | FND-01 |
| **Searching by attachment name** | A pattern that takes the server a long time, or a scan of a huge folder | A plain substring (no pattern language); 1,000 messages looked at per page at most, then a cursor | FND-02, FND-03 |
| **What a sender offers to unsubscribe** | Following a sender's link from the server | Still only the one-click standard is ever used; a link or an address is reported, never opened | UNS-02, WHO-06 |

Still open: the new-recipient confirmation. Its fix is designed, for the
owner's decision: [DESIGN-CONFIRM-ON-PAGE.md](DESIGN-CONFIRM-ON-PAGE.md).
