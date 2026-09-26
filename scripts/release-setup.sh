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

say() { printf '  %s\n' "$*"; }
exists() { gcloud "$@" >/dev/null 2>&1; }

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
  gcloud artifacts repositories create release --repository-format=docker --location="$LOCATION" \
    --description="Universal Mail server images" --project="$PROJECT"
fi
gcloud artifacts repositories add-iam-policy-binding release --location="$LOCATION" \
  --member=allUsers --role=roles/artifactregistry.reader --project="$PROJECT"

if ! exists iam service-accounts describe "$PUBLISHER" --project="$PROJECT"; then
  gcloud iam service-accounts create release-publisher --display-name="Universal Mail release publisher" --project="$PROJECT"
fi
gcloud artifacts repositories add-iam-policy-binding release --location="$LOCATION" \
  --member="serviceAccount:${PUBLISHER}" --role=roles/artifactregistry.writer --project="$PROJECT"

if ! exists iam workload-identity-pools describe github --location=global --project="$PROJECT"; then
  gcloud iam workload-identity-pools create github --location=global --display-name=GitHub --project="$PROJECT"
fi
if ! exists iam workload-identity-pools providers describe universal-mail --workload-identity-pool=github --location=global --project="$PROJECT"; then
  gcloud iam workload-identity-pools providers create-oidc universal-mail --workload-identity-pool=github --location=global \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
    --attribute-condition="assertion.repository=='${REPO}'" --project="$PROJECT"
fi
gcloud iam service-accounts add-iam-policy-binding "$PUBLISHER" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}" \
  --project="$PROJECT"

echo
say "Done. On GitHub, open ${REPO} → Settings → Secrets and variables → Actions → Variables,"
say "and add these three (New repository variable):"
echo
say "GCP_WORKLOAD_IDENTITY_PROVIDER = projects/${number}/locations/global/workloadIdentityPools/github/providers/universal-mail"
say "GCP_RELEASE_SERVICE_ACCOUNT = ${PUBLISHER}"
say "UPDATE_FEED_URL = https://raw.githubusercontent.com/${REPO}/release/latest.json"
