# Operations runbook

Day-to-day running, deploying, and diagnosing. Written from what actually went
wrong, not from what should theoretically go wrong.

## Deploying

The release flow is a ZIP into Cloud Shell, because Cloud Shell keeps its own
checkout and will not otherwise see your changes.

### One command

```bash
mkdir -p ~/ymm-<version> && unzip -o ~/<release>.zip -d ~/ymm-<version> && cd ~/ymm-<version>
```

```bash
bash scripts/release.sh --apply
```

That runs the whole process: preflight, `npm ci`, the local gate, the
deployment, and the post-deploy remote checks. It carries the owner, client
allowlist and Sent mode for you, so there are no exports to forget.

Three modes:

| Command | Does |
|---|---|
| `bash scripts/release.sh` | preview — local gate and deployment plan, changes nothing |
| `bash scripts/release.sh --apply` | the full release |
| `bash scripts/release.sh --check` | remote checks only; no build, no deploy |

Every identifier has a default and can be overridden from the environment:
`OAUTH_OWNER_SUB`, `OAUTH_CLIENT_IDS`, `SENT_COPY_MODE`, `ALLOWED_ORIGINS`,
`PROJECT`, `REGION`, `SERVICE`, `OAUTH_RESOURCE`. It never touches secrets —
Yahoo credentials stay in Secret Manager.

If `SENT_COPY_MODE` is anything other than `unverified` it confirms before
deploying, because that setting makes sending live. Pass `--yes` to skip.

`--check` is the one to run when something looks wrong: it verifies health,
discovery (including the four advertised scopes and browser-origin
reachability), the 401 challenges, and prints the last hour of token-rejection
reasons.

### The same thing by hand

```bash
npm ci && npm run verify
```

`npm ci` alone is not enough — `verify` is what produces `dist/`, and the deploy
script lives there. Stop if `verify` fails.

```bash
export OAUTH_OWNER_SUB='auth0|…' \
       OAUTH_CLIENT_IDS='tpc_…,https://claude.ai/oauth/mcp-oauth-client-metadata' \
       SENT_COPY_MODE='yahoo' \
       ALLOWED_ORIGINS=''
```

```bash
node dist/scripts/deploy-oauth.js activate --apply
```

Drop `--apply` to preview without changing anything.

### `activate --apply` replaces the entire environment

This is deliberate — no stale credential or auth switch survives a deploy — but
it means **anything you set with `gcloud run services update` is erased by the
next deploy.** Everything must come from those exports.

`SENT_COPY_MODE` and `ALLOWED_ORIGINS` used to be hardcoded, which silently
re-disabled sending on every deploy. They are now carried from the environment,
validated, and still forced off in `setup` mode.

### What the script does for you

Checks Auth0's live discovery matches the pinned issuer and aborts before
touching Cloud Run if not. Confirms the Cloud Run canonical URL still equals
`OAUTH_RESOURCE`. Writes `verification/oauth-rollback-<timestamp>.json` with the
current revision and traffic — **keep that file.** Re-runs `npm run verify` and
refuses to deploy on failure. Then re-checks public discovery and the 401
challenges.

Success reads: `PASS: public OAuth discovery and unauthenticated rejection.`

### Rollback

```bash
gcloud run services update-traffic yahoo-mail-mcp --project=yahoo-mail-mcp --region=us-central1 --to-revisions=RECORDED_REVISION=100
```

Use the revision from the saved rollback record, not a guess. Rolling back to a
bearer-era revision also restores bearer authentication.

### Note on `deploy.sh`

The legacy `scripts/deploy.sh` refuses to run against an OAuth service, on
purpose, so it cannot silently downgrade you to a shared secret. It also cannot
perform a first deploy, because it requires an existing service.

## Diagnosing a failure

### Is the service healthy?

```bash
curl -s https://<host>/health
curl -s https://<host>/.well-known/oauth-protected-resource/mcp
```

Both should be 200 without credentials. The discovery document should list your
resource, issuer, and four scopes including `offline_access`.

### Did the client reach us at all?

```bash
gcloud logging read 'logName="projects/<project>/logs/run.googleapis.com%2Frequests" AND resource.labels.service_name="yahoo-mail-mcp"' --project=<project> --limit=30 --format='table(timestamp,httpRequest.requestMethod,httpRequest.status,httpRequest.requestUrl)'
```

**Use the requests log, not container stdout.** The app emits almost no
application logs, so a stdout query shows startup lines and nothing else no
matter how much traffic arrives. That distinction cost hours once.

