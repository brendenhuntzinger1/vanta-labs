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
  FIN-03 (tax collection disabled) is **out of scope** and remains open.
- No RLS, grant, or auth work — that belongs to the other audit lanes.

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

**C1. Table `pending_financial_effects`**

```
id             uuid pk
order_id       text not null
effect_kind    text not null
payload        jsonb not null default '{}'
attempts       integer not null default 0
last_error     text
next_attempt_at timestamptz not null default now()
status         text not null default 'pending'   -- pending | succeeded | failed
created_at     timestamptz not null default now()
updated_at     timestamptz not null default now()
unique (order_id, effect_kind) where status = 'pending'
```

The partial unique index prevents an effect double-enqueueing for one order.

**C2. Retry is only safe for an idempotent effect.** Audited each one against its implementation:

**Auto-retry — guarded, verified idempotent:**

| effect | guard |
|---|---|
| `ensureCommissionRecord` | refuses to regress a non-`pending` commission (`payment-webhook.ts:769`) |
| `finalizeInventoryForOrder` | acts only on `status='active'` reservations |
| `recordActualShippingCost` | fixed-value UPDATE; audit insert guarded by A5 |
| refund-amount recording | fixed-value UPDATE |
| `reverseOrderPoints` | existing-row guard on `order_id` (`membership.ts:412`) |
| `restoreRedeemedPoints` | guard on `(order_id, reason)` (`membership.ts:470-472`) |
| `refundStoreCreditForOrder` | explicit already-refunded guard (`store-credit.ts:142-149`) |

**Alert-only — NOT idempotent, retry would double-write:**

| effect | why |
|---|---|
| `recordPointsLedgerEntry` (`order_earn`) | bare `INSERT`, no `(order_id, reason)` guard (`membership.ts:356`) |
| `redeemStoreCredit` | bare insert, no guard (`store-credit.ts:115`) |
| `redeemCoupon` | unconditional atomic increment, and no order linkage exists to guard on |
| `activatePaidMembership` | upserts the membership idempotently, but then calls `recordBillingEvent({eventType:"renewal"})` as a bare INSERT (`membership-billing.ts:306`) — a retry duplicates a renewal in the billing ledger and re-sends the welcome email. It also recomputes `renews_at` from `now()`, shifting the period by the retry delay. |

These four raise a critical alert and appear in the admin queue, but are never auto-retried. None can
double-charge a customer; they fail in the direction of a benefit not being applied, or a duplicated
ledger row, which is why they are held for a human.

> An earlier draft placed `activatePaidMembership` in the auto-retry bucket on the strength of a
> duplicate-purchase guard that turned out to belong to `createMembershipCheckoutSession`, a different
> function. Verified against the implementation and moved.

**C3. Optional, called out rather than smuggled in.** Adding a partial unique index on
`points_ledger(order_id, reason)` and `store_credit_ledger(order_id, reason)` would move two of those three
into the auto-retry bucket. It is a schema change on financial ledgers and needs its own approval; it is
**not** included by default. `redeemCoupon` cannot be fixed this way — it would need a
`coupon_redemptions(order_id, code)` table, which is a separate piece of work.

**C4. Wiring.** Each `catch` block keeps its `console.error` and adds `enqueueFinancialEffect(...)` for an
auto-retry effect, or `recordSystemAlert({severity: 'critical'})` for an alert-only one. The side-effect
claim latch is unchanged — the outbox, not the latch, is what makes the effect eventually happen.

**C5. Drain.** `/api/cron/sweep` gains a financial-effects pass: claim due rows with
`FOR UPDATE SKIP LOCKED`, re-run the effect, mark `succeeded`, or increment `attempts` with backoff. At
`attempts >= 5`, set `failed` and raise a critical alert.

**C6. Admin surface.** A "Needs attention" list of `failed` and long-`pending` rows, so an exhausted effect
is visible without reading logs.

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

## F. Sequencing and risk

1. Code + tests, verified locally. Nothing touches production.
2. Report the idempotency buckets and test results to the owner.
3. Schema additions (`pending_financial_effects`, `order_cost_restatements`, archive tables).
4. Production data writes **only on the owner's go-ahead**, each preceded by a read-back, each reversible:
   parent-cost NULLs → cost restatement → 3PL archive+delete → shipping backfill.
5. Notify the other two audit sessions before step 4 — they are reading this database and a cost change
   mid-audit would confuse their results.

**Primary risk:** a retry of an effect wrongly believed idempotent. Mitigated by C2's per-effect audit, by
the run-twice tests in §E, and by defaulting to alert-only whenever idempotency is not provable.

**Rollback:** every data write is reversible. Parent costs and restated line costs are recorded in
`order_cost_restatements` and the archive tables before deletion; the outbox is additive; the fee change is
a config value.
