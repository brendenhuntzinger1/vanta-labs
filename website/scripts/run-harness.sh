#!/usr/bin/env bash
# Build + serve the app against the local PostgREST shim for Block G/H.
# See docs/BROWSER-TESTING-RUNBOOK.md. Development-only.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
export NODE_ENV=test

if [ "${1:-}" = "--build" ]; then
  npx next build
fi
exec node scripts/harness-server.mjs