| Result | Meaning |
|---|---|
| no entries | the client never called. Not a server problem |
| 403 | Host or Origin rejected |
| 401 | token rejected — read the reason below |
| 200 | it is working |

### Why was the token rejected?

```bash
gcloud logging read 'resource.labels.service_name="yahoo-mail-mcp" AND jsonPayload.event="token_rejected"' --project=<project> --limit=10 --format='table(timestamp,jsonPayload.reason)'
```

| Reason | Fix |
|---|---|
| `azp_not_allowed` | the client's `azp` is not in `OAUTH_CLIENT_IDS`. See the CIMD note below |
| `azp_missing` | the provider omitted `azp` |
| `sub_mismatch` | wrong Auth0 user, or `OAUTH_OWNER_SUB` is wrong |
| `scope_missing` | RBAC is on but permissions are not in the access token |
| `lifetime_too_long` | the Auth0 API token lifetime exceeds 900s. Default is 86400 |
| `jwt:…:aud` | audience mismatch — the `resource` parameter did not map |
| `jwt:ERR_JWS_INVALID` | not a JWT. Usually an unauthenticated probe; harmless in isolation |
| `unknown` | an error without a reason — report it |

All of these return an identical opaque 401 to the client. The log is the only
way to tell them apart.

## Adding a new AI client

Two steps, neither automatic.

**1. Register it in Auth0.** Applications → Create Application → **Import from
URL**, and paste the client's CIMD document URL. Auth0 will not accept an
unknown CIMD URL at `/authorize`; it fails with `Unknown client` *before* the
login page, which looks like "nothing happened".

Claude's is `https://claude.ai/oauth/mcp-oauth-client-metadata`.

Then authorize it on the API's **Application Access** tab.

**2. Add it to `OAUTH_CLIENT_IDS`** and redeploy.

### The `azp` trap

Auth0 shows a CIMD client **two** identifiers: the external CIMD URL, and an
internal `tpc_…` id. They are not interchangeable, and which one lands in `azp`
is not documented.

For Claude, `azp` is the **CIMD URL**, not the `tpc_…` value — despite the
dashboard and the token-exchange log both displaying `tpc_…`. Listing both is
safe: each names one specific client and neither is a wildcard.

## Auth0 settings that matter

On the API whose identifier is exactly your `OAUTH_RESOURCE`:

| Setting | Value | If wrong |
|---|---|---|
| Maximum Access Token Lifetime | **900** | default 86400 rejects every token |
| Implicit/Hybrid Lifetime | 900 | must not exceed the maximum |
| Signing Algorithm | RS256 | only RS256 is accepted |
| Allow Offline Access | **On** | no refresh token; dies after 15 minutes |
| Permissions | `mail.read`, `mail.write`, `mail.send` | undefined scopes are dropped, producing `scope: null` |
| Enable RBAC | **On** | otherwise user assignments are ignored |
| Add Permissions in the Access Token | **On** | otherwise `scope` stays empty |
| Client Access (M2M) | **No apps** | an M2M token's `sub` is the app, never the owner |

Scope is the intersection of three things: what the client requests, what the
app may request (Application Access), and **what the user is assigned** (User
Management → Users → Permissions). The user assignment is usually the binding
constraint and the one people forget.

## Enabling sending

Sending is gated by `SENT_COPY_MODE` independently of token scope.

- `unverified` — both send tools fail before SMTP. The default
- `yahoo` — Yahoo saves the Sent copy; the server never appends
- `append` — the server saves the copy after confirming none exists

Verify before switching: send exactly one uniquely-identified message, then
search Sent by its `Message-ID`. Exactly one copy is required. Two means both
Yahoo and the server saved one — go back to `unverified`. Zero means Yahoo's
copy is delayed; the server warns rather than resending, and you re-check later.

A bounded observation cannot prove Yahoo will never create a delayed copy.
Re-check the Message-ID hours later before trusting the result.

`yahoo` is the safer verified mode: it never appends, so the server cannot be
the source of a duplicate.

## Things that look broken but are not

**`UNKNOWN` results.** Deliberate. The server refuses to guess whether a side
effect happened.

**A write tool returning 403.** Your token lacks the scope. Check the user's
assigned permissions in Auth0, not just the application's.

**`get_thread` warning about 200 messages per folder.** Always emitted. It
means the result may be incomplete, not that something failed.

**`truncated: true`.** A body exceeded `MAX_BODY_CHARS` and was clipped. The
message says so.

**A `FOLDER_NOT_FOUND` on a folder you can see.** Matching is exact except for
`INBOX`. Check case and spelling.

**A stale UID after any write.** Expected. Re-resolve with
`search_email { messageId }`.
