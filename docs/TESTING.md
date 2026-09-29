# Testing

Universal Mail is built test-first: write the test, see it fail for the right
reason, write the least code that passes, run everything green, record the
cycle. The plan is [TEST-PLAN-V2.md](TEST-PLAN-V2.md) (every test by ID, with
totals); the history is [TDD-JOURNAL.md](TDD-JOURNAL.md) (every red-green cycle,
every live run, every mutation check).

## Tiers

| Tier | Command | What it proves | Needs |
|---|---|---|---|
| **Unit** | `npm test`, or `npm run coverage` (with the floor) | logic, recovery rules, the tools over real HTTP and MCP with the mail server faked, setup against a fake Google, the page, sign-in | nothing; it can't reach the internet (`testkit/src/networkGuard.ts`) |
| **Slow** (protocol and package) | `npm run test:protocol` | real behaviour: every tool against real IMAP servers (Dovecot in Docker) in each provider's layout, through a fault proxy that records every command and can break the connection; the built `setup.js` in a real terminal; the server image | Docker Desktop running |
| **Live** | [LIVE-TEST-PROMPT.md](LIVE-TEST-PROMPT.md), run by the owner | a real mailbox, a real AI app, real timings from the tool log | an installation |

`npm run typecheck` runs in CI too. CI runs both automated tiers on every push;
a release runs them again before building.

## Rules

- **Test IDs are unique.** Check the plan's highest ID in a group before naming
  a new test (two collisions happened: ENG-14/15 and SIG-54).
- **A test that passes the first time it runs is mutation-checked**: break the
  code it protects and see it fail. Mutants that survive mean a missing case,
  and the case is added. The journal records each check (for example 12 of 12).
- **The coverage floor only rises** (`vitest.config.ts` thresholds).
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
