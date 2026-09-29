#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
SERVICE="${SERVICE:-yahoo-mail-mcp}"
SA_NAME="${SA_NAME:-yahoo-mail-mcp}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Usage: $0 <gcp-project-id> [region]" >&2
  exit 2
fi

export CLOUDSDK_CORE_PROJECT="$PROJECT_ID"
cd "$(dirname "$0")/.."
command -v gcloud >/dev/null || { echo "gcloud CLI is required." >&2; exit 1; }

# This legacy entry point must not silently replace OAuth with a static secret.
# Require a readable existing service; initial installations use the documented setup flow.
gcloud run services describe "$SERVICE" --region "$REGION" --format=json | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const service = JSON.parse(input);
  const env = service.spec?.template?.spec?.containers?.[0]?.env ?? [];
  const mode = env.find(item => item.name === "AUTH_MODE")?.value;
  if (mode && mode !== "bearer") {
    console.error("STOP: OAuth service cannot use the legacy deploy script. See docs/v1/OAUTH_ROLLOUT.md.");
    process.exitCode = 1;
  }
});'

# First deploy: localhost is deliberately the only allowed Host until Cloud Run gives us the service hostname.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA_EMAIL" \
  --allow-unauthenticated \
  --min 0 \
  --max 1 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 8 \
  --timeout 300 \
  --set-env-vars="NODE_ENV=production,MAX_MESSAGE_BYTES=20971520,SENT_COPY_MODE=${SENT_COPY_MODE:-unverified}" \
  --set-secrets="YAHOO_EMAIL=yahoo-email:latest,YAHOO_APP_PASSWORD=yahoo-app-password:latest,MCP_ACCESS_SECRET=yahoo-mcp-access-secret:latest"

URI="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
HOST="${URI#https://}"
HOST="${HOST%%/*}"

# Second revision enables the exact Cloud Run hostname for MCP Host/Origin validation.
gcloud run services update "$SERVICE" \
  --region "$REGION" \
  --update-env-vars="ALLOWED_HOSTS=${HOST}" >/dev/null

# Token is retrieved only by the operator when configuring a client.

echo
echo "Deployed: $URI"
echo "MCP endpoint: $URI/mcp"
echo "Health:       $URI/health"
echo "Ready check:  curl -H \"Authorization: Bearer <TOKEN>\" $URI/ready"
echo
echo "Retrieve the token when configuring an MCP client:"
echo "  gcloud secrets versions access latest --secret=yahoo-mcp-access-secret --project=$PROJECT_ID"
echo
echo "Do not paste the token into source code or commit it to Git."
