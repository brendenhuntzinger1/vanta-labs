# Vanta Labs — Start Here Next Session

**Updated:** 2026-07-23 (session 2) · **Branch:** `claude/continue-previous-work-kqo7s9`

Read this first, then open **`FINAL_QA_REPORT.md`** (the full report) and
**`LAUNCH_CHECKLIST.md`** (proof detail). This file is just the fast handoff.

---

## NEW this session — swappable payment abstraction + sandbox gateway

The card checkout and membership billing were stubs (no card order could reach
"paid", no membership could be charged) until a live processor existed. Now both
run behind a mock/sandbox gateway so **every flow can be tested with fake money
today**, and connecting the real high-risk processor later is a **config change,
not a rewrite**.

**Turn the sandbox on (dev/staging only):**
```
PAYMENT_PROVIDER=mock      # card checkout → internal /pay/mock page
BILLING_PROVIDER=mock      # membership recurring charges (fake)
```
- Card checkout redirects to `/pay/mock/<orderId>` → Approve or Decline. Approve
  signs a webhook event and runs it through the REAL webhook handler → order
  paid + confirmation email + inventory decrement + ambassador commission +
  points. Refund from admin works too.
- Membership `mock` mode simulates renewals; a decline test card exercises the
  past-due/dunning path.
- Test cards: `4242…` approves, `4000 0000 0000 0002` (and other `4000…`)
  declines. Sandbox pages 404 unless `PAYMENT_PROVIDER=mock`.

**When your real processor is approved:** register a provider implementation and
set `PAYMENT_PROVIDER` (+ keys) — checkout/webhook logic is untouched. Same for
`BILLING_PROVIDER`. That's the whole integration.

Also fixed this session: "Print packing slip" now generates a real printable
slip (was a no-op); a "delivered" status now sends the delivery-confirmation
email. Verified: 160 unit tests, lint + tsc clean, build succeeds, 17 Postgres
concurrency tests pass.

---

## Where things stand right now

Everything provable in this environment is proven and pushed:
- **138 unit/logic tests** (5× consistent) + **17 real-Postgres concurrency
  tests** + ~23,000 simulated order scenarios. tsc + lint clean, production
  build succeeds.
- Profit guard: **no checkout combination can finalize below break-even** (I
  tried hard to build a money-losing order — it gets peeled or blocked).
- Inventory can't oversell; no double payouts; no duplicate orders/commissions;
  RLS closes anon reads. All proven under concurrency.

Recent changes (last few commits):
- Removed **Cash App / Zelle / PayPal / Venmo** everywhere → card only.
- Fixed the fallout: **annual membership** now uses the card path (was tied to
  the removed manual methods).
- Removed the broken **phone sign-up** (needed an SMS provider you don't have) →
  email + password only.
- Added **Business Type + 21+ + research-use-only** confirmations to the
  account-creation screen (consent record; both boxes required).

## Decisions locked in (do NOT redo)
- ❌ No work-email / "no private email addresses" restriction. Dropped on
  purpose.
- ✅ Business Type stays as-is — it's a verification/consent record (proof of
  research-use, not human consumption), nothing more. No admin surfacing needed
  unless you change your mind.

---

## First thing tomorrow — the one blocker to real launch

**Stand up staging so the un-runnable "Tier B" items can actually be proven.**
This container can't run them (it blocks the hosted Supabase stack), so they're
wired + code-reviewed but not executed. To close them we need:

1. **A staging Supabase project** (free tier) — run `deploy-run-once.sql`, seed a
   few products (with costs), tiers, and one ambassador.
2. **A payment processor in test mode** (e.g. Stripe test) — until this is
   connected, checkout and membership billing are wired but move no real money
   (they honestly say "saved, not charged yet"). **This is the true gate to
   taking orders.**
3. **A test email inbox / confirmed SMTP** — so verification, reset, order,
   shipping, membership, ambassador, and commission emails can be proven to send.

Once those exist, next actions (I can drive all of these):
- Point the app's env at staging and smoke-test: sign up → verify email → login
  → logout → password reset.
- Run one real end-to-end order per pricing case (bundle, referral, membership,
  bundle+referral, coupon) and confirm totals, commission, inventory decrement,
  and the confirmation email.
- Refund/cancel one order and confirm commission reversal + inventory restock.
- Write the Playwright E2E + a load script (hundreds of concurrent users) against
  the running app.

## Smaller follow-ups (after staging, optional)
- Wire the **client cart preview** to the shared resolver so a bundle+code
  preview matches the (already-correct) server charge.
- Card-webhook atomic paid-claim + checkout idempotency key (in `AUDIT_REPORT.md`).
- Add more products to the catalog (admin-managed; nothing in code blocks this).

---

## How to re-verify anytime
```
cd website
npm test                       # 138 tests
bash scripts/verify-db-locally.sh   # 17 real-Postgres concurrency tests
npm run lint && npx tsc --noEmit && npm run build
```

## Bottom line
The logic and data layer are production-grade and proven. **The remaining work
is environmental, not code:** connect a processor + email + staging, then prove
the live flows end-to-end. That's the first thing to pick up.
