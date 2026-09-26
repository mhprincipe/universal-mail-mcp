# Revised supervised mailbox test plan

Requested 2026-09-18: replace the blocked disposable-account test sequence with a proposed one-function-at-a-time plan for the main Yahoo account. This document changes the test procedure only. It does not change the server architecture or safety invariants, authorize an immediate connection, or claim that the original disposable-account release gate has passed.

## Before connecting

- Confirm the main account can generate a Yahoo app password. A regular account password is not a substitute for the server's configured authentication.
- Obtain explicit permission to begin the main-account read-only stage, replacing the earlier stop-before-connecting boundary.
- Enter credentials locally; never include them in chat, reports, or source control.
- Keep SENT_COPY_MODE=unverified. Do not run sent-probe.ts or set DISPOSABLE_TEST_CONFIRMED for the main account: that script is intended for a disposable account.
- Prepare a supervised local test harness before execution. It must invoke exactly the selected operation, stop after its result, and expose no unattended agent loop or general-purpose client access.
- Test labels and folders are organizational safeguards, not account-level permission boundaries. The app password can grant broader access than the selected test.

## Sequence and checkpoints

Run one step, inspect the result and mailbox state, then select the next step. No bulk actions. Stop on any unexpected result or UNKNOWN outcome; reconcile state before any further mutation. Do not automatically repeat a send, append, draft replacement, or move.

1. list_folders: IMAP connection and folder listing only. No SMTP readiness check, body downloads, or writes.
2. search_email: user first creates a harmless self-addressed test message using Yahoo's normal interface with a unique MCP-TEST label. Search for that label with a small limit; verify the returned subject and Message-ID identify only the intended test message.
3. get_email: fetch just that message by its verified mailbox and UID. Compare unread status before and afterward. Discard the body after verification; do not log it.
4. get_thread: use that uniquely identified test message. Verify the results contain only the test conversation; no flags or bodies are changed.
5. create_folder: create one uniquely named MCP-Test folder, after checking for a collision.
6. create_draft: create a new uniquely labeled, attachment-free draft addressed only to the account itself. Record its returned mailbox, UID and Message-ID.
7. update_draft: replace only that recorded test draft. Verify the replacement before reviewing old-draft cleanup. Never select an existing personal draft.
8. mark_read: apply only to the recorded test message and verify the flag.
9. mark_unread: apply to that same test message and verify the flag.
10. flag_email: flag that test message; inspect, then make a separate call to clear the flag and inspect again.
11. move_email: move only the recorded test message to the exact test folder. Record its new UID and verify Message-ID after moving.
12. restore_email: move that message back to the exact original folder, then update its recorded UID.
13. archive_email: archive only the test message; inspect, then separately restore_email and inspect again.
14. trash_email: trash only the test message; inspect, then separately restore_email and inspect again. No permanent-delete tool or bulk cleanup.
15. send_email: deferred until the read/write tests pass and a supervised main-account-compatible Sent-copy observation procedure has been prepared and reviewed. Send one uniquely identified message to self only. Observe whether Yahoo creates a Sent copy, verify exactly one copy, and resolve uncertainty without sending again. Keep the normal send gate disabled until evidence supports the appropriate policy. Recheck for delayed duplicates before enabling normal sends.
16. reply_email: reply only to the verified test message, to self, with reply-all disabled and no Cc/Bcc. Verify the thread and Sent copy separately.

## Limits and completion

- A mailbox UID changes when moved; do not reuse the old UID. Validate the current mailbox/UID against the recorded Message-ID before every mutation. Stop on duplicate identity matches.
- Do not run deliberate live network fault injection against the main account. Keep ambiguous-failure testing on local fakes; record that real Yahoo fault injection remains unperformed.
- Do not remove test folders or messages in bulk. Leave final cleanup to the user through Yahoo's interface.
- Sequential testing reduces the scope of an error but cannot guarantee that account data will remain unaffected. Sent mail cannot be recalled by this server.
- No production deployment or unrestricted mailbox use follows automatically. Record each verified operation and all untested original release gates explicitly.

## Execution record

2026-09-18: Step 1 (list_folders) passed in the user terminal. The saved report lists 27 selectable folders and all six expected special roles. No message bodies read, mail changed, or SMTP used. Steps 2–16 remain pending.

2026-09-18: Step 2 (search_email) passed. Exactly one self-addressed message with subject MCP-TEST-20260918-01 was found in INBOX. It remains unread. Only envelope metadata and flags were fetched; no body fetch, flag change, or SMTP connection occurred. Message identity is saved locally in ../main-search-check.json for the next supervised check. Steps 3–16 remain pending.

2026-09-18: Step 3 (get_email) passed. The runner verified the account fingerprint and unique Message-ID/UID, checked the test message was unread, retrieved only that message, discarded its body without logging, and verified Seen and Flagged were unchanged afterward. The message remains unread. No mutation commands or SMTP connection occurred. Evidence: ../main-get-email-check.json. Steps 4–16 remain pending.

## Batch authorization — 2026-09-18

The user requested all remaining tests using the identified test email without per-function confirmations. The supervised sequence is authorized to continue automatically between conclusive results, using only the allowlisted test message, new test drafts and a uniquely named test folder. SMTP is capped at one self-addressed new test message and one self-addressed reply. Stop on ambiguity. All existing safety invariants remain in force. Deliberate live network fault injection is excluded on the main account; the 50 local safety tests were rerun and passed. The saved SENT_COPY_MODE remains unverified; diagnostic send policy is scoped to the integration process only.

2026-09-18 completion: All 16 operations passed across the batch and read-only recovery. The original batch failure report is retained unchanged for audit; ../main-integration-completion.json links it to the passing thread verification. Exactly two self-addressed SMTP attempts, one Sent copy each on later recheck, original Inbox/unread/unflagged restored. Updated draft and MCP-Test-2987c50d folder remain. No mutation or send repeated during recovery. Thread results warn about the bounded 200-message header fallback. Docker rebuild and Cloud Run duration/deployment checks remain pending. Local tests now total 53, all passing.
2026-09-18 21:57 UTC: Updated Docker image built and all eight checks passed on Docker 29.8.0. No mailbox connection. Evidence: DOCKER_VERIFICATION.json. This closes the Docker rebuild item above.
