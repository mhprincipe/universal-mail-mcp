# OAuth verification and deployment

## What the current evidence proves

Auth0 issued an access token for the correct owner, ChatGPT application and MCP
audience at 2026-09-19 15:51:04 UTC. The supplied Cloud Run request logs end at
15:44:29 UTC. This does not establish a token rejection by the MCP server.
The exchange event's `scope: null` does not establish the access token's scopes.
Do not disable OIDC, change identities or recreate the connector based only on
these logs. The post-exchange failure still needs reproduction and evidence.

## Reproducible red / green history

1. Added diagnostic tests and an empty implementation: **10 assertion failures**.
2. Implemented stage checks, fail-stop behavior, safe reports and endpoint checks:
   **10 passed**.
3. Added release gating tests with the local check omitted: **2 failed, 2 passed**.
4. Added the local gate: all four passed.
5. Ran diagnostics against the real local HTTP app and MCP SDK with a real RSA
   signed fixture token. Auth0 endpoints and Yahoo operations remain fakes in
   this test. The report correctly remains INCOMPLETE.
6. Full local verification: **122 tests in 16 files**, typecheck, production build
   and compiled discovery of exactly 16 tools passed.
7. At 2026-09-19 16:20 UTC the public verifier reached the deployed Cloud Run and
   Auth0 endpoints: configuration, health, resource, provider, JWKS and challenge
   all passed. Token, UserInfo, authenticated MCP, mailbox and host acceptance
   were NOT RUN. Overall result: INCOMPLETE. No redeployment was performed.

## Stages and meaning

| Stage | What is checked | What it does not prove |
|---|---|---|
| configuration | HTTPS URLs and explicit owner/client for token checks | Deployed environment values |
| health | Service is responding | Authentication or Yahoo access |
| resource | Exact resource, issuer and advertised mail.read | Actual token scopes |
| provider | Issuer, CIMD, S256, same-origin OAuth/JWKS/UserInfo endpoints | Browser callback or token exchange |
| jwks | Provider publishes RSA verification key material | A particular token is valid |
| challenge | Both protected routes reject unauthenticated requests with discovery challenge | Authenticated requests work |
| token | Real signature, issuer, audience, lifetime, owner, approved azp and mail.read | ChatGPT accepted the OAuth response |
| userinfo | Authenticated provider response has expected subject | Host-specific ID token validation or email policies |
| initialize | Actual MCP SDK initialization | Tools work |
| tools | Exact 16 names and scope declarations | Yahoo access |
| mailbox | IMAP/SMTP readiness and list_folders, no writes or sends | All live mailbox operations |
| chatgpt / claude | NOT RUN in standalone verifier | Must be tested in each actual host |

Failures stop dependent checks. Raw tokens, provider error bodies, folder names,
email bodies and exceptions are never written to the diagnostic report. Redirects
are rejected. Tokens go only to the configured MCP resource and the validated
same-origin provider UserInfo endpoint. Production authorization is unchanged.

## Cloud Shell: local tests, then public deployed checks

Extract the new package to a **new directory** to preserve the previous release.
Run from the extracted project directory:

```bash
npm ci
npm run verify
npm run diagnose:oauth
```

The public command needs no credentials and performs no deployment or mailbox
access. It writes `verification/oauth-diagnostics-latest.json` plus a timestamped
copy. Exit 1 means a failed check; exit 0 means the executed checks passed, **not
full end-to-end success**. `INCOMPLETE` and `NOT_RUN` are deliberate.

## Authenticated diagnostics

This requires a fresh access token from an authorized OAuth flow for this resource.
The suite does not extract ChatGPT's tokens or pretend a separately obtained token
is proof of ChatGPT's connection. Do not create a second OAuth application simply
to obtain a token without reviewing its registration and allowed callbacks.

If a token is already available securely, use a hidden prompt in Cloud Shell;
never paste it into chat, command arguments, files or screenshots:

```bash
read -rsp 'Access token: ' OAUTH_TEST_TOKEN; echo
export OAUTH_TEST_TOKEN
export OAUTH_OWNER_SUB='auth0|<your-owner-id>'
export OAUTH_CLIENT_IDS='<client-id>'
npm run diagnose:oauth
unset OAUTH_TEST_TOKEN
```

Only set `LIVE_READ_CONFIRMED=yes` when ready for the readiness/list-folders stage.
No mutation or email sending is performed. The existing disposable-account
workflow and ambiguous-send tests remain separate from this read-only diagnostic.

## Actual host acceptance gate

For each host, record one attempt's UTC time, the selected client registration,
successful provider login/exchange, resulting connected-account status, tool
discovery, and one read-only list_folders call. Correlate that attempt with Cloud
Run request logs. A successful token exchange alone is not acceptance. If no
post-exchange MCP request is logged, collect the host error and provider events;
do not change the server's owner/client allowlist speculatively. ID-token, refresh,
browser consent/callback and host UserInfo behavior require this actual host gate;
the standalone diagnostic cannot attest them. No automatic retry of mutations.

## Deployment gate

The existing `node dist/scripts/deploy-oauth.js activate --apply` now runs local
verification before deploying and public diagnostics after deployment. It preserves
the existing rollback record, pinned resource/issuer, owner/client restrictions,
sending-disabled setting and Cloud Run sizing. Local failure prevents deployment;
remote failure fails the run without automatic redeployment or rollback.

Docker/cloud build, real OAuth tokens, both actual host connections, and live Yahoo
acceptance are separate evidence gates. A local 122-test result is not a deployment
or end-to-end completion claim.
