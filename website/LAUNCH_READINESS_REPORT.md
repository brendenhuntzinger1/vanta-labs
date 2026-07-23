# Vanta Labs — Launch Readiness Report

**Date:** 2026-07-23 · **Branch:** `claude/continue-previous-work-kqo7s9`
**Audit method:** 6 parallel specialist code audits (financial, security,
payment/webhook integrity, auth/session/admin, business-logic/data-integrity,
code-quality/performance), each finding verified against the code before any fix.

> **Honesty note (read first).** This build environment cannot run live Supabase
> Auth/HTTP or a real browser, so the "live E2E" (Phase 2) and "real mobile
> browser" (Phase 6) passes were **code-reviewed, not executed**. What WAS
> executed: the full unit/logic suite, the real-Postgres concurrency stress
> tests, typecheck, lint, and production build. Every claim below is labeled
> **Verified (executed)** or **Reviewed (needs staging)**.

---

## Scores

| Dimension | Score | Basis |
|---|---:|---|
| **Production readiness** | **86 / 100** | Code-complete and audited; all known critical/high fixed. Not 100% because the app has not been run against live services and operational/legal setup is pending (your side). |
| **Security** | **90 / 100** | No critical/high found. Well-hardened (RLS deny-by-default on all 42 tables, session+role gates on all 49 admin routes, HMAC webhooks, price integrity, no XSS, secrets server-only). Fixed the medium gaps (admin-session revocation, 2FA fail-closed, PII endpoint gating, cart email injection, coupon rate-limit). |
| **Performance** | **80 / 100** | Fine at launch scale. Two admin dashboards silently truncate at scale (revenue 10k, customers 5k) and the storefront catalog is client-rendered (SEO/LCP) — scale-hardening, not blockers. |
| **Reliability** | **86 / 100** | Payment/webhook idempotency + concurrency now well-guarded; core money-race backbone proven on real Postgres. The webhook concurrency fixes are reviewed, not yet live-E2E verified. |

**Would I deploy to production **today**? — No, not yet.** Not because of known
code defects (all critical/high are fixed and verified by the test suite), but
because the site has not been run end-to-end against live Supabase + a real
processor + email, and the operational/legal setup below is incomplete. **Once
staging E2E passes and the operational checklist is done, yes.**

---

## Tests executed

- **171 unit/logic tests** — pass (checkout math, discounts, commissions,
  refunds, profit guard, bundle config, points/FAQ helpers, provider dispatch).
- **17 real-Postgres concurrency stress tests** — pass. These EXECUTE several
  Phase-2 scenarios: two buyers on the last unit (no oversell, never negative),
  100-way coupon over-redemption (exactly 1), ambassador double-payout (exact,
  never doubled), 30-way duplicate membership (exactly 1), RLS deny-by-default.
- **Typecheck, lint, production build** — all clean.
- **Total automated checks: 188**, run repeatedly and consistently.
- **~110+ audit scenarios** reviewed across the 6 specialist passes.

---

## Critical & High issues — FOUND and FIXED

**CRITICAL (2):**
1. **Cancelled trial members were still charged the first-month remainder** —
   cancelling during the $1 trial now terminates it and stops the charge.
2. **A crash mid-webhook stranded a paid order forever** — `payment_events`
   claims are now reclaimable (completion marker + stale-claim retake), so a
   processor retry finishes the order instead of skipping it as a duplicate.

**HIGH (7):**
3. **Concurrent distinct paid events could double-award** — added an atomic
   paid-claim; only the first event runs commission/points/coupon/email/stock.
4. **A late payment.failed/canceled could demote a paid order** (voiding
   commission, restocking sold stock) — now blocked.
5. **Repeated refund/chargeback events double-reversed** points/store-credit and
   double-restocked — short-circuit + idempotency guards on `reverseOrderPoints`,
   `refundStoreCreditForOrder`, and a capped/idempotent `redeemPoints`.
6. **Points redemption could drive the ledger negative** across concurrent
   orders — now capped to the live balance and idempotent per order.
7. **Deactivating an admin didn't revoke their live session** — sessions are
   purged on deactivation and `is_active` is re-checked on every request.
