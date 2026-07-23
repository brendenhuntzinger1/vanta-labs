# Ambassador Program — Implementation & QA Report

**Date:** 2026-07-23 · **Branch:** `claude/continue-previous-work-kqo7s9`

Built against your 9-point spec. The proven commission/payout **engine was left
untouched** — the prior audit confirmed its lifecycle, refund reversal, no-double-
payout, and removal cascade are correct — and the new pieces were built around it.

> **Verification honesty:** logic/build verified by execution here (174 unit
> tests, real-Postgres concurrency tests, tsc, lint, production build). Live
> click-through (apply → approve → order → payout → emails in a browser) needs
> staging — the same Tier A/B split as the rest of the project.

---

## What was implemented, point by point

**1. Public "Become an Ambassador" — benefits + responsibilities (DONE)**
The `/partner` page now shows, before applying: the full **Benefits** list (15%
personal discount, 10%-off referral code, configurable commission shown live,
real-time dashboard, biweekly payouts, bonuses, early access) and the full
**Responsibilities** list (3 social posts/month, professional conduct, no medical
claims, no prohibited advertising, keep code active, follow rules), plus the
14-day-hold and biweekly-payout explanation. (Fixed stale "1 video/month" copy.)

**2. Approval email (DONE)**
Rewritten to a complete onboarding email: congratulations, referral code, the
automatic 15% personal discount, benefits, responsibilities, how commissions are
earned, the **14-day hold** (refund/chargeback protection), **biweekly payouts**,
dashboard tracking, and **acceptable payout methods** — driven by live config
(commission %, discount %, hold days).

**3. Payout method collection (DONE)**
New `payout_method` + `payout_handle` columns on partners/ambassadors. An approved
ambassador chooses **PayPal / Venmo / Cash App** + handle from their dashboard
(prompted prominently when unset), saved via `POST /api/partner/payout-method`
(scoped to their own `auth_user_id`). Updatable anytime. The method is also
stamped on each payout record for accounting.

**4. Commission lifecycle (VERIFIED — already solid)**
Statuses: `pending → approved_for_payout → paid`, plus `reversed`/`voided` on
refund/cancel and `manual_review` for a refund after a paid commission. The
14-day hold → approved transition is enforced; refunds/cancels reverse (full) or
proportionally retain (partial) commission; **refunded/cancelled orders never
pay**. No change needed — this was confirmed correct.

**5. Admin Payout Queue + notification badge (DONE)**
New **Payout Queue** on the admin Partner Operations page: ambassador, amount
owed, **# approved orders**, **payout method + handle**, **eligible-since date**,
and a Ready / Below-min status — sorted by amount. A **"🔔 N ambassadors are
ready for payout"** badge appears when any meet the minimum and jumps to the queue.

**6. Mark as Paid (ENHANCED)**
The existing atomic mark-paid (records date/amount, moves to Paid, removes from
queue, no double-pay) now also **records the payout method used** and **emails the
ambassador a payment confirmation** (amount, method, handle, order count) — the
one missing piece.

**7. Ambassador dashboard (DONE)**
Now shows **Pending (14-day hold)**, **Approved (next payout)**, and **Paid** as
distinct buckets, total earnings, referral code, the **automatic 15% personal
discount** note, referral orders, payout history, and the **payout-method editor**
with update ability.

**8. Admin controls (VERIFIED + aligned)**
Commission %, discount %, minimum payout, and the 14-day waiting period are
admin-configurable; approve/suspend/remove work with the correct cascade (disable
the referral code, remove the personal discount, stop future commissions, preserve
payout history). Aligned defaults to spec (personal discount 15%, default
commission 15%, new applicants take the admin-configured default). *Payout-schedule
cadence remains "every 2 weeks" (the stated cadence); mark-paid stays a deliberate
manual admin action per your point 6.*

**9. Automation**
The 14-day approval now runs in the **cron sweep** (`autoApproveEligibleCommissions`)
so commissions advance automatically — not only when the partner page is loaded.

---

## QA performed

- **174 unit/logic tests** (incl. new payout-method validation) — pass.
- **Real-Postgres concurrency stress tests** — pass, including the ambassador
  **no-double-payout** proof (2 concurrent claims of 20 commissions → paid once,
  $200 exact) and commission-reversal-on-refund.
- **~10,000-scenario order-math sweep** (existing) covers commission on the
  discounted base, referral + bundle stacking, and the profit floor — unchanged
  and still green, so the discount/commission math this feature depends on is
  proven across far more than 100 scenarios.
- **tsc + lint + production build** — clean.

**No regressions:** the commission/discount/refund engine was not modified; all
changes are additive (payout method, emails, queue UI, dashboard, cron wiring).

---

## Needs staging to fully prove (Tier B)

The end-to-end click-through — submit application → admin approve (approval email)
→ ambassador sets payout method → place a referred order → 14 days pass (or cron
runs) → commission approves → admin sees the badge + queue → Mark Paid (payout
email) → refund reverses — is **wired and code-reviewed** but needs a running app
against live Supabase + email to execute. Run `staging-seed.sql` (it seeds an
approved ambassador) and follow `STAGING_SETUP.md`; I can drive that pass once
staging is connected.

## Migration note
Apply `deploy-run-once.sql` (now includes the `payout_method`/`payout_handle`
columns) or the standalone `ambassador-payout-method.sql` before this ships.
