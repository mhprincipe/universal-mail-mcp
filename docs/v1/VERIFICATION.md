# Repeatable MCP verification

## Commands

After `npm ci`, run `npm run verify` on Windows or Linux. It stops on the first failure, strips mail credentials from child environments, and never loads .env. It runs type checking, all unit/fault/protocol tests, compilation, and compiled server discovery. Default mail endpoints and credentials in tests are loopback/dummy; no real Yahoo access occurs.

`npm run verify -- --docker` adds the existing Docker build/container gate. Docker must be running. This gate remains separate because not every development environment can access Docker.

In the configured Google Cloud Shell project, run:

```bash
bash scripts/verify-cloud.sh --read-only-live
```

This runs the local suite, reads Cloud Run configuration, loads the bearer secret without printing it, then checks the deployed server. It does not deploy or modify cloud settings. The live verifier permits only list_folders, search_email, get_email and get_thread. No draft, move, flag, delete, or sending command can be dispatched through its tool helper. Reads are scoped to the recorded test conversation in scripts/test-message.fixture.json. The server's thread search scans threading headers across folders; its bounded-history limitation still applies.

Supply a different explicit fixture path as the second argument if the approved test conversation changes. Do not weaken the identity assertions to make a test pass. If the original was moved/deleted, restore it manually or designate a new fixture before testing.

## Results and coverage

Timestamped reports and `local-latest.json` / `live-latest.json` are saved in `verification/`, ignored by Git. Reports contain stage results, durations and safe error categories; they omit credentials, full provider errors, subjects and bodies. Live failures distinguish timeout, assertion and known network/authentication error codes. A failed run exits nonzero. No automatic mutation/send retry is part of verification.

| Layer | Evidence |
| --- | --- |
| Service/gateway unit and fault tests | Read retries, auth failure, conservative move recovery, UIDPLUS, exact folders, draft replacement, Sent-copy behavior, ambiguous SMTP outcomes |
| Real loopback SMTP fault | DATA accepted then disconnect; one attempt, UNKNOWN, no resend |
| HTTP security | Secret-free health, missing/wrong token, Host/Origin, private error suppression |
| Real HTTP/MCP fixture workflow | All 16 tools dispatched through SDK, schemas, Express, tool handlers and MailService; gateway and SMTP I/O replaced with in-memory fixtures |
| Protocol failures | Invalid send input reaches no SMTP side effect; UNKNOWN preserved through MCP; one attempted send |
| Verification-client regressions | Host actually transmitted, timeout reaches SDK v2, mutation names blocked before dispatch, errors sanitized |
| Compiled smoke | Production JS starts and exposes exactly 16 tools |
| Optional Docker | Eight container checks with dummy credentials |
| Optional read-only cloud | Configuration, HTTP security, IMAP/SMTP readiness, 16-tool discovery, test-message identity, two-message thread timing, unchanged flags |

The fixture workflow verifies real application logic but is not a substitute for provider wire behavior. Existing scoped Yahoo mutation/send results remain separate evidence; this suite never repeats them. Cloud-edge Host rejection does not by itself prove application-level Host handling; the local HTTP test exercises that layer directly.

## Test-first record, 2026-09-19

1. Wrote the verification-client regression tests before implementing their shared module. First run failed on the missing module.
2. Added the typed implementation. Eight tests passed; the error-envelope test failed because optional textual content was read before structured error handling.
3. Fixed that parser. All nine regression tests passed, including safe errors and client option forwarding.
4. Added a stateful fixture workflow over actual HTTP/MCP. All 16 existing tool operations passed without changing their production behavior. Added invalid-input and ambiguous-send protocol cases.
5. Ran the complete orchestrator: typecheck, 65 tests across eight files, build and compiled discovery passed.

For future changes: add a test for the required observable behavior, run the focused test and preserve the failure, implement the smallest fix, rerun the focused test, then `npm run verify`. Only run cloud verification for deployment/provider concerns, and never turn a non-passing security status into a passing result without explaining and testing the actual behavior.

## Remaining boundary

ChatGPT OAuth integration is not implemented or covered. The current fixed bearer token supports the SDK checks but does not establish ChatGPT custom-app compatibility. Adding OAuth requires a separately reviewed authentication change; do not expose unauthenticated mailbox tools as a workaround. A local suite pass must not be described as deployment, OAuth, or all-provider-fault completion.

6. Added three orchestrator tests for first-failure stop, test-stage failure, and credential isolation. Corrected case-insensitive Windows environment handling. Final suite: 68 tests across nine files.
