# Build status — 2026-09-21

**In production and in use.** Deployed to Cloud Run with OAuth, connected to
Claude, all 16 tools verified against the live Yahoo mailbox, and sending
enabled after the Sent-copy gate passed.

Earlier revisions of this file described a local-only build with unverified
Cloud Run deployment. That is superseded.

## Current state

| | |
|---|---|
| Service | `yahoo-mail-mcp`, Cloud Run, `us-central1` |
| Resource | `https://<your-v1-service>.run.app/mcp` |
| Auth | `AUTH_MODE=oauth`, Auth0, RS256, 900-second tokens |
| Owner | one Auth0 subject; no other user can connect |
| Clients | ChatGPT and Claude registered; **only Claude works** |
| Sending | `SENT_COPY_MODE=yahoo` — **live** |
| Local gate | 145 tests, 16 files; typecheck, build and 16-tool discovery pass |
| Sizing | min 0, max 1, CPU 1, 512 MiB, timeout 300s |

## Verified against the live mailbox

All 16 tools ran against the real Yahoo account over OAuth. Every expected
success succeeded; every expected failure returned a structured code.

`list_folders` returned 28 folders with all six special-use roles resolved
through SPECIAL-USE, correctly ignoring the Outlook-leftover "Drafts", "Sent
Items" and "Junk Email" folders that carry no role.

**Reading does not mark mail read.** `get_email` and `get_thread` on an unread
message left it unread, confirmed by re-search.

**`update_draft` replaces the body cleanly** — an HTML draft updated with text
produced no HTML part, and the original draft was removed.

**Repeated `mark_read`/`mark_unread`/`flag_email` are idempotent.**

**Move, archive, trash and restore all round-tripped.** A typo'd destination
failed with `FOLDER_NOT_FOUND` without moving anything.

**The Sent-copy gate passed.** One uniquely-identified message produced exactly
one Sent copy, Message-ID matching, nothing rejected. `SENT_COPY_MODE` moved
from `unverified` to `yahoo`, in which the server never appends and therefore
cannot be the source of a duplicate.

A bounded observation cannot prove Yahoo will never create a delayed second
copy. Re-check that Message-ID before treating the result as permanent.

## Defects found and fixed on 2026-09-21

Each was caught by a test written before the fix.

**`get_thread` opened one IMAP connection per message** — 42 connections for a
40-message thread, 102 at the cap. This had already exceeded the deployed
request timeout in production. Now 2, by sharing one connection across the
folder scan and every member fetch.

**Discovery sat behind Origin validation**, so the credential-free RFC 9728
metadata document returned 403 to any browser-origin client. Moved beside
`/health`; `/mcp` and `/ready` remain validated.

**`offline_access` was not advertised**, so clients never requested a refresh
token and every connector would have died 15 minutes after consent.

**`update_draft` kept the stale HTML body.** Updating an HTML draft with text
only left the old HTML, which clients render — so the update silently appeared
to do nothing. The body is now replaced as a unit.

**Duplicate SMTP recipients.** `to`/`cc`/`bcc` were concatenated without
dedupe, so one address in two fields produced two `RCPT TO` commands. Now
de-duplicated case-insensitively.

**Response payloads were unbounded.** `MAX_MESSAGE_BYTES` caps what is fetched,
not what is returned; a single newsletter returned ~100 KB and `get_thread`
repeats that per message. Added `MAX_BODY_CHARS` (100,000 default) with
`truncated: true` so nothing is lost silently.

**The deploy script hardcoded `SENT_COPY_MODE` and `ALLOWED_ORIGINS`**, so every
deploy silently re-disabled sending. Both are now carried from the environment
and validated, and still forced off in setup mode.

**Token rejections were indistinguishable.** Seven causes returned one opaque
401. Rejections now log `{"event":"token_rejected","reason":"…"}` — the failed
check only, never a token or claim value.

**`search_email` had no `messageId` filter**, leaving the only handle that
survives a move unqueryable. Added.

## ChatGPT does not work, and it is not the server

An Apps SDK app (`asdk_app_…`) in `development` status on a personal Plus
account. Auth0 issues it a valid token for the correct owner and audience — and
the MCP server then logs **zero HTTP requests**, across the entire lifetime of
the app. Not a 401, not a 403; no request at all.

Every server-side hypothesis was eliminated by that evidence, since all of them
require a request that provably never happened. ChatGPT's own
`/backend-api/saved-credentials` returns 403 `saved_credentials_owner_required`.
Escalated to OpenAI support. No server change can affect this.

## What remains

**Known limits, accepted:** single owner by design; no attachments; no folder
rename or delete; no permanent delete; `get_thread` bounded to the 200 most
recent messages per folder.

**Worth doing:** test coverage measurement — there is none, so untested code is
unknown rather than known-small. Folder-listing is redundant, costing four IMAP
connections per `archive_email`. There is no CI. `verify-live.ts` predates OAuth
and authenticates with a secret the deployment no longer has.

**Not done and not planned:** multi-user support. The single-owner assumption is
load-bearing in the auth model, the config model and the service lifecycle, and
per-user credentials would require the credential store CODEX excludes.

## Test artifacts left in the mailbox

The `MCP-VERIFY-16` draft, the `MCP-VERIFY-SEND` message in Inbox and Sent, and
the `MCP-Test-2987c50d` folder. The connector can trash messages but cannot
delete folders, so the folder must be removed in Yahoo.

## Documentation

`docs/ARCHITECTURE.md` — how it fits together and why.
`docs/TOOLS.md` — all 16 tools, inputs, outputs, error codes.
`docs/TESTING.md` — the harness, what it proves, and its gaps.
`docs/OPERATIONS.md` — deploying, diagnosing, adding a client, enabling sending.
`docs/OAUTH_DESIGN.md`, `OAUTH_ROLLOUT.md`, `OAUTH_DIAGNOSTICS.md`,
`OAUTH_TDD.md` — the OAuth increment as built.
