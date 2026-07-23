# Vanta Labs — Launch Verification Checklist

**Date:** 2026-07-23
**Standard used:** proof, not assumptions. Nothing below is marked ✅ Proven
unless it was actually executed and observed passing.

## How things were verified (two honest tiers)

- **Tier A — Proven here (executed & observed).** Pure business logic (unit
  tests) and the database layer (a **real local Postgres 16**, production schema
  loaded, driven under concurrency).
- **Tier B — Needs your staging environment.** Anything that requires the full
  hosted Supabase stack (Auth/GoTrue, Storage, the PostgREST HTTP layer), the
  real email provider, or a browser. **These could not be run in this build
  container because its network policy blocks all container-image downloads**
  (Docker Hub *and* ghcr.io blob CDNs return 403), so a local Supabase stack
  can't be started here. They are wired and code-reviewed, but not executed.

---

## Automated proof that ran (Tier A)

| Suite | What it proves | Scenarios | Result |
|---|---|---|---|
| Unit + logic (`npm test`) | Discounts, commission, membership status, profit floor, order math | 112 tests | ✅ pass, 5× identical |
| Profit simulation | No order can finalize below the profit floor | ~7,200 | ✅ |
| Order-math sweep | One discount wins · never negative · discount ≤ subtotal · commission on discounted subtotal · tax on merchandise only | ~6,000 | ✅ |
| **DB integrity + concurrency** (`scripts/verify-db-locally.sh`, real Postgres) | See table below | 12 | ✅ pass |
| Schema load | `deploy-run-once.sql` applies to a clean Postgres 16 | — | ✅ **0 errors**, 42 tables |

### Database concurrency proof (real Postgres, executed)
| Guarantee | Test | Result |
|---|---|---|
| **RLS deny-by-default** | The anon role reads 0 rows from `admin_credentials`, `orders`, `customer_addresses`, `payouts` | ✅ |
| **No coupon over-redemption** | 100 concurrent redeems of a max‑1 coupon → exactly 1 | ✅ |
| **No duplicate ambassador payouts** | Two concurrent claims of 20 approved commissions → each claimed once, $200 paid exactly | ✅ |
| **No inventory oversell** | 100 concurrent conditional decrements of a 1‑unit product → exactly 1 succeeds, stock never negative | ✅ |
| **One membership per customer** | 30 concurrent membership upserts → exactly 1 row | ✅ |
| **Unique constraints** | Duplicate coupon code rejected (23505) | ✅ |

Reproduce anytime: `bash website/scripts/verify-db-locally.sh`

---

## Feature-by-feature status

| Feature | How verified | Status |
|---|---|---|
| Pricing: one discount wins, best value | Unit + 6k sweep | ✅ Proven |
| Bundle + 5% referral stack | Unit; checkout calls the shared engine | ✅ Proven (logic) |
| Ambassador commission always paid on a valid code, separate from discounts | Unit (paid regardless of winning discount) | ✅ Proven (logic) |
| No duplicate payouts / incorrect payouts | **DB concurrency test** + server-derived payout amount | ✅ Proven |
| Profit floor — never sell at a loss | Guard live in checkout; ~7.2k simulation | ✅ Proven (logic) |
| Coupon cap under load | **DB concurrency test** | ✅ Proven |
| Inventory never negative (the pattern) | **DB concurrency test** | ✅ Proven (SQL pattern) |
| RLS / anon can't read sensitive data | **DB test** (executed) | ✅ Proven |
| Membership: activate/expire/upgrade/downgrade/cancel/renew/refund | Unit (date-guard) + code review | ✅ Logic proven; ⚠️ end-to-end needs staging |
| Refund reverses commission + points + store credit + revokes membership | Code review + unit | ⚠️ needs staging to run E2E |
| Checkout → payment → order creation (full HTTP path) | Code review | ⚠️ Tier B (needs staging) |
| Account create / email verify / login / logout / password reset | Code review | ⚠️ Tier B (needs staging — uses Supabase Auth) |
| Emails actually delivered (order, shipping, ambassador, membership, cart) | Templates + triggers reviewed | ⚠️ Tier B (needs the live email provider) |
| Admin dashboard matches DB | Reads the same stored records | ⚠️ Tier B (needs staging to click through) |

---

## Top remaining risks to close BEFORE launch

1. **Inventory decrement is not yet wired into the paid path.** The atomic
   decrement pattern is **proven safe** (DB test [4]), but the app does not call
   it when an order is paid — stock is only set by the 3PL sync/admin today. Fix:
   add a `decrement_product_inventory(product_id, qty)` RPC (pattern proven) and
   call it in `finalizeManualPayment` + the webhook paid block. **Highest
   priority.**
2. **Account-verification & password-reset emails** use Supabase's built-in
   mailer, not the in-app provider. Confirm Supabase Auth SMTP is configured, or
   these can silently fail. Verify by signing up + resetting on staging.
3. **Card-webhook atomic paid-claim** (distinct event IDs) and **checkout
   idempotency key** — documented in `AUDIT_REPORT.md`; land + verify on staging.
4. **Client cart preview** doesn't yet apply the bundle+5% stack, so a bundle
   order with a code is **charged less than the preview shows** (safe — never
   more — but imprecise). Wire the preview to the shared resolver.

---

## To reach full "everything proven" (the last mile)

Stand up a **staging Supabase project** (free tier) + a **test payment
processor** (e.g. Stripe test mode) + a test email inbox, then:
1. Point `NEXT_PUBLIC_SUPABASE_URL` / keys at staging, run `deploy-run-once.sql`.
2. Seed a few products (with costs), tiers, and an ambassador.
3. Run the app and the browser E2E + concurrency harness against it (I can write
   the Playwright specs — they're straightforward once a real Auth/HTTP endpoint
   exists).
This is the only way to *prove* the Tier B items (auth, email, full HTTP
checkout, admin click-through) rather than code-review them — and I recommend
doing it before taking real orders.
