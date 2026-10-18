#!/usr/bin/env bash
# Typecheck and build, then optionally run eval groups: `pnpm verify [evalId...]`.
# Required env the local .env may lack gets a placeholder; anything already set wins.
set -euo pipefail

export STRAVA_WEBHOOK_VERIFY_TOKEN="${STRAVA_WEBHOOK_VERIFY_TOKEN:-placeholder}"
export HEVY_WEBHOOK_SECRET="${HEVY_WEBHOOK_SECRET:-placeholder}"
export NOTION_PLANS_DATA_SOURCE_ID="${NOTION_PLANS_DATA_SOURCE_ID:-placeholder}"
export NOTION_WORKOUTS_DATA_SOURCE_ID="${NOTION_WORKOUTS_DATA_SOURCE_ID:-placeholder}"

echo "verify: typecheck"
pnpm -s typecheck

echo "verify: build"
build_log="$(mktemp)"
if ! pnpm -s eve build --skip-sandbox-prewarm >"$build_log" 2>&1; then
  cat "$build_log"
  exit 1
fi

if [ "$#" -gt 0 ]; then
  echo "verify: eval $*"
  pnpm -s eve eval "$@"
fi

echo "verify: ok"
