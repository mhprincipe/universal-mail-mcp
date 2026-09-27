#!/bin/bash
# A stand-in gcloud for the terminal test: the answers the owner's live run
# got (2026-09-27) up to step 2, with version 1 in the current project.
sleep 0.2
case "$*" in
  "config get-value project") echo yahoo-mail-mcp ;;
  "projects list --filter=labels.universal-mail=true --format=json") echo '[]' ;;
  "run services describe yahoo-mail-mcp --region=us-central1 --project=yahoo-mail-mcp --format=json")
    echo '{"spec":{"template":{"spec":{"containers":[{"env":[{"name":"SENT_COPY_MODE","value":"yahoo"}]}]}}}}' ;;
  "config get-value account") echo you@gmail.com ;;
  "organizations list --format=json") echo '[]' ;;
  "billing accounts list --format=json") echo '[{"name":"billingAccounts/0X0X0X-111111-222222","open":true}]' ;;
  *) echo "ERROR: (stand-in) unscripted: $*" >&2; exit 1 ;;
esac
