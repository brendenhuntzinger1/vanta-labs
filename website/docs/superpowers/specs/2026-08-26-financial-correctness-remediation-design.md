# Financial Correctness Remediation — Design

**Date:** 2026-08-26
**Status:** Approved in chat; pending spec review
**Origin:** `website/docs/FINANCIAL-DATA-RECONCILIATION.md` (findings FIN-01, FIN-02, FIN-04, FIN-07, FIN-08)

## Problem

Five defects, confirmed against production data:

1. Shipping expense is never recorded — two real Shippo labels, zero postage captured.
2. Parent-level `product_cost_cents` holds superseded EvoLabs seed costs and is the live COGS fallback;
   four orders froze those figures, understating profit by $51.39.
3. Ten financial operations in the paid-order pipeline are caught, logged to a serverless console, and
   continued past, behind a claim spent before they run — so nothing retries.
4. The processor fee is adjustable but its effective value is invisible when the field is blank.
5. EvoLabs — the former third-party fulfilment provider — has left cost data, dead tables, dead enum
   values and re-runnable seed scripts behind.

## Decisions taken (owner, 2026-08-26)

| Question | Decision |
|---|---|
| Failure handling for silent effects | Durable retry queue + critical alert |
| Historical COGS on the 4 affected orders | Restate, with an audit trail |
| Stale parent `product_cost_cents` | Null them out |
| cerebrolysin / pinealon costs | Mark as no cost on file (NULL) |
| EvoLabs removal scope | Full removal; archive the 3PL rows before deleting |
| EVO seed SQL files | Delete |

## Non-goals

- No change to the immutability of `order_items.unit_cost_cents` going forward. The restatement is a
  one-time correction of figures that were wrong when captured, not a new mutable-cost policy.
- No repricing. Nothing here touches `price_cents`.
- No change to `count_sales_tax_as_profit`, the free-shipping threshold, or the tax nexus list.
- No RLS, grant, or auth work — that belongs to the other audit lanes.

### FIN-03 (sales tax) — OUT OF SCOPE, OWNED BY ANOTHER LANE, STILL OPEN

Sales tax collection is switched off store-wide (`tax.nexus_states` is blank), including Florida, where
the business is physically located. Two paid Florida orders collected $0.00.

This is **deliberately excluded** from this implementation — the tax/configuration audit lane owns it.
It must NOT disappear from the final report on that account. It remains an **unresolved, high-priority
production and compliance finding**, and every report this lane produces carries it forward as open and
externally owned until that lane closes it.

### §C3 (financial-ledger unique indexes) — DEFERRED BY THE OWNER

Not implemented while other audit sessions are active, because it is a schema change to live financial
ledgers. Carried as a **recommended hardening follow-up** (see §C3).

---

## A. Shipping expense

The write path is already correct and complete. `purchaseLabel` calls `recordActualShippingCost()`, which
preserves `estimated_shipping_cost_cents`, writes `actual_shipping_cost_cents`, sets
`shipping_cost_source`, flips `profit_finalized`, and inserts an `order_shipping_cost_audit` row. It landed
in commit `67d2453` (2026-08-26) — after both existing labels were bought, which is why production shows
NULLs.

**A1. Backfill two orders.** `getTransaction(id)` (`src/lib/shippo/client.ts:653`) issues a **GET** to
`/transactions/<id>` — a read, not a purchase, so it cannot incur a second charge. Fetch settled postage for
`2aaf020b7a4c431c88dfed21f5b10333` (VL-8847B157) and `3a7fa84885e7401487990c2b43ddc105` (VL-8D132452) and
feed each through the existing `recordActualShippingCost`.

**A2. Stop discarding the failure.** `src/lib/shippo/service.ts:1272` awaits `recordActualShippingCost` and
ignores its `{ok:false}` return. Wire it into the outbox from §C.

**A3. Add a detector.** A check reporting any order with `label_purchased_at IS NOT NULL` and
`actual_shipping_cost_cents IS NULL`, surfaced next to the existing reconciliation checks.

**A4. VL-E8F4D52F is not recoverable.** It shipped on a manually-entered UPS tracking number with no Shippo
transaction. Set `shipping_cost_source = 'manual'` and leave the cost for the owner to enter. Do not invent
a figure.

**A5. Audit-insert guard.** `recordActualShippingCost` inserts an `order_shipping_cost_audit` row
unconditionally. Under retry that duplicates. Add a guard so re-recording the same
`(order_id, exact_cost_cents)` does not write a second audit row.

---

