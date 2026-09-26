#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
SERVICE="${SERVICE:-yahoo-mail-mcp}"
SA_NAME="${SA_NAME:-yahoo-mail-mcp}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <gcp-project-id> [region]" >&2
  exit 2
fi

command -v gcloud >/dev/null || { echo "gcloud CLI is required." >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required." >&2; exit 1; }

export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# Ensure the project build service account has roles/run.builder; see README.
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="Yahoo Mail MCP runtime"
fi

read -r -p "Yahoo email address: " YAHOO_EMAIL
read -r -s -p "Yahoo app password (not your normal Yahoo password): " YAHOO_APP_PASSWORD
echo
MCP_ACCESS_SECRET="$(openssl rand -hex 32)"

put_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic >/dev/null
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
}

put_secret yahoo-email "$YAHOO_EMAIL"
put_secret yahoo-app-password "$YAHOO_APP_PASSWORD"
put_secret yahoo-mcp-access-secret "$MCP_ACCESS_SECRET"

for secret in yahoo-email yahoo-app-password yahoo-mcp-access-secret; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
done

cat <<OUT
Bootstrap complete.
Project: $PROJECT_ID
Region: $REGION
Runtime service account: $SA_EMAIL

The MCP bearer token was stored only in Secret Manager as yahoo-mcp-access-secret.
To retrieve it later for your MCP client:
  gcloud secrets versions access latest --secret=yahoo-mcp-access-secret --project=$PROJECT_ID

Next:
  ./scripts/deploy.sh $PROJECT_ID $REGION
OUT
