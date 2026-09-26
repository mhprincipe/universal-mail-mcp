# Testing harness

145 tests across 16 files. Everything runs offline — no credentials, no network,
no mailbox.

## Running it

```bash
npm run verify          # the gate: typecheck + tests + build + 16-tool discovery
npm test                # tests only
npm run typecheck       # types only
npx vitest run tests/safety.test.ts          # one file
npx vitest run -t "never retries"            # one test by name
```

`npm run verify` is what the deploy script runs before it will deploy. It writes
`verification/local-latest.json`.

## What each file covers

| File | Tests | Covers |
|---|---|---|
| `safety.test.ts` | 38 | IMAP recovery invariants, draft safety, SMTP no-duplicate rules |
| `oauth.test.ts` | 20 | token verification against real RSA signatures |
| `mcp-workflow.test.ts` | 10 | all 16 tools over real HTTP/MCP, three client identities |
| `oauth-http.test.ts` | 10 | discovery, challenges, scope enforcement, Origin handling |
| `oauth-diagnostics.test.ts` | 10 | the staged diagnostic runner |
| `verification-client.test.ts` | 9 | the typed verification client |
| `http.test.ts` | 8 | health, bearer rejection, Host/Origin, error-body leakage |
| `oauth-deploy.test.ts` | 15 | deployment argument construction and its guards |
| `oauth-integration.test.ts` | 6 | signed tokens through the real app and MCP SDK |
| `errors.test.ts` | 4 | classification and the envelope |
| `oauth-release.test.ts` | 4 | release gating |
| `thread-fallback.test.ts` | 3 | Yahoo's header-search fallback |
| `verification-runner.test.ts` | 3 | the verify orchestrator, credential isolation |
| `oauth-keys.test.ts` | 2 | JWKS rotation and provider outage |
| `smtp-wire.test.ts` | 1 | a real loopback SMTP server that drops after DATA |
| `tool-contract.test.ts` | 1 | exactly 16 tools, correct names |

## What the important tests actually prove

**Reading never marks mail read.** `safety.test.ts` asserts the read-only lock
and that `\Seen` is untouched; `mcp-workflow.test.ts` re-checks fixture state
after `get_email`.

**No mutation is retried blindly.** A transient read retries at most once; an
auth failure never retries even when its message says "timeout"; an append
failure is `UNKNOWN` and never repeated.

**An ambiguous move is verified, not guessed.** One test asserts the exact call
order — attempt, check source, check destination, retry — and five more cover
each inconclusive case returning `UNKNOWN` without a second attempt.

**SMTP never double-sends.** `smtp-wire.test.ts` runs a real SMTP server that
accepts DATA then drops the socket, and asserts exactly one connection and one
delivery attempt. A 4xx/5xx is `FAILED`; a dropped connection is `UNKNOWN`.

**Sent copies are never duplicated.** Tests cover append mode, yahoo mode, a
delayed Yahoo copy, and a Sent lookup failure — none of which resend.

**Drafts survive failure.** Replacement is created before the original is
deleted; a cleanup failure returns success plus a warning; an ambiguous append
never removes the original.

**Tokens fail closed.** Wrong issuer, audience, subject, `azp`, algorithm,
signing key, timestamps and over-long lifetimes all reject. Rejection reasons
name the failed check without ever containing a token or claim value.

**Scope separation holds.** A read token calling a write or send tool is
rejected with 403 before any mail connection opens.

## How the fixtures work

`mcp-workflow.test.ts` is the closest thing to an end-to-end test. It starts the
real Express app on a random port, connects the **real MCP SDK client** over
Streamable HTTP, and drives all 16 tools against an in-memory mailbox.

Two properties make it trustworthy:

- `ImapGateway.prototype.run` is mocked to **reject**, so any code path that
  tries to open a real connection fails loudly rather than reaching the network.
- In OAuth mode, `fetch` is stubbed to allow only loopback and the JWKS URL.
  Anything else throws `EXTERNAL_IO_FORBIDDEN`.

It runs three times — `bearer`, `chatgpt` and `claude` identities — which is how
client-independence is checked.

## Known gaps

**No coverage measurement.** There is no `--coverage` configuration, so untested
lines are unknown rather than known-small. This is the biggest gap.

**IMAP is mocked everywhere.** `ImapFlow` is spied in every test, so no real
IMAP wire behavior is exercised. Yahoo's quirks only appear live — the
header-search bug that broke `get_thread` in September was found in production,
not by these tests, and could not have been.

**`mime.ts` is barely tested** beyond Bcc handling.

**No CI.** Nothing runs automatically; the suite runs when someone runs it.

**One flaky test.** `verification-runner.test.ts` spawns child processes against
a 5-second timeout and can time out under load. It passes in isolation. If it
fails, re-run that file alone before believing it.

**No live Yahoo coverage.** `verify-live.ts` predates OAuth — it authenticates
with `MCP_ACCESS_SECRET`, which an OAuth deployment does not have, so every
authenticated stage returns 401. Use `diagnose:oauth` with a real
`OAUTH_TEST_TOKEN`, or drive the tools through a connected client.

**No load or timeout testing**, and no property or fuzz testing of the parsers.

## Adding a test

The house style is test-first. Write the failing assertion, confirm it fails for
the reason you expect, then make the smallest change that turns it green.

Most defects found in this project were found that way. The `update_draft`
stale-HTML bug, the duplicate SMTP recipient, the unbounded response payload and
the `get_thread` connection storm were each caught by a test written before the
fix — and the connection storm test failed with *42 connections for a
40-message thread*, which is a more useful failure message than "too slow".

For IMAP behavior, mock at `ImapGateway.prototype`. For end-to-end behavior, add
to the `mcp-workflow.test.ts` fixture. For token behavior, `oauth.test.ts`
already generates real RSA keys — sign a JWT with the claims you want to reject.
