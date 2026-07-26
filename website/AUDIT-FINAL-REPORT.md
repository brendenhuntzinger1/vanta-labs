# Vanta Labs — Final Audit Report

Three-lens audit (first-time customer · business owner · senior engineer) of the
Vanta Labs research-peptide storefront. Method: **audit first, verify each finding
against the code, fix only what's justified, test the change, preserve working
behavior.** Every fix below was committed with the full suite green.

**Statuses:** ✅ PASS · ⚠️ PASS WITH WARNING · ❌ FAIL · ⬜ NOT TESTED

---

## 1. Executive summary

The storefront is a **mature, well-architected system**, not a broken prototype:
a single server-authoritative profit engine, a webhook with exactly-once
idempotency, admin 2FA + RBAC, RLS deny-by-default, no SQL injection, and no
IDOR. The audit mapped the whole system, surfaced **38 findings**, verified each
against the code (correcting two the mapping got wrong), and fixed **24**. The
rest are documented as accepted-risk, product decisions, or latent items gated on
the not-yet-live payment processor.

**No launch-blocker remains in the code.** The remaining blockers are external
(wire the payment processor, run one data migration, set prod env vars) — the
same ones from before the audit.

Overall: **⚠️ PASS WITH WARNING** — ship-ready for manual-payment orders once the
external items below are done; card payments remain gated on the processor.

## 2. Customer-experience findings

| Status | Area |
|--------|------|
| ✅ | Age gate now honest about account requirement (was promising guest checkout) |
| ✅ | Membership consent text matches the price (no phantom 5% fee) |
| ✅ | Membership sign-in returns the user to the subscribe page |
| ✅ | Cart/checkout line totals always sum to the subtotal |
| ✅ | No empty-cart flash for returning shoppers |
| ✅ | Wishlist/addresses degrade instead of crashing |
| ✅ | Clearer "total changed" recovery message |
| ⚠️ | Promo-banner discovery only on /products & PDP (conversion tweak, §8) |
| ⚠️ | Stock UI inert until fulfillment is enabled (by design) |
| ✅ | Referral click-through attribution verified working (was mis-flagged) |

## 3. Business & profitability findings

| Status | Area |
|--------|------|
| ✅ | Profit guard now charges real outbound shipping cost — no hidden-loss orders |
| ✅ | Partial refunds recorded correctly (status + amount); chargebacks full-reverse |
| ✅ | Cart preview honors any admin-set referral %; matches the charge |
| ✅ | Server is the sole authority on every final price/discount/fee/tax/commission |
| ✅ | Commission base is post-discount merchandise only (excl. shipping/tax/fee) |
| ✅ | Loss-making orders blocked at/above the configured floor (default break-even) |
| ⚠️ | Store-credit/points applied after the guard — correct (prepaid liabilities) |
| ⚠️ | Duplicate money formulas (client preview vs server) — aligned, drift risk (§13) |

## 4. Engineering findings

| Status | Area |
|--------|------|
| ✅ | TypeScript: 0 errors |
| ✅ | Production build: green |
| ✅ | Webhook idempotency: exactly-once paid side-effects, terminal-state guards |
| ✅ | Inventory: atomic reserve/restock claims; partial refund no longer over-restocks |
| ✅ | Payout ledger: mirror flipped by exact claimed ids (drift closed) |
| ⚠️ | Request bodies hand-cast, no schema-validation library (§13) |
| ⚠️ | Dead code: `createReferralOrderRecord`, `bundleReferralPercent` (§13) |

## 5. Security findings

| Status | Area |
|--------|------|
| ✅ | Admin auth: hashed session tokens, scrypt passwords, mandatory 2FA, per-request active-check, dual lockout |
| ✅ | Customer/partner authz: ownership-scoped; no IDOR found |
| ✅ | Fraud endpoint now gated to manager+ (was any admin role) — PII closed |
| ✅ | Manual-payment endpoint now rate-limited |
| ✅ | analytics/track now IP-bucketed (session id was bypassable) |
| ✅ | cron/sweep secret compared constant-time |
| ✅ | Payout-method changes now audit-logged |
| ⚠️ | Webhook signs body only (event_id/timestamp outside signature) — replay mitigated by order-level guards; harden when wiring the live processor (§14) |
| ⚠️ | Service-role-only DB path: route code is the sole authz layer (RLS is backstop) |

## 6. Every bug found (register)

See `AUDIT-PHASE1-SOURCE-OF-TRUTH.md` §B for the full 38-item register with
file:line. Summary by disposition:

- **Fixed (24):** C1–C7, F1, F2, F3, A1, A5, A6, A7, A8, A10, A11, A13, S3, S5, S6, + Phase-5 payout confirmation.
- **Verified NOT a bug (2):** A3 (referral cookie IS consumed client-side), A9 (fraud flag independent of manual_review).
- **Accepted-risk / by-design (5):** F4 (prepaid liabilities), C10 (capability-URL PII), C9 (inert stock UI), S7 (service-role architecture), A12 (padded marketing stats).
- **Product decision / workflow (2):** A2 (post-payout clawback — auto vs manual), A4 (duplicate-account self-referral — needs fingerprinting).
- **Deferred cleanup (5, low-risk):** F5, F6, F7, A14, S4 — consolidation/dead-code/validation-library; tracked in §13.

