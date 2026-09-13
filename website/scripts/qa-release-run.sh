#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# RUN THE RELEASE-GATING BROWSER SUITES, IN A STATED ORDER, AND SAY WHAT EACH
# ONE ANSWERED.
#
# WHY THE ORDER IS AN ARGUMENT. Every suite here writes to the same Postgres and
# the same mail capture. A suite that leaves a flag flipped — an automation
# enabled, a product out of stock, a coupon spent — changes the verdict of
# whatever runs next, and the failure surfaces in the INNOCENT suite. That is the
# most expensive kind of false red there is: the evidence points away from the
# cause. It also hides false GREENS, where a suite only passes because something
# earlier left the world in a shape it never sets up for itself.
#
# So the release claim is not "the suites pass". It is "the suites pass, and they
# pass in a different order too". Run it twice:
#
#     bash scripts/qa-release-run.sh forward
#     bash scripts/qa-release-run.sh reverse
#
# and compare the two tables. Any suite whose verdict moves between them is
# depending on a neighbour, and is not evidence of anything until it is fixed.
#
# QA_BASE_URL IS DELIBERATELY NOT SET HERE. Some suites default to
# localhost:3000 rather than 127.0.0.1 on purpose — qa-discount-contest needs
# /r/<code> to stay on one origin — and exporting one base for all of them
# silently breaks those. Each suite keeps its own default; override one by
# running it directly.
#
# Development-only; every suite refuses a non-loopback target of its own accord.
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ORDER="${1:-forward}"
LOGDIR="${QA_LOG_DIR:-/tmp/vanta-qa}/release/${ORDER}"
mkdir -p "$LOGDIR"

export EMAIL_CAPTURE_DIR="${EMAIL_CAPTURE_DIR:-${QA_LOG_DIR:-/tmp/vanta-qa}}"
export CRON_SECRET="${CRON_SECRET:-harness-cron-secret}"
export PAYMENT_WEBHOOK_SECRET="${PAYMENT_WEBHOOK_SECRET:-harness-webhook-secret}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

# The gating set. qa-seed-roles is setup, not a gate: the admin suites cannot
# sign in until it has run, so it runs first whatever order is asked for.
SUITES=(
  qa-promotion-eligibility
  qa-purchase-path
  qa-customer-journey
  qa-checkout-edge-matrix
  qa-amount-matrix
  qa-post-3ds-high-value
  qa-offer-journey
  qa-customer-offer
  qa-offer-checkout-journey
  qa-gift-wiring
  qa-lifecycle-email
  qa-retention-system
  qa-email-truth
  qa-campaign-truth
  qa-automation-truth
  qa-automation-cta
  qa-cart-recovery-override
  qa-guest-recovery
  qa-discount-contest
  qa-paid-attribution-journey
  qa-cross-account
  qa-role-boundaries
  qa-abuse-and-roles
  qa-customer-crawl
  qa-cross-engine-journey
)

case "$ORDER" in
  forward) : ;;
  reverse)
    REV=(); for ((i=${#SUITES[@]}-1; i>=0; i--)); do REV+=("${SUITES[$i]}"); done
    SUITES=("${REV[@]}") ;;
  *)
    # seed:N — a deterministic shuffle, so a reported order can be re-run.
    SEED="${ORDER#seed:}"
    mapfile -t SUITES < <(printf '%s\n' "${SUITES[@]}" | shuf --random-source=<(yes "$SEED")) ;;
esac

echo "Release run — order: $ORDER — $(date -u +%FT%TZ)"
echo "Logs: $LOGDIR"
echo

node scripts/qa-seed-roles.mjs > "$LOGDIR/qa-seed-roles.log" 2>&1
echo "setup  qa-seed-roles $( [ $? -eq 0 ] && echo ok || echo FAILED )"
echo

FAILED=()
for suite in "${SUITES[@]}"; do
  start=$SECONDS
  node "scripts/${suite}.mjs" > "$LOGDIR/${suite}.log" 2>&1
  code=$?
  took=$((SECONDS - start))
  # The last line every suite prints is its own count; quote it rather than
  # re-deriving one, so this runner cannot disagree with the suite it ran.
  summary="$(grep -E "checks?:|CHECKS? (PASSED|FAILED)|passed," "$LOGDIR/${suite}.log" | tail -1 | sed 's/^[[:space:]]*//')"
  if [ $code -eq 0 ]; then
    printf 'PASS  %-28s %4ds  %s\n' "$suite" "$took" "$summary"
  else
    FAILED+=("$suite")
    printf 'FAIL  %-28s %4ds  %s\n' "$suite" "$took" "$summary"
  fi
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "ALL ${#SUITES[@]} SUITES PASSED in order '$ORDER'."
  exit 0
fi
echo "${#FAILED[@]} of ${#SUITES[@]} SUITES FAILED in order '$ORDER': ${FAILED[*]}"
exit 1