8. **Tier upgrade/downgrade left the renewal price stale** (downgrades
   overcharged) — the tier change now reprices the next renewal.
9. **Admin refund and webhook refund didn't share idempotency** (double
   restock/clawback) — webhook writes `refund_amount`; admin refund rejects an
   already-refunded order.

**MEDIUM fixed (9):** 2FA fail-closed when provisioned; `partners`/`coupons` GET
role-gated (were staff-readable PII/codes); partial-refund commission measured
against the merchandise base; `updatePaymentMethod` no longer reactivates
cancelled members for free; ambassador performance-tier count excludes
$0/ineligible orders; `cart/track` bound to the session (was an email-bombing
vector); durable coupon-validate rate limiting (was an in-process Map that resets
on serverless); ops low-stock widget reads the real products table; webhook money
fields are now DB-authoritative (hardening for a real processor).

---

## Remaining issues (none critical/high)

**MEDIUM — address before the relevant integration/scale point:**
- **Partial refund via a real processor webhook is treated as a full refund.**
  Not reachable today (the mock never emits partials); fix when wiring the real
  processor, using its refund-amount payload. The admin partial-refund path is
  already correct.
- **Broader rate limiting.** Only coupon-validate is wired to the durable
  limiter; checkout/account/membership endpoints (already auth-gated) can reuse
  `checkRateLimit` for defense in depth.
- **Admin dashboards load-all-and-aggregate with a silent cap** (revenue 10k,
  customers 5k, payouts 5k). Correct at launch volume; move to SQL aggregation
  before crossing those counts or the numbers quietly understate.
- **Storefront catalog is client-rendered (`no-store`)** — SSR/ISR would improve
  SEO and LCP for a launching store.

**LOW — hardening / polish:**
- Referral/signup bonuses lack a per-referrer cap and a verified-email gate
  (farmable if email confirmation is off) — recommend capping + requiring
  `email_confirmed_at`.
- No last-super-admin guard (an owner could lock the org out of team mgmt).
- Customer logout doesn't server-revoke the Supabase token (stateless tradeoff).
- Admin-comped memberships never date-expire (confirm this is intended).
- MRR/active-member metrics count `status=active` without the period-end guard
  (slightly overstates).
- `roundMoney` is re-defined in ~15 files (low drift risk; consolidate for
  maintainability).

---

## Operational checklist — YOUR side, before launch

These are not code defects; they are the connect-and-configure steps. See
`STAGING_SETUP.md` and `DEPLOY.md`.

1. **Run the DB migrations** on your Supabase project — `deploy-run-once.sql`
   (now includes the new columns/tables/RLS from this audit).
2. **Connect the real payment + billing processor**; set `PAYMENT_PROVIDER` /
   `BILLING_PROVIDER` off `mock` (they default safe). Point the processor webhook
   at `/api/webhooks/payment`. Verify the processor's refund payload shape and
   finish the partial-refund-via-webhook handling.
3. **Set the admin second factor** — a 6-digit passcode per admin (Admin → My
   Account) or `ADMIN_ACCESS_CODE`. Login now fails closed once 2FA exists.
4. **Configure email** — `EMAIL_ENABLED=true` + a provider (Resend/SMTP).
5. **Confirm `PAYMENT_PROVIDER`/`BILLING_PROVIDER` are live/unset in prod** (mock
   mode would let anyone forge paid orders / free memberships).
6. **Finalize legal/business content** — entity, addresses, support channels,
   real policies (the pages exist and are admin-editable; content is yours).
7. **Run the live E2E audit on staging** (Phases 2 & 6) — I can drive this the
   moment staging is connected.

---

## Bottom line

The **logic, money, and security backbone is production-grade and audited**: no
known critical or high-severity issue remains, and the money/concurrency
guarantees are proven on real Postgres. What stands between here and a confident
production launch is **operational, not code** — connect Supabase + a real
processor + email, finish the legal/business content, and run the live E2E pass
on staging. I do **not** claim the site is fully verified for production until
that live pass runs; everything provable in this environment has been proven.
