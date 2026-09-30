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
| **`newRecipientsConfirmed` is set by the AI.** A prompt-injected AI could set it without asking the owner. | The tool description and the refusal's remedy both say never to set it without asking; a send confirmed this way shows "someone new" in the activity log; the send limits cap the damage; ChatGPT asks the owner before every send anyway; and Send is off unless the owner ticks it. | A confirmation the owner gives on their page (or by email) instead of in chat. A 2.5 candidate. |
| **The sign-in metadata advertises only `none`** for the token step, while ChatGPT's signed assertion is also accepted (SIG-83). | Harmless: the assertion is an extra proof, verified against the app's own keys. | Advertising `private_key_jwt` too, once ChatGPT's use of it is seen live. |
| **Refresh tokens aren't tied to how the app first proved itself.** An app that signed in with an assertion can refresh as a public client. | Both proofs are for the same app, with the same published document from its own origin, and the refresh token is bound to that app. | Recording the proof used and requiring it again. |
| **The parsing queue has no length limit.** Many large reads at once wait in memory. | One owner, one server instance, and each read is size-limited. | A queue limit that answers "busy" beyond it. |
| **Undoing "mark read" marks every message in that batch unread**, including any that were already unread before. | Minor and visible; the log doesn't record each message's earlier state. | Recording which messages actually changed. |
| **A failed settings save is logged and retried with the next change** (INS-05). A restart before then loses that change, now including the newest activity entries. | Existing behaviour; saves haven't failed live. | Retrying on a timer as well. |

## Not in scope

Attachments are only read, never sent or saved, so nothing in 2.4 lets an AI
move a file out of the mailbox except by quoting it in an email, which the
first-time check and the send limits already cover.
