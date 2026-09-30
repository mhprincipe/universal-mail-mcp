# Testing

Universal Mail is built test-first: write the test, see it fail for the right
reason, write the least code that passes, run everything green, record the
cycle. The plan is [TEST-PLAN-V2.md](TEST-PLAN-V2.md) (every test by ID, with
totals); the history is [TDD-JOURNAL.md](TDD-JOURNAL.md) (every red-green cycle,
every live run, every mutation check).

## Tiers

**Everything automated, in one command:** `npm run test:all` (a dependency
audit, the typecheck, the unit tier with its coverage floor, then the slow tier).

| Tier | Command | What it proves | Needs |
|---|---|---|---|
| **Unit** | `npm test`, or `npm run coverage` (with the floor) | logic, recovery rules, the tools over real HTTP and MCP with the mail server faked, setup against a fake Google, the page, sign-in | nothing; it can't reach the internet (`testkit/src/networkGuard.ts`) |
| **Slow** (protocol and package) | `npm run test:protocol` | real behaviour: every tool against real IMAP servers (Dovecot in Docker) in each provider's layout, through a fault proxy that records every command and can break the connection; the built `setup.js` in a real terminal; the server image | Docker Desktop running |
| **Live** | [LIVE-TEST-PROMPT.md](LIVE-TEST-PROMPT.md), run by the owner | a real mailbox, a real AI app, real timings from the tool log | an installation |

`npm run typecheck` and the audit (`npm audit --omit=dev --audit-level=high`) run in CI too. CI runs both automated tiers on every push;
a release runs them again before building.

## What's proven where

| What | Automated tiers | Live |
|---|---|---|
| The 17 tools, their rules and answers | unit (faked mail) and slow (real IMAP/SMTP servers in Yahoo, Gmail and minimal layouts, with broken connections) | the live-test prompt on Yahoo (every tool, with Claude and with ChatGPT); Gmail connected, its full prompt not yet run |
| Provider quirks | slow tier, with the fault proxy imitating each (for example Yahoo's missing header search) | found on Yahoo, then turned into tests |
| Sign-in (identity documents, PKCE, tokens, approval, passkeys, grants) | unit, with Claude's and ChatGPT's real published documents and a software passkey | Claude and ChatGPT connected and approved |
| Your page | unit, over real HTTP with a session, forms and a software passkey; every page checked with axe's accessibility rules (A11Y-01) | used on a desktop browser; the phone test is open; not yet with a screen reader |
| Attachments (2.4) | unit (each kind through the worker, damaged and hostile files, the limits) and slow (a PDF and an image from a real IMAP server; the built image reads a PDF) | not yet |
| Scam warnings, first-time recipients, send limits, activity and undo (2.4) | unit, and recipients against a real Sent folder (slow) | not yet |
| Setup | unit against a simulated Google; the built `setup.js` in a real terminal (slow tier) | the owner's install (2026-09-28) |
| The server image and the release pipeline | slow tier (image, publishing scripts); CI and the release workflow | every release, verified afterwards (OPERATIONS.md) |
| Subscription and the license service | unit | not yet: Paddle's sandbox |
| Timings | none (they depend on the provider) | the tool log's `phases` from live runs |
| The owner's own mailbox, now | **Check that everything works** on the page (per account: saves a test message, marks, flags and moves it, and leaves it in Trash, with a "Universal Mail check" folder) | on demand |

## How the tests reach the product

- **Direct mode** (`AUTH_MODE=bearer`, one shared secret) is how the test kit
  drives the whole product over real HTTP and MCP without a sign-in dance.
  Setup never installs it: installations are always `builtin`.
- **Built-in sign-in** is tested on its own (`tests/signin/`) and through the
  page, with grants made directly where a test is about something else.

## Rules

- **Test IDs are unique.** Check the plan's highest ID in a group before naming
  a new test (two collisions happened: ENG-14/15 and SIG-54).
- **A test that passes the first time it runs is mutation-checked**: break the
  code it protects and see it fail. Mutants that survive mean a missing case,
  and the case is added. The journal records each check (for example 12 of 12).
- **The coverage floor only rises** (`vitest.config.ts` thresholds; raised to
  93/83/94/96 on 2.3.1 and to 93/84/94/96 on 2.4.0, the levels the suite reaches).
- **Nothing reaches a real mailbox from the automated tiers.** Live checks on
  the owner's mailbox are read-only unless the owner asks for more.
- **Write test code with an editor, not through shell-quoted scripts**: twice a
  script turned `\b` into a backspace and dropped a `\s`, and a test passed
  that could never have failed. After scripted edits, search the files for
  control characters.

## The test kit (`testkit/src/`)

| File | For |
|---|---|
| `imapServer.ts`, `profiles.ts`, `seed.ts` | a real Dovecot per provider layout (Yahoo-like, Gmail-like, minimal), seeded with messages |
| `faultProxy.ts` | sits in front of the server: `lines()` records every command; rules can drop the connection, blank header searches (Yahoo), or add delay |
| `smtpCapture.ts` | a real SMTP server that keeps what was sent |
| `product.ts` | the whole product in-process against those servers, driven over MCP |
| `toolFixture.ts` | the tool layer over real HTTP/MCP with an in-memory mailbox (unit speed) |
| `attachments.ts` | real PDF, Word and PNG files, and messages carrying them |
| `fakeGoogle.ts`, `fakeGcloud*.{ts,mjs}`, `setup.ts` | setup's world: Google Cloud faked, answers scripted |
| `softwareAuthenticator.ts` | a passkey, for the fingerprint approval |
| `canary.ts` | values that must never appear in logs, pages or answers |
| `fakeClock.ts`, `networkGuard.ts`, `localhostTls.ts` | time, isolation, TLS for local servers |

## Live runs

Run one prompt in one app at a time, then read the tool log with its `phases`
(see [OPERATIONS.md](OPERATIONS.md)). Every live finding so far became a test
before it was fixed: batch UID pairing, the Message-ID fallback, time filters,
HTML-only mail, "Re:" subjects, stale folders on the kept connection, display
names, app passwords with spaces, the unknown-account wording.
