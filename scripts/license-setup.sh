#!/usr/bin/env bash
# One-time setup of the license service (design §13.3), for the publisher,
# in Google Cloud Shell, after scripts/release-setup.sh and a first release:
#
#   PADDLE_WEBHOOK_SECRET=... PADDLE_CLIENT_TOKEN=... \
#   PADDLE_PRICE_MONTHLY=pri_... PADDLE_PRICE_YEARLY=pri_... \
#   bash scripts/license-setup.sh
#
# It turns on Firestore in the release project, makes the signing key (kept
# only in Secret Manager), stores Paddle's secrets there too, and starts the
# service from the current release's image. Safe to run again: anything that
# exists is kept, and Paddle's secrets are updated when given. At the end it
# prints the address for GitHub and the two addresses to paste into Paddle.
set -euo pipefail

PROJECT="${PROJECT:-universal-mail-rel-zqrw}"
REPO="${GITHUB_REPOSITORY:-mhprincipe/universal-mail-mcp}"
REGION="${REGION:-us-central1}"
SERVICE=universal-mail-license
RUNNER="universal-mail-license@${PROJECT}.iam.gserviceaccount.com"
: "${PADDLE_PRICE_MONTHLY:?set PADDLE_PRICE_MONTHLY to the monthly price id from Paddle}"
: "${PADDLE_PRICE_YEARLY:?set PADDLE_PRICE_YEARLY to the yearly price id from Paddle}"

say() { printf '  %s\n' "$*"; }
exists() { gcloud "$@" >/dev/null 2>&1; }
# A secret: created if missing; a new version added when a value is given.
secret() {
  local name="$1" value="${2-}"
  if ! exists secrets describe "$name" --project="$PROJECT"; then
    if [ -z "$value" ]; then echo "$name has no value yet: set it (see the top of this script) and run again." >&2; exit 1; fi
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- --project="$PROJECT"
  elif [ -n "$value" ]; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project="$PROJECT"
  fi
  gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:${RUNNER}" --role=roles/secretmanager.secretAccessor --project="$PROJECT" >/dev/null
}

gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com --project="$PROJECT"

if ! exists firestore databases describe --database='(default)' --project="$PROJECT"; then
  say "Creating the records store"
  gcloud firestore databases create --database='(default)' --location=nam5 --type=firestore-native --project="$PROJECT"
fi

if ! exists iam service-accounts describe "$RUNNER" --project="$PROJECT"; then
  gcloud iam service-accounts create universal-mail-license --display-name="Universal Mail license service" --project="$PROJECT"
fi
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${RUNNER}" --role=roles/datastore.user >/dev/null

# The signing key, made here once and never printed: it lives only in Secret Manager.
if ! exists secrets describe universal-mail-license-key --project="$PROJECT"; then
  say "Making the signing key"
  node -e "const { generateKeyPairSync } = require('node:crypto'); process.stdout.write(JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })))" \
    | gcloud secrets create universal-mail-license-key --replication-policy=automatic --data-file=- --project="$PROJECT"
fi
gcloud secrets add-iam-policy-binding universal-mail-license-key --member="serviceAccount:${RUNNER}" --role=roles/secretmanager.secretAccessor --project="$PROJECT" >/dev/null
secret universal-mail-paddle-webhook "${PADDLE_WEBHOOK_SECRET-}"
secret universal-mail-paddle-client "${PADDLE_CLIENT_TOKEN-}"

# The current release's image: the service is part of it.
IMAGE="${IMAGE:-$(curl -fsSL "https://raw.githubusercontent.com/${REPO}/release/release.json" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).image))")}"
say "Starting the service from $IMAGE"
gcloud run deploy "$SERVICE" --image="$IMAGE" --region="$REGION" --project="$PROJECT" --service-account="$RUNNER" \
  --command=node --args=dist/src/licenseService/index.js --allow-unauthenticated --max-instances=2 \
  --set-secrets=LICENSE_SIGNING_KEY=universal-mail-license-key:latest,PADDLE_WEBHOOK_SECRET=universal-mail-paddle-webhook:latest,PADDLE_CLIENT_TOKEN=universal-mail-paddle-client:latest \
  --set-env-vars="PADDLE_PRICE_MONTHLY=${PADDLE_PRICE_MONTHLY},PADDLE_PRICE_YEARLY=${PADDLE_PRICE_YEARLY}" --quiet
url="$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT" --format='value(status.url)')"
gcloud run services update "$SERVICE" --region="$REGION" --project="$PROJECT" --update-env-vars="LICENSE_SERVICE_URL=${url}" --quiet

echo
say "Done. On GitHub (Settings → Secrets and variables → Actions → Variables), add:"
echo
say "LICENSE_SERVICE_URL = ${url}"
echo
say "In Paddle, set the webhook destination to:"
say "${url}/webhook/paddle"
say "and the checkout's default success page to:"
say "${url}/welcome"
echo
say "Then cut a release: the next one carries the service's address."
