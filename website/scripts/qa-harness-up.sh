#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Bring the local QA harness up, idempotently, and prove it is the CURRENT code.
#
# Three things kept costing debugging rounds, and all three are avoidable:
#
#   1. A shim left running from before an edit serves the OLD file. Nothing
#      about the symptom says so — the endpoint answers, it just answers with
#      behaviour you already changed. This script always restarts and then
#      reports each process's start time against the source mtime, so a stale
#      one is visible rather than inferred.
#
#   2. `pgrep -f pgrst-shim` matches the shell command that contains the string,
#      including the pgrep itself, so "is it running?" answers yes when it is
#      not. Matching is on the node process specifically.
#
#   3. Backgrounding from an agent shell kills the child when the turn ends
#      unless it is fully detached; setsid + nohup + closed stdin is what
#      survives.
#
# Development-only. Refuses to touch anything but the local harness.
#
#   bash scripts/qa-harness-up.sh
# ---------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="${QA_LOG_DIR:-/tmp/vanta-qa}"
DB="${QA_DATABASE_URL:-postgres://postgres@localhost:55432/storefront}"
mkdir -p "$LOGDIR"

# Match the NODE process, not any shell that merely mentions the script.
node_pid() { pgrep -f "^node scripts/$1" 2>/dev/null | head -1; }

stop() {
  local pid; pid="$(node_pid "$1")"
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; fi
}

# NODE_ENV=test IS NOT OPTIONAL, AND DROPPING IT LOOKS LIKE A PRODUCT OUTAGE.
#
# package.json's `harness:start` is `NODE_ENV=test node scripts/harness-server.mjs`.
# This script bypassed npm and ran bare `node`, so the variable was simply gone.
# harness-server.mjs assigns `process.env.NODE_ENV = "test"` itself, which is why
# the omission was invisible — but that assignment happens in the harness
# process, AFTER Next has already decided which env files to load. With NODE_ENV
# unset Next loads the production set, `.env.test.local` is never read, and the
# server comes up with no NEXT_PUBLIC_SUPABASE_URL at all.
#
# What that looks like from the outside is not a configuration error. It is an
# empty shop: /api/catalog/products answers 400, /products renders no products,
# and the customer-journey harness fails at "catalogue browses and a product page
# renders" — reported as a product defect. The cause was one missing assignment
# in this file, and it cost a full diagnosis round to find because the catalogue
# route swallowed its own exception (fixed separately).
#
# `env` rather than a prefix assignment so it survives setsid/nohup.
# NODE_TLS_REJECT_UNAUTHORIZED=0 IS NOT OPTIONAL EITHER, AND ITS ABSENCE LOOKS
# LIKE A SLOW PRODUCT.
#
# gotrue-tls-proxy.mjs serves a self-signed certificate, and .env.test.local
# points NEXT_PUBLIC_SUPABASE_URL at it (https://127.0.0.1:54443) because the
# browser half of the harness needs https — see the runbook, section 5c. The
# app's own server-side calls go to that same URL, and Node rejects the cert
# with DEPTH_ZERO_SELF_SIGNED_CERT. NODE_EXTRA_CA_CERTS does NOT fix it: a
# depth-zero self-signed leaf is refused however the CA store is loaded. Both
# the runbook and gotrue-tls-proxy.mjs's own header say to start the app with
# this variable; this script bypassed them and started bare.
#
# The symptom is not an error page. Every server-side Supabase call fails and
# burns its timeout, so /api/cron/sweep went from 0.3s to over 90 SECONDS and
# was cut off mid-run, with each job reporting its own unrelated-looking
# failure — "unable to list users", "RPC failed", "FAILING OPEN". Read at face
# value that is a broken sweep. It is one missing variable.
start() {
  local script="$1" log="$2"; shift 2
  ( cd "$HERE" && setsid nohup env NODE_ENV=test NODE_TLS_REJECT_UNAUTHORIZED=0 node "scripts/$script" "$@" >"$LOGDIR/$log" 2>&1 </dev/null & )
}

wait_for() {
  local url="$1" name="$2" tries="${3:-30}"
  for _ in $(seq "$tries"); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then echo "  $name up"; return 0; fi
    sleep 1
  done
  echo "  $name DID NOT COME UP — see $LOGDIR"; return 1
}

cd "$HERE"

echo "==> stopping anything already running"
stop "pgrst-shim.mjs"; stop "harness-server.mjs"; stop "veyra-stub.mjs"
sleep 2

