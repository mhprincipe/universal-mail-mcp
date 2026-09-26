#!/usr/bin/env bash
set -euo pipefail
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:local
docker build -t yahoo-mail-mcp:local .