## B. COGS and EvoLabs removal

`src/lib/sql/product-cogs.sql` is the authoritative landed-cost load ("per individual vial/unit and already
include the supplier's $500 inbound shipping"). Its values match production's **dose** costs exactly. The
older `product-costs-evo.sql` matches production's **parent** costs exactly. Dose costs are correct; parent
costs are inherited EvoLabs figures.

**B1. Null the parent costs.** `UPDATE products SET product_cost_cents = NULL` for every published product
that has at least one dose row. Matches `product-cogs.sql`'s stated intent: *"The parent is set only for
products that have no dose rows at all."*

**B2. Change the fallback semantics — this is the fix that prevents recurrence.** In
`quote-order.ts:819-826`, `unitCostCentsForLine` currently falls back to the parent slug cost when a dose
cost is absent. After this change a missing dose cost returns `null`, so `computeOrderProfit` sets
`hasEstimatedCost` and reports COGS as *estimated* rather than silently substituting another number.
The data change alone would not prevent this; the fallback is the mechanism.

The same fallback appears in `guardProductCost` (the checkout profit floor). There it must keep falling
back — to `profitSettings.worstCaseUnitCost`, never to a parent figure — so an unpriced SKU still cannot be
sold below break-even.

**B3. Restate four orders.** Rewrite `order_items.unit_cost_cents` to true landed cost:

| order | line | from | to |
|---|---|---:|---:|
| VL-E8F4D52F | GLP-1 (5mg) | 2456 | 383 |
| VL-8847B157 | MOTS-C (10mg) | 2520 | 768 |
| VL-EA5529EF | Bac Water (10mL) | 800 | 143 |
| VL-64F8EDE4 | 5-Amino-1MQ | 3300 | 1066 |

New table `order_cost_restatements`: `order_item_id`, `order_id`, `old_cost_cents`, `new_cost_cents`,
`reason`, `restated_by`, `restated_at`. One row per change.

**B4. cerebrolysin and pinealon → NULL** on both parent and dose. Excluded from the landed-cost invoice;
currently carrying EvoLabs' 3500.

**B5. Archive then delete the dead 3PL tables.** `fulfillment_orders` (2), `fulfillment_payouts` (2),
`fulfillment_events` (194). No application code reads or writes any of them; all data stops 2026-08-06.
Copy each into an `archive_fulfillment_<name>` table in the same database via
`CREATE TABLE … AS SELECT * FROM …`, verify the row counts match (2 / 2 / 194), and only then delete the
originals. Archive tables are plain data with no RLS policies and no application reader.

**B6. Drop dead enum values.** Remove `"provider" | "fulfillment"` from the `shipping_cost_source` union in
`admin-profit.ts:666`. Zero orders use them.

**B7. Delete the EVO seed scripts.** `load-evo-catalog.sql`, `load-evo-catalog-grouped.sql`,
`product-costs-evo.sql`. Re-running `product-costs-evo.sql` would overwrite the real landed costs with
EvoLabs figures — the files are a live footgun. Git history preserves them.

---

## C. Financial retry outbox

Mirrors the existing, proven pattern: `pending_emails` + `src/lib/email/retry-queue.ts`, exponential
backoff, `MAX_ATTEMPTS = 5`, drained by `/api/cron/sweep` every 30 minutes (`vercel.json`). No second
mechanism is invented.

**C1. AMENDED 2026-08-26 — absence-based repair, not an outbox.**

The original design specified a `pending_financial_effects` table with enqueue wiring in each catch block.
Superseded during planning: `src/lib/commission-accrual-repair.ts` already implements a better pattern for
this exact problem, is already registered in the cron, and is already running every 30 minutes.

Why absence detection wins here:

- **No migration.** `orders` is already the durable record. The whole fix is code, so it lands inside
  Phase 1 rather than behind the Phase 2 wall.
- **Repairs the existing backlog**, not just failures after deploy — which matters, because the commission
  ledger is empty from precisely this bug.
- **Idempotent by construction.** The sweep looks for ABSENCE, so a second run finds nothing to do. No
  enqueue can be lost between the failure and the record of it.

Each sweep mirrors `repairMissingCommissionAccruals`: bounded lookback and limit, oldest first, read
candidates → read what already exists → set-difference → repair loop, `{scanned, repaired, failed}`,
a critical `recordSystemAlert` naming the unrecovered orders, and a throw on read error ("a sweep that
cannot read is not a sweep that found nothing").

**Absence conditions:**

| effect | absence condition |
|---|---|
| commission accrual | **already implemented** — `repairMissingCommissionAccruals` |
| shipping cost | `label_purchased_at` not null, `shippo_transaction_id` not null, `actual_shipping_cost_cents` null |
| refund amount | `payment_status='refunded'`, `refund_amount = 0` |
| `reverseOrderPoints` | refunded, `points_earned > 0`, no `points_ledger` row `(order_id, 'order_refund_reversal')` |
| `restoreRedeemedPoints` | refunded, `points_redeemed > 0`, no `points_ledger` row `(order_id, 'order_refund_points_restore')` |
| `refundStoreCreditForOrder` | refunded, `store_credit_redeemed_cents > 0`, no `store_credit_ledger` row `(order_id, 'membership_redemption_refund')` |

The four refund-triggered effects share one scan over refunded orders rather than four separate sweeps.

**Two new modules:** `src/lib/shipping-cost-repair.ts` and `src/lib/refund-effect-repair.ts`, each
registered as a job in `src/app/api/cron/sweep/route.ts`.

**DEPLOYMENT IS A PHASE 2 DECISION.** These sweeps are pure code, but once deployed they write to
production on their schedule. They are built and tested behind the wall; the deploy call is the owner's,
separately.

**Absence detection does NOT rescue the five alert-only effects.** Check-then-act is not atomic, and those
five have no convergence guard if two sweeps overlap — unlike the six, which do. They need the uniqueness
constraints in §C3, which is deferred. They stay alert-only.

**C2. Retry is only safe for an idempotent effect.** Audited each one against its implementation:

**Auto-retry — guarded, verified idempotent.** Idempotency is asserted for the WHOLE effect — primary
write plus every downstream ledger entry, email, counter and notification — not for the primary write
alone.

| effect | guard, including downstream |
|---|---|
| `ensureCommissionRecord` | refuses to regress a non-`pending` commission; a retry after a successful insert takes the UPDATE branch, which never reaches `notifyAmbassadorOfNewCommission`, so no second email. `commissions` mirror is an upsert on `order_id`. |
| `recordActualShippingCost` | fixed-value UPDATE. The `order_shipping_cost_audit` insert is unconditional and WOULD duplicate — retry-safe only once A5 lands. Conditional on A5. |
| refund-amount recording | fixed-value UPDATE, no downstream |
| `reverseOrderPoints` | `(order_id, reason='order_refund_reversal')` existing-row guard; its only downstream, `recordPointsLedgerEntry`, sits behind that guard (`membership.ts:427-437`) |
| `restoreRedeemedPoints` | guard on `(order_id, reason)` (`membership.ts:470-472`) |
| `refundStoreCreditForOrder` | explicit already-refunded guard (`store-credit.ts:142-149`) |

**Alert-only — NOT idempotent, retry would double-write:**

| effect | why |
|---|---|
| inventory decrement (composite) | `finalizeInventoryForOrder` alone IS idempotent (acts only on `active` reservations). But the caught block falls through to `decrementInventoryForOrder` whenever `fin.degraded \|\| fin.finalized === 0` — an unguarded loop of `applyInventoryDelta(-qty)` with no order-scoped claim (`inventory-fulfillment.ts:79-90`). That fallback fires in exactly the case worth retrying (an expired hold), so a retry double-decrements. The RESTOCK direction has an exactly-once latch (`inventory_restocked_at`); the DECREMENT direction has none. Making this retry-safe needs a per-order decrement claim — a schema change, deferred with §C3. |
| `recordPointsLedgerEntry` (`order_earn`) | bare `INSERT`, no `(order_id, reason)` guard (`membership.ts:356`) |
| `redeemStoreCredit` | bare insert, no guard (`store-credit.ts:115`) |
| `redeemCoupon` | unconditional atomic increment, and no order linkage exists to guard on |
| `activatePaidMembership` | upserts the membership idempotently, but then calls `recordBillingEvent({eventType:"renewal"})` as a bare INSERT (`membership-billing.ts:306`) — a retry duplicates a renewal in the billing ledger and re-sends the welcome email. It also recomputes `renews_at` from `now()`, shifting the period by the retry delay. |

These five raise a critical alert and appear in the admin queue, but are never auto-retried.

Final split: **6 auto-retry, 5 alert-only.**

> Two effects were moved OUT of the auto-retry bucket during spec review, both for the same reason — the
> primary write was idempotent but a downstream effect was not:
>
> - `activatePaidMembership` — credited with a duplicate-purchase guard that actually belongs to
>   `createMembershipCheckoutSession`. Its real path upserts the membership idempotently, then calls
>   `recordBillingEvent({eventType:"renewal"})` as a bare INSERT.
> - inventory decrement — `finalizeInventoryForOrder` is guarded, but the composite block's legacy
>   fallback is not.
>
> This is the criterion the owner set: an operation is retryable only when every downstream side effect,
> ledger entry, email, counter and notification is also proven idempotent.

**C3. DEFERRED — NOT IN THIS IMPLEMENTATION.** Adding a partial unique index on
`points_ledger(order_id, reason)` and `store_credit_ledger(order_id, reason)` would move two alert-only
effects into the auto-retry bucket, and a per-order decrement claim would move a third (inventory). These
are schema changes to live financial ledgers and the owner has explicitly deferred them while other audit
sessions are active. Recorded as **recommended hardening follow-up**; not implemented here. `redeemCoupon` cannot be fixed this way — it would need a
`coupon_redemptions(order_id, code)` table, which is a separate piece of work.

**C4. Alert-only wiring.** The five unsafe effects keep their `console.error` and gain a critical
`recordSystemAlert` so the failure is durable and operator-visible instead of living in a serverless log.
The side-effect claim latch is unchanged.

**C5. Cron registration.** Two entries added to the keyed `JOBS` registry in
`src/app/api/cron/sweep/route.ts`. The registry is keyed, not positional, so adding jobs cannot mislabel
existing ones.

---

## D. Processor fee visibility

Control Center already loads and saves `profit.processing_fee_percent`
(`admin-control-center-client.tsx:202,305`). The stored value is the empty string, which falls through to
`DEFAULT_PROFIT_CONFIG.processingFeePercent = 8`. It is adjustable; its effective value is invisible.

**D1.** Persist `8` explicitly so the stored configuration is truthful.
**D2.** Show the effective rate as placeholder/help text when the field is blank ("blank = 8% default").
**D3.** Surface the effective rate on the profit page beside the modelled fee.

No new plumbing. The fee stays modelled — nothing ingests a settled processor fee, and every surface must
keep labelling it an estimate.

---

## E. Testing

TDD throughout, per `CLAUDE.md`. A failing test first for each behaviour:

- `unitCostCentsForLine` returns `null` (not the parent cost) when a dose cost is absent.
- `guardProductCost` still falls back to `worstCaseUnitCost`, never to a parent figure.
- Outbox: enqueue, drain-success, drain-retry-with-backoff, exhaust-and-alert, and the partial-unique
  constraint refusing a duplicate pending row.
- Each auto-retry effect run twice produces the same end state (the idempotency claim, asserted rather
  than assumed).
- Restatement writes exactly one audit row per changed line.
- Fee resolution: blank → 8, explicit 0 → 0 (not 8), explicit 2.9 → 2.9.
- `recordActualShippingCost` run twice writes one audit row.

Browser verification per `CLAUDE.md`: Control Center profit section against local dev at 390×844 and
desktop. Nothing else here is customer-facing.

---

## F. Sequencing — HARD WALL BEFORE PRODUCTION

**Phase 1 — permitted now (this branch only):** code changes, tests, and migration//backfill SQL written
to files but NOT executed.

**Phase 2 — BLOCKED pending separate explicit approval.** Nothing in this list may run until the owner
approves it after reviewing exact affected-row counts:

- any production data write (parent-cost NULLs, cost restatement, cerebrolysin/pinealon NULLs)
- any migration (`pending_financial_effects`, `order_cost_restatements`, archive tables)
- any destructive or archive operation (the 198 `fulfillment_*` rows)
- any financial-ledger modification
- any configuration change (including D1, persisting the 8% fee)
- the shipping backfill (A1, A4)

At the Phase 1 / Phase 2 boundary the owner receives: code changes, tests added, mutation controls, exact
full-suite results, the 6 auto-retry effects with proof of idempotency, the 5 alert-only effects with the
exact reason each is unsafe, proposed production changes with exact affected-row counts, a
rollback/recovery plan, anything still unverified, and confirmation that no production data, schema or
configuration was changed.

The other two audit sessions are notified before any Phase 2 step — they are reading this database.

**Primary risk:** a retry of an effect wrongly believed idempotent. Mitigated by C2's per-effect audit, by
the run-twice tests in §E, and by defaulting to alert-only whenever idempotency is not provable.

**Rollback:** every data write is reversible. Parent costs and restated line costs are recorded in
`order_cost_restatements` and the archive tables before deletion; the outbox is additive; the fee change is
a config value.