## 7. Exact fixes made
Per-commit detail is in git (`0bbd799..HEAD`, 6 audit commits). Highlights:
- `payment-service.ts` — guard uses `shippingCostPerOrder` (F1).
- `payment-webhook.ts` — new pure `resolveRefundOutcome()` drives partial-refund
  status/amount, full-only restock, chargeback full-reversal (F2/A5).
- `partner-portal.ts` — payout status gate (A1), mirror-by-order-id (A8), preferred-
  code validation (A7), payout-method audit (A11), dashboard label fix (A13).
- `cart-context.tsx` + 3 consumers — bundle config exposed, hydration gate, referral % (C5/C6/F3).
- Rate-limit + constant-time + RBAC hardening across 3 routes (S3/S5/S6/A10).

## 8. Files changed
21 files, +480/−49. Full list in git `--stat 0bbd799..HEAD`. Two new docs
(this report + source-of-truth); the rest are targeted edits — no rewrites.

## 9. Database migrations made
**None generated by the audit** (all fixes were code-level). One **data migration
you still must run** carries over from the pre-audit work:
```sql
update products set category = 'Tissue Research' where category = 'Healing';
```

## 10. Tests added
7 unit tests for `resolveRefundOutcome` in `payment-webhook.test.ts` covering
full/partial/no-amount refunds, accumulation, chargeback-always-full, cancel, and
the non-refund no-op.

## 11. Test results
✅ **264/264 passing** (31 files), including pre-existing financial-invariant,
order-lifecycle-simulation, order-math-sweep, profit-protection-combination,
ambassador-financial-invariant, and webhook property/sweep tests. TypeScript 0
errors. **Repeated 4×, deterministic.**

## 12. Performance results
✅ Production build green; routes correctly split static vs dynamic. No N+1 or
slow-query regressions introduced. Formal load testing: ⬜ NOT TESTED (needs a
staging environment with the live processor).

## 13. Remaining risks
- **Duplicate money formulas** (client preview vs server) are aligned today but
  have no shared type — a future edit to one side could drift (F6). Consolidation
  recommended, deferred to avoid destabilizing working money code mid-audit.
- **No schema-validation library** (S4) — admin write routes hand-cast bodies.
  Recommend zod on admin/webhook inputs.
- **Dead code** `createReferralOrderRecord` (wrong commission base) & `bundleReferralPercent` (F7/A14) — remove to prevent future misuse.
- **A2 post-payout clawback** and **A4 duplicate-account self-referral** remain
  as flagged-not-blocked; both need a product decision (§ below).

## 14. Items requiring live credentials or external verification
1. **Payment processor** — live card capture, real webhook signing (then harden S1: put event_id + timestamp inside the signature).
2. **Prod env vars** in Vercel — `CRON_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `ADMIN_ACCESS_CODE`, Resend keys, `FULFILLMENT_WEBHOOK_SECRET`.
3. **Resend domain verification** for `vantalabsresearch.com` (receipts).
4. **Real COAs** behind every product's COA link (business content).
5. **Set the real `shippingCostPerOrder`** in Control Center → Profit Protection (F1 uses it; default $10).
6. **Attorney sign-off** on the kept marketing claims (separate legal packet).
7. **Load/perf test** on staging.

## 15. Launch-blocker list
**Code blockers: NONE.** External/operational blockers before public card sales:
- ❌ Payment processor not wired (card checkout shows "being set up").
- ⚠️ Run the `Healing → Tissue Research` data migration (live storefront).
- ⚠️ Set prod env vars + verify Resend domain.
- ⚠️ Confirm real COA links.

Manual-payment (Cash App/Zelle) orders are **not** blocked — that path is live.

## 16. Post-launch monitoring checklist
- Webhook: alert on signature failures, unclaimed events, `paid_side_effects_at` gaps.
- Reconciliation page: watch net-revenue vs payments daily (partial-refund fix now feeds it correctly).
- Payout queue: review `onHold` balances (disabled ambassadors) before each run.
- Fraud review queue: triage flagged referral orders + `manual_review` (refund-after-paid).
- Profit guard: log/alert on "Promotion unavailable" rejections (thin-margin combos).
- Cron sweeps: confirm all six run (billing, cart-recovery, store-credit, commission-approval, reservation-expiry, email-retry).
- Rate-limit 429s and email retry-queue depth.

## 17. How every major system works (plain English)
Full narrative in `AUDIT-PHASE1-SOURCE-OF-TRUTH.md` §A. In brief: shoppers browse
a Supabase-backed catalog; the cart lives in the browser and shows *previews*, but
**every final number is recomputed on the server** at checkout, which also blocks
any order that would lose money. Payment confirmation arrives via a signed,
idempotent webhook that flips the order to paid exactly once, decrements
inventory, and books ambassador commission on post-discount merchandise.
Refunds/chargebacks reverse commission proportionally and restock only on a full
reversal. Ambassadors apply, get approved, share a validated referral code, earn
tiered commission that clears a 14-day hold, and get paid from the queue — and a
disabled ambassador can no longer be paid. Admins manage everything behind 2FA +
role permissions, with dangerous actions confirmed and audit-logged.

---

*Audit complete. Branch `claude/glp1-site-pricing-5a6860`, all changes committed
and pushed, full suite green.*
