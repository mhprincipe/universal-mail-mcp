#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "--read-only-live" ]]; then
  echo 'Usage: bash scripts/verify-cloud.sh --read-only-live [test-fixture.json]'
  echo 'Explicitly permits read-only checks of the recorded Yahoo test conversation.'
  exit 2
fi
cd "$(dirname "$0")/.."
npm run verify
export CLOUDSDK_CORE_PROJECT=yahoo-mail-mcp
export SERVICE_URL="$(gcloud run services describe yahoo-mail-mcp --region=us-central1 --format='value(status.url)')"
gcloud run services describe yahoo-mail-mcp --region=us-central1 --format=json > cloud-service-check.json
export MCP_ACCESS_SECRET="$(gcloud secrets versions access latest --secret=yahoo-mcp-access-secret)"
trap 'unset MCP_ACCESS_SECRET' EXIT
export MCP_TEST_FIXTURE="${2:-scripts/test-message.fixture.json}"
export LIVE_READ_CONFIRMED=yes
npm run verify:live
