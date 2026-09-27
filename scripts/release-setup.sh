#!/usr/bin/env bash
# One-time release setup, for the publisher (not for people installing
# Universal Mail). Run it in Google Cloud Shell:
#
#   bash scripts/release-setup.sh
#
# It creates the Google project that holds the server images, lets anyone
# read them (every install pulls from here) and lets only this GitHub
# repository's release workflow publish them: no password or key is stored
# anywhere (Workload Identity Federation). Safe to run again: anything that
# already exists is kept. At the end it prints the three values to paste into
# the repository's settings on GitHub (Settings → Secrets and variables →
# Actions → Variables).
set -euo pipefail

PROJECT="${PROJECT:-universal-mail-rel-zqrw}"
REPO="${GITHUB_REPOSITORY:-mhprincipe/universal-mail-mcp}"
LOCATION=us
PUBLISHER="release-publisher@${PROJECT}.iam.gserviceaccount.com"

WAIT="${RELEASE_SETUP_WAIT:-30}"
TRIES=10

say() { printf '  %s\n' "$*"; }
exists() { gcloud "$@" >/dev/null 2>&1; }
# For a few minutes after a service is switched on, Google can refuse even
# the project's owner (PERMISSION_DENIED "... or it may not exist"): found
# live. So each change waits and tries again before giving up.
change() {
  local out i
  for ((i = 1; i <= TRIES; i++)); do
    if out="$(gcloud "$@" 2>&1)"; then
      if [ -n "$out" ]; then printf '%s\n' "$out"; fi
      return 0
    fi
    if [ "$i" -lt "$TRIES" ] && grep -qE 'PERMISSION_DENIED|NOT_FOUND|FAILED_PRECONDITION' <<<"$out"; then
      say "Google is still switching this on; trying again in ${WAIT}s (${i} of ${TRIES})"
      sleep "$WAIT"
      continue
    fi
    printf '%s\n' "$out" >&2
    echo "Google refused: gcloud $1 $2 $3. Run this again in a few minutes: anything already made is kept." >&2
    exit 1
  done
}

account="$(gcloud billing accounts list --filter=open=true --format='value(name)' --limit=1)"
account="${account#billingAccounts/}"
if [ -z "$account" ]; then
  echo "No open billing account: add one at console.cloud.google.com/billing, then run this again." >&2
  exit 1
fi

if ! number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)"; then
  say "Creating the project $PROJECT"
  gcloud projects create "$PROJECT" --name="Universal Mail releases"
  number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
fi
gcloud billing projects link "$PROJECT" --billing-account="$account"
gcloud services enable artifactregistry.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT"

if ! exists artifacts repositories describe release --location="$LOCATION" --project="$PROJECT"; then
  say "Creating the image store"
  change artifacts repositories create release --repository-format=docker --location="$LOCATION" \
    --description="Universal Mail server images" --project="$PROJECT"
fi
change artifacts repositories add-iam-policy-binding release --location="$LOCATION" \
  --member=allUsers --role=roles/artifactregistry.reader --project="$PROJECT"

if ! exists iam service-accounts describe "$PUBLISHER" --project="$PROJECT"; then
  change iam service-accounts create release-publisher --display-name="Universal Mail release publisher" --project="$PROJECT"
fi
change artifacts repositories add-iam-policy-binding release --location="$LOCATION" \
  --member="serviceAccount:${PUBLISHER}" --role=roles/artifactregistry.writer --project="$PROJECT"

if ! exists iam workload-identity-pools describe github --location=global --project="$PROJECT"; then
  change iam workload-identity-pools create github --location=global --display-name=GitHub --project="$PROJECT"
fi
if ! exists iam workload-identity-pools providers describe universal-mail --workload-identity-pool=github --location=global --project="$PROJECT"; then
  change iam workload-identity-pools providers create-oidc universal-mail --workload-identity-pool=github --location=global \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
    --attribute-condition="assertion.repository=='${REPO}'" --project="$PROJECT"
fi
change iam service-accounts add-iam-policy-binding "$PUBLISHER" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}" \
  --project="$PROJECT"

echo
say "Done. On GitHub, open ${REPO} → Settings → Secrets and variables → Actions → Variables,"
say "and add these three (New repository variable):"
echo
say "GCP_WORKLOAD_IDENTITY_PROVIDER = projects/${number}/locations/global/workloadIdentityPools/github/providers/universal-mail"
say "GCP_RELEASE_SERVICE_ACCOUNT = ${PUBLISHER}"
say "UPDATE_FEED_URL = https://raw.githubusercontent.com/${REPO}/release/latest.json"
