# OAuth development journal

September 19, 2026. Tests use dummy identities and no real mailbox.

## Cycle 1: a signed token must identify the owner and approved client

Wrote `tests/oauth.test.ts` first. Ran `npm test -- --run tests/oauth.test.ts`: failed because `src/oauth.ts` did not exist. This was a missing-feature red result, not 16 executed failures. Implemented configuration parsing, jose verification and the permission map. Reran: **16 tests passed**. Cases cover both client IDs, issuer, audience, subject, client, expired/future/overlong tokens, malformed scopes, missing time claims, wrong signing key, static secret rejection and configuration errors.

Why: a successful cryptographic signature alone is insufficient. An otherwise genuine token for another user or another service must fail.

## Cycle 2: enforce the boundary over HTTP

Wrote `tests/oauth-http.test.ts` before changing the app. Ran it: **7 tests failed** (metadata was 404 and OAuth requests were handled as legacy secrets). Implemented public protected-resource metadata, pinned 401 challenges, scope checks, batch rejection and conditional legacy-secret configuration. Reran: **7 tests passed**.

Why: unit tests of a validator do not prove the HTTP endpoint actually uses it. These tests isolate routing with a fake verifier; the separate cryptographic tests use real signatures. Combined real signed-token MCP workflows are explicitly the next slice, not claimed complete.

## Reproduce

From the repository folder, run `npm ci`, then `npm run verify`. This runs typechecking, all tests, the production build and local compiled MCP discovery. It strips inherited mail/OAuth settings and does not load `.env`. Latest machine-readable result: `verification/local-latest.json` (ignored in Git).

Full regression result for this increment: **91 tests across 11 files passed**, along with typechecking, production build and compiled discovery of exactly 16 tools. No Docker or cloud OAuth validation was performed for this increment.

Before release, complete the remaining acceptance gates in OAUTH_DESIGN.md. Do not bypass a failing test or broaden its accepted status codes without identifying which component produced the response and what that proves.

## Cycle 3: real signatures through MCP and a safe discovery bootstrap

Added `oauth-integration.test.ts` first: **3 failed, 2 passed**. Setup mode was unsupported and advertised tools lacked OAuth scope metadata. Implemented `oauth-setup`, which exposes metadata but denies every protected request, plus tool security metadata. The five tests then passed. Two test doubles initially returned raw data instead of typed success envelopes; typechecking caught them and the fixtures were corrected.

Expanded the stateful all-16-tool workflow to run for bearer, signed ChatGPT-fixture and signed Claude-fixture identities. These are production verification and transport paths with simulated mail I/O, not live client logins. Added key rotation, key-cache outage and algorithm rejection coverage. A clock fixture initially advanced `Date.now()` but not `new Date()`; fixed the test clock consistently rather than weakening timestamp validation. Both key tests passed.

## Cycle 4: deployment prerequisites before implementation

Added seven deployment-plan tests first. The suite failed to load because the plan module did not exist (not seven executed failures). Implemented validated argument construction for setup and activation. The CLI records prior revision traffic, checks pinned public issuer metadata, deploys with bounded Cloud Run resources, and checks discovery/401 afterward. See OAUTH_ROLLOUT.md for exact steps and remaining live gates. Deployment argument tests do not prove the external gcloud command succeeds.

Final local regression for cycles 3-4: **107 tests across 14 files passed**, plus typechecking, production compilation and compiled discovery of exactly 16 tools. No real mailbox was contacted and no cloud deployment was performed during these cycles. The local machine has no available gcloud or Docker command; Cloud Shell deployment is the next external gate.
