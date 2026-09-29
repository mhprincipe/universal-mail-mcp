# OAuth rollout: what to do and why

This release adds OAuth server behavior. Local tests are not proof that ChatGPT or Claude has logged in. Do not create either connector until its prerequisite gate passes. Keep this guide with the source revision used for deployment.

## 1. Verify locally, then publish discovery in setup mode

The OAuth client needs to discover who issues tokens before it can log in. The old bearer-only deployment has no discovery endpoint; a 404 there prevents setup. `oauth-setup` solves that ordering problem: metadata is public, but every `/mcp` and `/ready` request is rejected, even with a valid token. Yahoo credentials and the old access secret are removed from the new revision.

Upload the supplied release ZIP to Cloud Shell, then run one block at a time:

```bash
mkdir -p ~/yahoo-mail-mcp-oauth
unzip -o ~/yahoo-mail-mcp-oauth.zip -d ~/yahoo-mail-mcp-oauth
cd ~/yahoo-mail-mcp-oauth
npm ci
npm run verify
```

`npm ci` installs the locked dependencies. `verify` runs types, isolated tests, build, and local MCP discovery without loading your `.env`. Stop on failure. The separate folder preserves your previous Cloud Shell checkout.

```bash
node dist/scripts/deploy-oauth.js setup
```

This previews the intended mode and addresses without changing Google Cloud. Confirm the project, resource and issuer match the existing service and Auth0 tenant. Then:

```bash
node dist/scripts/deploy-oauth.js setup --apply
```

The script checks the public Auth0 issuer metadata, confirms the Cloud Run canonical URL, records existing revision traffic, builds and deploys, then checks public resource metadata and unauthenticated 401 challenges. It deliberately replaces environment settings for this single-account service. Timeout stays 300 seconds, min/max instances 0/1, CPU 1, memory 512 MiB. Sending stays disabled (`SENT_COPY_MODE=unverified`). Google Cloud builds the container; Docker has not been run locally for this increment.

**Expected checkpoint:** `PASS: public OAuth discovery and unauthenticated rejection.` Save the output. A 404 is a failed checkpoint. Do not work around it by selecting no authentication. Setup mode intentionally interrupts legacy mailbox access. A successful setup deployment is not yet a usable connector.

## 2. Complete the identity and client registrations

Auth0 is the login authority; the MCP server owns the mailbox permissions. These are different jobs.

- Confirm the API identifier equals the exact MCP resource URL, RS256 signing, maximum token lifetime no more than 900 seconds, and the three scopes `mail.read`, `mail.write`, `mail.send`.
- Use per-application user-delegated access. Keep machine-to-machine access disabled. Explicitly authorize each client; do not grant every third-party application access.
- Enable offline access when configuring refresh-token support and require user consent. Confirm saved values rather than assuming a toggle click persisted.
- Identify the actual Auth0 login user and its exact `sub`. Dashboard administration membership alone does not identify the mailbox owner. The server restricts all requests to this one subject.
- Resource parameter compatibility is needed for clients that send `resource` instead of Auth0's `audience`. CIMD can be used when the client and provider support it. Open dynamic registration is not required for a manually approved client.

After Gate 1, return to ChatGPT's existing draft and inspect Advanced OAuth settings. Use the exact client metadata URL and redirect URI supplied by ChatGPT. Import that metadata into Auth0 and authorize only `mail.read` initially. Do not invent callback URLs. The stable ChatGPT client metadata URL requires issuer-identification support; the previously inspected tenant did not advertise that support, so a callback-specific URL may be required.

Record the client identity that Auth0 places in the token's `azp` claim. An Auth0 internal application ID and an external CIMD URL are not automatically interchangeable. Check this locally without printing or sharing a token. The current verifier requires exact `azp` matches; if a provider issues a different documented claim shape, add a failing test and implement that deliberately before activation.

Register Claude separately using its current supported registration flow and exact callback information. Grant `mail.read` initially. A test token with `azp=claude` is a local fixture, not proof of registration with the real Claude application.

## 3. Activate for the approved owner and client

Only after those identities are established, enter the non-secret identifiers in Cloud Shell:

```bash
read -r -p 'Exact Auth0 owner subject: ' OAUTH_OWNER_SUB
read -r -p 'Approved token azp values, comma separated: ' OAUTH_CLIENT_IDS
export OAUTH_OWNER_SUB OAUTH_CLIENT_IDS
node dist/scripts/deploy-oauth.js activate
```

Preview first. The script refuses missing identities or wildcard access. Then run:

```bash
node dist/scripts/deploy-oauth.js activate --apply
```

Activation restores only the Yahoo email/app-password Secret Manager references. The legacy MCP secret stays absent. It still disables sending. This command validates public discovery and rejection without a token; the next gate validates real authorized use.

## 4. Prove each real client independently

For ChatGPT, complete consent and ask only to list folders, search a designated test email, retrieve it, then retrieve its thread. Confirm reads do not mark messages read. Repeat independently in Claude. A passing ChatGPT check cannot stand in for a Claude check.

Verify expired tokens are rejected and the client renews access through its refresh flow. Disconnect/revoke and confirm new authorization is required as appropriate: an already-issued JWT may remain valid until its short expiration. Verify wrong owner, wrong client and missing scope are rejected. Never paste tokens, client secrets or message bodies into the chat or test reports.

Only after read-only acceptance should `mail.write` be granted and tested against designated disposable drafts/folders. `mail.send` additionally requires the existing Sent-copy and ambiguity safeguards to pass; granting a scope does not enable sending while `SENT_COPY_MODE=unverified`. Never retry an uncertain SMTP send automatically.

## Rollback and failure handling

Every apply writes `verification/oauth-rollback-<timestamp>.json`, containing only revision names and traffic percentages. Keep it. If post-deployment checks fail, the script stops and does not automatically restore a less restrictive legacy authentication mode.

Inspect the recorded revision before deliberately restoring traffic:

```bash
gcloud run services update-traffic yahoo-mail-mcp \
  --project=yahoo-mail-mcp --region=us-central1 \
  --to-revisions=RECORDED_REVISION=100
```

Replace `RECORDED_REVISION` with the saved value, not a guessed revision. For a prior traffic split, restore the recorded percentages. Restoring a bearer-era revision also restores its old authentication behavior and secret references. The old `scripts/deploy.sh` now refuses an existing OAuth service rather than silently downgrading it.

## What the automated tests establish

Real signed JWTs go through production verification and real HTTP/MCP transport. Both fixture client identities exercise all 16 tools against a simulated mailbox. Negative tests cover owner/client/audience/issuer, timestamps, algorithms, secrets, scopes, malformed requests, concurrent identities, signing-key rotation and provider outage. Setup tests prove metadata works while protected calls fail. Deployment-plan tests check identity prerequisites, configuration delimiters and resource limits.

Still external acceptance gates: Auth0's actual token claims, interactive consent, real refresh behavior, both client applications, the Google Cloud build and deployment commands, and live Yahoo behavior under OAuth. We do not label those passed based on a local fixture.

References: [Cloud Run deployment flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/deploy), [OpenAI OAuth integration](https://developers.openai.com/plugins/build/auth), [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
