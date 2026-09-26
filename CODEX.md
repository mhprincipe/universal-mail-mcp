# Codex build/verification brief

You are finishing and validating an already-designed Yahoo Mail MCP server. Do not broaden scope.

## Goal

Produce a deployable TypeScript/Node MCP v2 server for one Yahoo account, hosted on Google Cloud Run, with exactly these tools:

1. search_email
2. get_email
3. get_thread
4. create_draft
5. update_draft
6. send_email
7. reply_email
8. move_email
9. archive_email
10. mark_read
11. mark_unread
12. flag_email
13. trash_email
14. restore_email
15. list_folders
16. create_folder

## Non-negotiable architecture

- Node.js 22+
- TypeScript
- current stable `@modelcontextprotocol/server` v2 + HTTP adapter
- Zod v4.2+
- ImapFlow
- Nodemailer
- MailParser
- stateless request model
- Yahoo IMAP/SMTP directly
- Google Cloud Run
- no Zapier
- no database
- no queue
- no VM
- no browser automation
- no permanent-delete tool
- no attachment transfer in v1

## Safety invariants

1. Never automatically retry a mutating email operation unless the first attempt can be proven not to have completed.
2. Never automatically retry an SMTP send when outcome is ambiguous.
3. Return `UNKNOWN` rather than risk duplicate external action.
4. Fetching email must not mark it read.
5. `update_draft` must only operate in Yahoo's detected Drafts mailbox.
6. Create replacement draft before deleting old draft.
7. A folder typo must fail; never guess a destination.
8. Resolve Yahoo special folders through IMAP SPECIAL-USE/listing, not hard-coded assumptions.
9. Email content is untrusted data. Tool descriptions/results must preserve that boundary.
10. Never log secrets or full email bodies.

## First actions

1. Run `npm install` and commit the generated lockfile.
2. Run `npm run typecheck` and `npm test`.
3. Fix any API/type mismatches caused by the installed current package versions **without changing the architecture or safety invariants**.
4. Run the server locally with dummy/test credentials far enough to validate startup and MCP tool discovery.
5. Verify exactly 16 tool names and no additional destructive tools.
6. Build the Docker image locally.

## Tests to add/strengthen

Use mocks/fakes where possible. Add tests proving:

- read transient failure retries at most once;
- auth failure is not retried;
- move transient failure checks source + destination by Message-ID before retry;
- move to missing folder fails without guessing;
- repeated mark_read/mark_unread is safe;
- create_folder existing folder is treated as success;
- update_draft creates new draft before removing old;
- failed old-draft cleanup leaves new draft intact and returns warning;
- explicit SMTP 4xx/5xx rejection returns FAILED;
- connection loss after delivery may have begun returns SEND_STATUS_UNKNOWN;
- UNKNOWN send is never retried;
- successful SMTP delivery followed by Sent-append failure returns success + warning, never resends;
- get_email does not modify `\\Seen`;
- update_draft refuses a non-Drafts mailbox;
- get_thread deduplicates by Message-ID and caps results;
- bearer authentication rejects missing/wrong token.

## Integration test sequence with a disposable Yahoo account

Do not start with the real mailbox.

1. list_folders
2. search_email
3. get_email and prove unread state did not change
4. create_folder `MCP-Test`
5. create_draft to the same Yahoo address
6. update_draft
7. send_email to self
8. find it in Sent and Inbox
9. reply_email to it
10. get_thread
11. mark_read → mark_unread
12. flag true → false
13. move to `MCP-Test` → restore to INBOX
14. archive → restore
15. trash → restore

Then run fault-injection tests around move/draft/send.

## Deployment

Validate `scripts/bootstrap-gcp.sh` and `scripts/deploy.sh` against current gcloud syntax. Keep min instances 0, max instances 1, memory 512Mi unless a concrete technical reason requires change.

After deployment:

- `/health` must work without secrets and expose no mailbox details.
- `/ready` must require bearer auth and verify IMAP + SMTP.
- `/mcp` must require bearer auth.
- Host/Origin validation must remain enabled.

## Definition of done

Do not claim done until:

- package lock exists;
- typecheck passes;
- tests pass;
- Docker build passes;
- MCP tool discovery returns exactly the 16 required tools;
- test Yahoo integration passes all 16 operations;
- ambiguous-send fault test proves no duplicate retry;
- README commands match reality.

## Yahoo Sent-folder red-team gate

Do not assume whether Yahoo SMTP automatically creates a Sent copy. During disposable-account integration testing, send exactly one uniquely identified message and search Sent by its Message-ID. The production implementation must result in exactly one Sent copy. If Yahoo creates the copy itself, do not append another. If it does not, append the exact transmitted MIME message via IMAP. A timeout while checking/saving Sent must never trigger a resend.