# THE VARIABLES WITHOUT WHICH A SUITE FAILS FOR A REASON THAT NAMES SOMETHING
# ELSE. Every one of these cost a debugging round on 2026-09-07:
#
#   CRON_SECRET               /api/cron/sweep answers 401 and the three email
#                             suites (retention, lifecycle, gift-wiring) cannot
#                             run at all. The error is a bare 401.
#   EMAIL_ENABLED             the sweep reports "Email sending is turned off in
#                             Settings" and mails nobody, so every email
#                             assertion fails as though the engine were broken.
#   EMAIL_PROVIDER + SMTP_*   EMAIL_PROVIDER=none resolves to "smtp", which then
#                             fails isReady(), and the sweep reports "provider
#                             isn't fully configured". The harness wants smtp
#                             pointed at scripts/smtp-sink.mjs.
#   MARKETING_POSTAL_ADDRESS  CAN-SPAM gate: marketing is refused without it.
#
# Reported together and by name, because finding them one at a time means one
# rebuild-and-rerun cycle each.
echo "==> required harness env"
missing=""
for var in CRON_SECRET EMAIL_ENABLED EMAIL_PROVIDER SMTP_HOST SMTP_PORT MARKETING_POSTAL_ADDRESS; do
  grep -qE "^${var}=" "$HERE/.env.test.local" 2>/dev/null || missing="$missing $var"
done
if [ -n "$missing" ]; then
  echo "  MISSING from .env.test.local:$missing"
  echo "  Without these the EMAIL suites fail with errors that name something else."
  echo "  See docs/BROWSER-TESTING-RUNBOOK.md section 5b."
else
  echo "  ok: every variable the email suites need is present"
fi

echo "==> starting"
start "pgrst-shim.mjs" "shim.log" --port 54321 --db "$DB"
start "veyra-stub.mjs" "veyra.log"
# The email suites read EMAIL_CAPTURE_DIR/captured-emails.jsonl. Nothing writes
# it unless the sink is up, and a missing sink looks like "the send failed".
start "smtp-sink.mjs" "smtp-sink.log" --port "${SMTP_SINK_PORT:-2525}" --capture "$LOGDIR"
sleep 3
start "harness-server.mjs" "harness.log"

wait_for "http://127.0.0.1:54321/products?limit=1" "shim"
wait_for "http://127.0.0.1:59999/" "veyra stub" 10 || true
wait_for "http://127.0.0.1:3000/" "app"

# THE APP ANSWERING 200 IS NOT THE APP WORKING.
#
# Every check above passed while the storefront was serving an empty catalogue,
# because the home page renders fine with no products in it. The first thing
# that actually noticed was the customer-journey harness, four minutes later,
# and it reported it as a product defect rather than a harness one.
#
# So the readiness check is the storefront's primary read path, not a 200.
echo "==> catalogue"
if [ ! -f "$HERE/.env.test.local" ]; then
  echo "  MISSING $HERE/.env.test.local — Next loads .env.test.local only under NODE_ENV=test;"
  echo "  without it the app has no NEXT_PUBLIC_SUPABASE_URL and the shop is empty."
  echo "  See docs/BROWSER-TESTING-RUNBOOK.md section 5b."
fi
# ...AND THE STORE NOW REQUIRES AN ACCOUNT, so the probe had to change with it.
#
# This asked /api/catalog/products anonymously and expected products back. That
# was right until access-policy.ts closed the default: the endpoint is not on
# the public list, so an unauthenticated request correctly answers
# {"success":false,"error":"Sign in to continue"} — and the probe read that as
# "CATALOGUE EMPTY OR FAILING" and told you to go and read harness.log. It
# reported a broken storefront on a perfectly healthy one, every single run.
#
# What is actually worth checking is unchanged in spirit: does the read path
# reach real data? So ask the shim, which is behind the wall and returns the
# catalogue, and separately confirm the app enforces the wall rather than 500ing.
catalogue="$(curl -sf --max-time 20 "http://127.0.0.1:54321/products?limit=1" 2>/dev/null || true)"
case "$catalogue" in
  *'"slug"'*)
    echo "  ok: the catalogue has products behind the wall" ;;
  *)
    echo "  CATALOGUE EMPTY OR FAILING — every product, cart and checkout step will fail."
    echo "  This is a HARNESS fault until proven otherwise; check $LOGDIR/shim.log first."
    ;;
esac
walled="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://127.0.0.1:3000/api/catalog/products 2>/dev/null || true)"
case "$walled" in
  401|403|307) echo "  ok: the app enforces the account wall ($walled)" ;;
  200)         echo "  WARNING: /api/catalog/products answered 200 to an anonymous request — the wall is open" ;;
  *)           echo "  WARNING: /api/catalog/products answered $walled — expected the wall, not an error" ;;
esac

# The check that matters: is what is RUNNING newer than what is on disk?
echo "==> freshness"
for pair in "pgrst-shim.mjs:scripts/gotrue-shim.mjs" "harness-server.mjs:.next/BUILD_ID"; do
  proc="${pair%%:*}"; src="${pair##*:}"
  pid="$(node_pid "$proc")"
  if [ -z "$pid" ] || [ ! -e "$src" ]; then continue; fi
  started=$(date -d "$(ps -o lstart= -p "$pid")" +%s 2>/dev/null || echo 0)
  changed=$(stat -c %Y "$src" 2>/dev/null || echo 0)
  if [ "$changed" -gt "$started" ]; then
    echo "  STALE: $proc started before $src changed — restart it or you are testing old code"
  else
    echo "  ok: $proc is newer than $src"
  fi
done

echo
echo "Logs in $LOGDIR. Export QA_HARNESS_LOG=$LOGDIR/harness.log for the email assertions."
