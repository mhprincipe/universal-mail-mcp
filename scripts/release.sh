#!/usr/bin/env bash
# One-command release for Cloud Shell. Run from the extracted project directory.
#
#   bash scripts/release.sh            preview  — local gate + deploy plan, changes nothing
#   bash scripts/release.sh --apply    release  — local gate + deploy + post-deploy checks
#   bash scripts/release.sh --check    remote checks only, no build, no deploy
#
# Never handles secrets. Yahoo credentials stay in Secret Manager; the values
# below are non-secret identifiers and may be overridden from the environment.
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT to your v1 Google project}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:?set SERVICE to your v1 Cloud Run service}"
RESOURCE="${OAUTH_RESOURCE:?set OAUTH_RESOURCE to your v1 MCP address}"

export OAUTH_OWNER_SUB="${OAUTH_OWNER_SUB:?set OAUTH_OWNER_SUB}"
export OAUTH_CLIENT_IDS="${OAUTH_CLIENT_IDS:?set OAUTH_CLIENT_IDS}"
export SENT_COPY_MODE="${SENT_COPY_MODE:-yahoo}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-}"

MODE=preview
ASSUME_YES=no
for arg in "$@"; do
  case "$arg" in
    --apply) MODE=apply ;;
    --check) MODE=check ;;
    --yes|-y) ASSUME_YES=yes ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

BASE="${RESOURCE%/mcp}"
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '   PASS  %s\n' "$1"; }
die()  { printf '\n   FAIL  %s\n\n' "$1" >&2; exit 1; }

# --- remote checks -----------------------------------------------------------
# Read-only and unauthenticated. Proves the deployed revision is the new code.
remote_checks() {
  step "Remote checks against $BASE"

  [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/health")" = "200" ] \
    || die "/health did not return 200"
  ok "/health responds without credentials"

  local discovery
  discovery="$(curl -sS --max-time 30 "$BASE/.well-known/oauth-protected-resource/mcp")"
  node -e '
    const d = JSON.parse(process.argv[1]);
    const want = process.argv[2];
    if (d.resource !== want) throw new Error("resource mismatch: " + d.resource);
    if (!Array.isArray(d.authorization_servers) || !d.authorization_servers[0]) throw new Error("no authorization server");
    for (const s of ["mail.read", "mail.write", "mail.send", "offline_access"])
      if (!d.scopes_supported?.includes(s)) throw new Error("missing advertised scope: " + s);
    console.log("   issuer  " + d.authorization_servers[0]);
  ' "$discovery" "$RESOURCE" || die "discovery document is wrong or stale"
  ok "discovery advertises the resource, issuer and four scopes"

  # Credential-free metadata must stay readable from a browser origin.
  [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
       -H 'Origin: https://claude.ai' "$BASE/.well-known/oauth-protected-resource/mcp")" = "200" ] \
    || die "discovery rejects a browser Origin — the deployed build predates that fix"
  ok "discovery is reachable from a browser origin"

  local path
  for path in /mcp /ready; do
    [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$BASE$path")" = "401" ] \
      || die "$path did not challenge an unauthenticated request"
  done
  ok "/mcp and /ready reject unauthenticated requests"

  step "Recent token rejections"
  gcloud logging read \
    "resource.labels.service_name=\"$SERVICE\" AND jsonPayload.event=\"token_rejected\"" \
    --project="$PROJECT" --limit=5 --freshness=1h \
    --format='table(timestamp,jsonPayload.reason)' 2>/dev/null \
    || echo "   (could not read logs — not fatal)"
  echo "   Reasons are explained in docs/v1/OPERATIONS.md"
}

if [ "$MODE" = "check" ]; then
  command -v gcloud >/dev/null || die "gcloud is required"
  remote_checks
  printf '\n\033[1mRemote checks passed.\033[0m Nothing was changed.\n\n'
  exit 0
fi

# --- preflight ---------------------------------------------------------------
step "Preflight"
[ -f package.json ] || die "Run this from the extracted project directory"
node -e 'if (require("./package.json").name !== "yahoo-mail-mcp") throw new Error("wrong project")' \
  || die "package.json is not yahoo-mail-mcp"
for tool in node npm gcloud; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
ok "project directory and tooling"
echo "   project   $PROJECT / $REGION / $SERVICE"
echo "   resource  $RESOURCE"
echo "   owner     $OAUTH_OWNER_SUB"
echo "   clients   $(printf '%s' "$OAUTH_CLIENT_IDS" | tr ',' '\n' | wc -l | tr -d ' ') approved"
echo "   sending   $SENT_COPY_MODE"
echo "   origins   ${ALLOWED_ORIGINS:-<none>}"

# --- local gate --------------------------------------------------------------
# Also produces dist/, which the deploy script needs.
step "Install locked dependencies"
npm ci

step "Local gate: typecheck, 145 tests, build, 16-tool discovery"
npm run verify

# --- deploy ------------------------------------------------------------------
if [ "$MODE" = "preview" ]; then
  step "Deployment plan (nothing will change)"
  node dist/scripts/deploy-oauth.js activate
  printf '\n\033[1mPreview complete.\033[0m Re-run with --apply to deploy.\n\n'
  exit 0
fi

if [ "$SENT_COPY_MODE" != "unverified" ] && [ "$ASSUME_YES" != "yes" ]; then
  printf '\n\033[1mSENT_COPY_MODE=%s — sending will be LIVE.\033[0m\n' "$SENT_COPY_MODE"
  printf 'Every send_email and reply_email call will deliver real mail.\n'
  read -r -p 'Continue? [y/N] ' reply
  case "$reply" in [yY]*) ;; *) die "Cancelled" ;; esac
fi

step "Deploy to Cloud Run"
# Replaces the whole environment by design, so every value comes from the
# exports above. The script records a rollback revision before it starts.
node dist/scripts/deploy-oauth.js activate --apply

remote_checks

step "Deployed"
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format='value(status.latestReadyRevisionName)' | sed 's/^/   revision  /'
ls -1t verification/oauth-rollback-*.json 2>/dev/null | head -1 | sed 's/^/   rollback  /'
printf '\n\033[1mRelease complete.\033[0m Reconnect the client if its token predates this deploy.\n\n'
