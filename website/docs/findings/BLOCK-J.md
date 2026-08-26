# Block J — Cross-system collision matrix

**Session branch:** `claude/block-ab-audit-8xz6fb` (same session that produced
Block D; the branch name predates the reassignment and carries no A/B work).

Phase 17. The brief's own point: **systems that are individually correct and
break when combined.** A pair is not interesting because both halves have bugs —
it is interesting when each half is defensible on its own and the combination is
not.

---

## Verdict scale

| Verdict | Means |
|---|---|
| **PROVEN** | A concrete collision demonstrated by a committed test, a probe, or database evidence, in a named finding |
| **PARTIALLY PROVEN** | The mechanism is established and at least one side is proven, but the combined failure has not been exercised end to end |
| **UNTESTED** | A real interaction path exists; nothing has been run against it |
| **NOT APPLICABLE** | No shared state and no call path — the two do not meet |
| **PENDING** | Depends on a block whose results are not final (I, K, E, F). Where those blocks have already published partial findings, they are cited — but the pair is not graded on them |

**Nothing here is graded above its evidence.** This block ran no network and no
browser; every PROVEN verdict traces to a committed test, a source read confirmed
in this session, or another block's stated evidence with its grade carried over.

## Subsystems

Taken from `PHASE1-SYSTEM-MAP.md`'s own ten sections, plus the reporting subsystem
its GAPS-AND-SEAMS section says nobody owned.

| Key | Subsystem |
|---|---|
| **AFF** | Affiliate / ambassador — referral resolution, commissions, payouts |
| **PAY** | Checkout & payments — quote, session, tokenisation, webhook, order creation |
| **EMAIL** | Transactional and marketing email, retry queue, campaigns |
| **FUL** | Fulfillment, Shippo, labels, replacements |
| **INV** | Inventory & catalog — reservations, decrements, stock display |
| **DISC** | Discounts, coupons, promotions, memberships |
| **JOBS** | Background jobs (cron sweep), analytics/pixels, config & env fallbacks |
| **ADMIN** | Admin surface, auth, authorization, security posture |
| **DB** | Schema, migrations, RLS, integrity |
| **FIN** | Financial reporting — profit, revenue, reconciliation, sales tax |

45 unordered pairs.

---

## The matrix

| # | Pair | Verdict | Evidence / reason |
|---|---|---|---|
| 1 | AFF × PAY | **PARTIALLY PROVEN** | Referral validated twice against different tables; checkout reads the body code only, never the cookie. Ledger F-009 proves the identity half. Combined order-time failure not exercised. |
| 2 | AFF × EMAIL | **PENDING (C)** | Block C's C-01 proves the approval email quotes a rate from the non-authoritative table. Cited, not graded here. |
| 3 | AFF × FUL | **NOT APPLICABLE** | Commission is computed at payment; no fulfillment state feeds it, and no shipping write reads an ambassador. |
| 4 | AFF × INV | **NOT APPLICABLE** | No shared state. A referral affects price, never stock. |
| 5 | AFF × DISC | **PARTIALLY PROVEN** | `resolveCustomerDiscount` picks one best candidate among referral / coupon / B3G1. Server logic source-verified; the cart-side divergence (`cart-context.tsx:682`) is a map P1 and needs a browser. |
| 6 | AFF × JOBS | **UNTESTED** | Commission hold and eligibility sweeps run unattended; no probe run. |
| 7 | AFF × ADMIN | **PENDING (I)** | Payout authority and partner IDOR are Block I's. |
| 8 | AFF × DB | **PARTIALLY PROVEN** | `ambassadors` and `partners` both hold `referral_code` UNIQUE; the ledger records the convergence and the unchecked second write. |
| 9 | AFF × FIN | **PENDING (F)** | Profit reads the `commissions` table; reconciliation does not. Block F. |
| 10 | PAY × EMAIL | **PENDING (C)** | C-02 (receipt sent twice by the retry sweep) and C-05 (refund email untraceable), both proven in Block C. |
| 11 | PAY × FUL | **PARTIALLY PROVEN** | The payment webhook schedules the Shippo push via `after()`; D-01/D-02 prove the write side. The paid→push handoff itself is not exercised. |
| 12 | PAY × INV | **PARTIALLY PROVEN** | reserve → finalize → fallback-decrement is source-verified end to end. The `fin.degraded \|\| finalized === 0` fallback is the live double-decrement risk and has **no** test. |
| 13 | PAY × DISC | **PROVEN** | **D-05.** A membership tier change repriced the local row and never told Veyra: perks moved, the charge did not. Committed test. |
| 14 | PAY × JOBS | **UNTESTED** | `expireStaleReservations` skips paid / partially_refunded orders — correct by inspection, unproven under a real race. |
| 15 | PAY × ADMIN | **PENDING (I)** | Replacement creation writes `payment_status='paid'` outside the webhook. See §J-03. |
| 16 | PAY × DB | **PROVEN — FIXED** | `insertOrderRow`'s PGRST204 fallback drops **`idempotency_key` — the duplicate-charge guard** — plus the tax audit trail and billing address, on a drift in any unrelated column. Verified line by line; see §J-04. |
| 17 | PAY × FIN | **PENDING (F)** | Four surfaces disagree on what "an order" is. Block F. |
| 18 | EMAIL × FUL | **PENDING (C)** | C-04 proves two shipping emails for one parcel — the admin path and the carrier scan do not know about each other. |
| 19 | EMAIL × INV | **UNTESTED** | Back-in-stock notification fires on a 0→positive admin adjustment. No probe. |
| 20 | EMAIL × DISC | **PENDING (K)** | K-02 (hardcoded "5% off" vs admin-configurable) and K-05 (dead coupon; the literal string `SEE PREVIOUS EMAIL`). |
| 21 | EMAIL × JOBS | **PENDING (C, K)** | C-06 — a failed send re-arms the recovery stage and re-sends every 30 minutes. Block C graded it a launch blocker. |
| 22 | EMAIL × ADMIN | **PENDING (I)** | I-01 — provider secrets stored plaintext in `admin_audit_logs` and rendered by the viewer. |
| 23 | EMAIL × DB | **PENDING (C)** | C-10 — automation dedupe is a read-then-write against a table with no unique constraint. Same shape as D-02. |
| 24 | EMAIL × FIN | **NOT APPLICABLE** | Campaign revenue attribution is reporting-side only; no email write reaches a financial surface. |
| 25 | FUL × INV | **PARTIALLY PROVEN** | **§J-03.** Replacements decrement stock with no reservation and no idempotency claim, then get swept into Shippo. Both halves verified in source this session; not exercised together. |
| 26 | FUL × DISC | **NOT APPLICABLE** | No discount state is read or written by any shipping path. |
| 27 | FUL × JOBS | **PARTIALLY PROVEN** | `sweepUnsyncedOrders` filter read this session: excludes `membership`, **not** `replacement`. See §J-03. |
| 28 | FUL × ADMIN | **PROVEN** | **D-01.** An admin status write and a carrier scan both wrote `fulfillment_status` unguarded, and the admin path bypasses the terminal and regression rules entirely. Committed test; now refused with a 409. |
| 29 | FUL × DB | **PARTIALLY PROVEN** | `shippo_webhook_events.event_key` UNIQUE is the only lock on the entire webhook surface. D-02 proved one path was not using it. |
| 30 | FUL × FIN | **PROVEN** | **D-02.** A replayed `transaction_created` re-ran `recordActualShippingCost`, re-set `profit_finalized`, inserted duplicate audit rows, and **resurrected the cost of a voided label**. Committed test. |
| 31 | INV × DISC | **UNTESTED** | Buy-3-Get-1 adds a free physical unit; whether it is reserved is unproven. See §J-06. |
| 32 | INV × JOBS | **PARTIALLY PROVEN** | Reservation expiry runs inside the sweep; maintenance mode 503s the whole sweep. See §J-05. |
| 33 | INV × ADMIN | **PROVEN** | **D-04**, with **D-07** as the live instance. An ordinary admin Save reset `track_inventory`, `reserved_quantity` and three more columns — disarming oversell protection and discarding live holds. |
| 34 | INV × DB | **PARTIALLY PROVEN** | Two flags claim to answer "is this row enforced"; `getStockLevelsBySlugs` mirrors the obsolete one (map P1). Source-verified, not exercised. |
| 35 | INV × FIN | **PENDING (F)** | Unit cost feeds profit; a dose re-insert used to drop cost provenance. Block F. |
| 36 | DISC × JOBS | **PENDING (K)** | K-01 — coupon expiry stated in UTC in recovery emails. |
| 37 | DISC × ADMIN | **UNTESTED** | Admin-configurable promotion settings are read by cart, checkout and email. No probe. |
| 38 | DISC × DB | **UNTESTED** | Coupon redemption counting under concurrency. Not exercised. |
| 39 | DISC × FIN | **PENDING (F)** | Sales tax counts partial refunds as full collections. Block F. |
| 40 | JOBS × ADMIN | **PARTIALLY PROVEN** | **§J-05.** Maintenance mode 503s `/api/cron/sweep` — all 13 jobs, including reservation expiry and payment reconciliation. Middleware allow-list read this session. |
| 41 | JOBS × DB | **UNTESTED** | `FOR UPDATE SKIP LOCKED` in the expiry RPC is correct by inspection; no concurrent probe. |
| 42 | JOBS × FIN | **PENDING (F)** | Reconciliation runs inside the sweep. Block F. |
| 43 | ADMIN × DB | **PENDING (I)** | I-01 (plaintext secrets) and RLS posture. Block I. |
| 44 | ADMIN × FIN | **PENDING (F, I)** | Who may read profit, and the >1000-row truncation. |
| 45 | DB × FIN | **PENDING (F)** | Row caps: 10k revenue scan, 20k profit, newest-2000 reconciliation. Block F. |

**Tally:** 6 PROVEN · 12 PARTIALLY PROVEN · 9 UNTESTED · 5 NOT APPLICABLE ·
13 PENDING.

---

## The collisions worth reading

### §J-01 — FUL × FIN: a carrier webhook replay rewrites finalised profit `PROVEN`

Both systems are individually defensible. Shippo's webhook is authenticated, and
`recordActualShippingCost` is a reasonable way to move real postage into profit.
They break together because the webhook had **no idempotency claim** while the
profit write is **not idempotent** — it re-sets `profit_finalized = true` and
inserts a fresh `order_shipping_cost_audit` row every time.

The worst ordering is not a plain replay. It is: buy label → void label
(`reverseRecordedShippingCost` clears the cost and un-finalises profit) → Shippo
redelivers the original `transaction_created` → **the cost of a refunded label is
back in the books, and profit is finalised on it.**

Evidence: `src/lib/shippo/transaction-created-dedupe.test.ts` (D-02), committed,
failing before the fix. Fixed by claiming the event key before the work.

### §J-02 — INV × ADMIN: an ordinary Save disarms the thing that prevents overselling `PROVEN`

The product editor is correct about what it edits. The inventory system is correct
about what it enforces. The collision is that they disagree about who owns five
columns: `DoseInput` has no field for `track_inventory`, `reserved_quantity`,
`incoming_quantity`, `low_stock_threshold` or `shipping_weight_oz`, so the old
delete-and-reinsert could only ever reset them.

One Save — no warning, no audit trail: oversell protection off, live checkout
holds discarded while their `inventory_reservations` rows stay `'active'`.

Evidence: `src/lib/dose-replacement-preserves-inventory.test.ts` (D-04). **D-07**
is the live instance — Bac Water, the one unprotected sellable unit out of 49,
displaying 39 units that nothing enforces (owner's production query, 2026-08-26).

### §J-03 — FUL × INV × ADMIN: the replacement order nobody's rules apply to `PARTIALLY PROVEN`

A three-way collision, and the clearest example of the brief's thesis in the repo.

`admin-replacements.createReplacementOrder` writes an `orders` row with
`payment_status = 'paid'` and `amount_paid = 0`. Each system behaves correctly
given its own assumptions, and the assumptions are incompatible:

1. **PAY** assumes `processPaymentWebhook` is the only writer of `'paid'` for card
   and express orders. The map states this; replacements refute it.
2. **INV** — the replacement calls `decrementInventoryForOrder` directly: **no
   reservation, no idempotency claim** (`admin-replacements.ts:241`, read this
   session). Its only dedupe is a deterministic primary key
   `order-rp-<sha256(originalOrderId::requestId)>` — and `requestId` is
   **optional** (`admin-replacements.ts:82,106`). Without it the id is random, so
   the PK dedupe does not exist and a double-submit decrements stock twice.
3. **FUL** — `sweepUnsyncedOrders` filters `.eq("payment_status","paid")
   .neq("order_type","membership") .is("shippo_order_id", null)`, read directly
   this session at `order-sync.ts:801-803`. It excludes memberships and **does not
   exclude replacements**, so a replacement is picked up unattended and pushed to
   Shippo — contradicting `admin-replacements.ts`'s own closing comment.

Why only PARTIALLY PROVEN: every link is verified in source, but the end-to-end
sequence (create a replacement with no `requestId` → double-submit → sweep →
Shippo) has not been executed. It needs no browser and no network, and it is the
highest-value test left in this block.

### §J-04 — PAY × DB × FIN: one unrelated schema drift disables the duplicate-charge guard and blanks the tax audit trail `PROVEN`

**The most under-rated collision in the matrix.** I checked this one against the
source line by line because the map's one-line version undersells it.

`insertOrderRow` (`quote-order.ts:1028`) inserts `draft.full`. If that fails and
looks like a missing column, it retries with `draft.base`. Defensible in
isolation: losing a real sale to an unapplied migration would be worse than
degrading.

But `base` is not "full minus the one offending column". It is a **fixed,
pre-migration column set**, and the retry is unconditional once triggered. Read
at `quote-order.ts:992-1016`, everything in the `full` overlay is dropped:

| Dropped on fallback | What it was for |
|---|---|
| `idempotency_key` | **the duplicate-charge guard** |
| `tax_rate_percent`, `tax_state` | the sales-tax audit trail |
| `shipping_protection_fee` | recorded so an order can reproduce its own total |
| `state`, `phone` | destination and contact |
| `billing_full_name`, `billing_address`, `billing_city`, `billing_postal_code` | billing address |

Three consequences, none of which surfaces as an error:

1. **PAY × DB.** The duplicate-charge guard is `idempotency_key`. When the
   fallback fires, the order is written **without it**, so the `23505` duplicate
   check on the retry cannot fire on that key. The one guard against writing the
   same order twice is removed by a schema problem in an unrelated column.
2. **PAY × FIN.** `admin-tax-report.getSalesTaxReport` selects `tax_state` and
   `tax_rate_percent` (`admin-tax-report.ts:62`), and its own header says it
   "never re-derives rates". Those orders are silently wrong in the one report
   with a legal consequence.
3. The trigger is broad: `insertError.code === "PGRST204"` **alone** is enough,
   whatever column caused it. A drift in `checkout_channel` blanks the tax trail
   and the idempotency key.

**Proof:** `src/lib/order-insert-fallback-collision.test.ts`, committed. It drives
the real `insertOrderRow` with a first insert returning `PGRST204` about
`checkout_channel` and captures the retry payload. Three passing tests establish
the ordinary case, the retry, and that columns unrelated to the failure are
dropped. Two further tests state the invariants that *should* hold —
`idempotency_key` and the tax trail surviving the degrade — and are marked
`it.fails`, so the suite stays green while recording the defect. When
`quote-order.ts` is fixed they start passing and vitest reports "expected test to
fail but it passed", forcing them to be converted into ordinary assertions.

**The repair (owner-directed, 2026-08-26).** `quote-order.ts` is a Rule 3 shared
file; edited at the owner's explicit instruction, on the principle that no error
path should silently remove an order-integrity field.

`insertOrderRow` no longer degrades to a fixed legacy row. It removes **only the
column the database actually named** and retries, so a deployment several
migrations behind peels off exactly what is missing and keeps everything else.
Dropping an integrity column (`idempotency_key`, `tax_state`, `tax_rate_percent`)
is still permitted — refusing every checkout would be worse — but it raises a
`critical` system alert, so it can never be silent. The peel stops when the named
column is not one the row carries, which also means a non-missing-column error is
never retried into a thinner, wronger order.

RED → GREEN → negative controls, all committed in
`src/lib/order-insert-fallback-collision.test.ts` (12 tests):

| Mutation | Expected | Observed |
|---|---|---|
| Restore the fixed-legacy-row fallback (the original bug) | the degrade + guard tests fail | **5 failed**, 7 passed |
| Suppress the alert on integrity-column loss | only the silence test fails | **1 failed**, 11 passed |
| Remove the `column in row` stop condition | only the over-reach test fails | **1 failed**, 11 passed |
| Restored | all pass | **12 passed** |

Both error shapes are simulated: PostgREST's `PGRST204 Could not find the 'x'
column of 'orders' in the schema cache`, and Postgres's own `42703 column "x" of
relation "orders" does not exist`.

**Status: FIXED (repo), and UNFIRED in production.** Five Aug 2–3 orders were put forward as
J-04 having fired. They are real and one is PAID with no `idempotency_key`, but
they are **not** this mechanism — see §J-07 for the three checks that refute it,
the decisive one being that `buildOrderRow` did not exist until three weeks after
those orders were written. Every order under the current code (Aug 7 onward)
carries `idempotency_key` and the full overlay.

So J-04 is a **proven mechanism that has not been observed to fire**, and it is
recorded at that grade deliberately. It is still worth fixing before launch on its
own merits, and the argument does not need the production claim: `PGRST204` is a
stale-PostgREST-schema-cache error, which is exactly what happens in the minutes
after a migration is applied — an ordinary event for this team — and the blast
radius of one occurrence is an order taken with its duplicate-charge guard
silently removed. The fix is small: retry without *the offending column* rather
than falling back to a fixed legacy row, or at minimum never drop
`idempotency_key`.

**CROSS-BLOCK (F, and whoever owns `quote-order.ts`):** the fix shape is to retry
without *the offending column* rather than falling back to a fixed legacy row —
or at minimum never to drop `idempotency_key`, which is a guard, not a
convenience.

### §J-05 — JOBS × ADMIN: maintenance mode silently stops thirteen background jobs `PARTIALLY PROVEN`

`middleware.pathBypassesMaintenance` allows `/maintenance`, `/.well-known/*`,
`/vault`, `/admin`, `/api/admin`, `/api/webhooks`, `/api/analytics/track` and
static assets. Everything else without an admin cookie gets a 503.

`/api/cron/sweep` is **not** on that list. Turning on maintenance mode therefore
turns off all thirteen background jobs, including **reservation expiry** (so
abandoned carts hold stock indefinitely) and **payment reconciliation**. Also
503'd: `/api/unsubscribe` (a compliance obligation), the COA document routes, and
`/api/health`.

The admin turning on maintenance mode has no way to know any of this. Both halves
are read in source; the 503 itself has not been observed, which needs a live
request and is therefore Block G/H or I territory.

### §J-06 — INV × DISC: is the free Buy-3-Get-1 unit reserved? `UNTESTED`

Recorded because it is cheap to answer and expensive to get wrong. B3G1 adds a
fourth physical unit that ships. If the discount is applied to the price without a
corresponding reservation, that unit is not held against stock — an oversell path
that looks like a pricing feature. **Not investigated**; flagged for whoever
reaches it first.

---

## §J-07 — Five orders written without the guard columns, including one PAID. Real, but **not** J-04 firing.
**Grade:** `DATABASE-PROVEN` (the data) · `REFUTED` (the attribution to J-04) · **Severity:** P2 historical data-integrity

Reported by the owner and verified read-only against production this session.

### The data — confirmed, and worse than reported

| Order | Created (UTC) | Status | Lane | Overlay |
|---|---|---|---|---|
| `VL-E8F4D52F` | Aug 2 03:10 | paid | express | **present** |
| `VL-55EFC617` | Aug 2 05:40 | canceled | card | missing |
| `VL-02506E34` | Aug 2 05:47 | canceled | card | missing |
| `VL-08EC72DC` | Aug 3 01:40 | canceled | card | missing |
| *(NULL order_number)* | Aug 3 03:13 | canceled | card | missing |
| **`VL-49CA32C1`** | **Aug 3 10:26** | **paid** | card | **missing** |
| `VL-8847B157` | Aug 3 10:40 | paid | express | **present** |
| `VL-64F8EDE4` | Aug 3 19:39 | pending | card | **present** |

It is not only the three columns reported. On all five, the **entire `full`
overlay is absent together** — `idempotency_key`, `tax_state`, `billing_address`,
**`state`**, **`phone`** all NULL, `tax_rate_percent` 0.000 and
`shipping_protection_fee` 0.00 — while every `base` column is populated. A card
order with no shipping state and no phone is not a normal write.

**A PAID order exists with no duplicate-charge guard: `VL-49CA32C1`.** That is
true and is stated plainly.

### The owner's read was right: it is not a migration boundary. It is not J-04 either.

Three independent checks, each of which alone refutes the attribution:

1. **The split is by LANE, not by time.** `VL-49CA32C1` (card, missing) is
   10:26 on Aug 3; `VL-8847B157` (express, present) is **14 minutes later**.
   Express is correct on both Aug 2 and Aug 3, spanning the whole window, while
   card fails throughout it. No schema change and no deploy can be lane-specific
   in that way.
2. **J-04's mechanism predicts the opposite lane.** The express lane sends a
   strict **superset** of the card lane's columns — it adds
   `extraColumns: { checkout_channel }` (`express/authorize/route.ts:295`), which
   card does not send at all. A missing-column / stale-schema-cache error would
   therefore hit **express first and hardest**. Express is the lane that worked.
3. **The code did not exist yet.** `buildOrderRow` and its `orderRowWithContact`
   overlay first appear in `04136e4`, **2026-08-23** — and this repository's
   entire git history begins that same day. These orders are from Aug 2–3, three
   weeks earlier. Whatever wrote them is not in the repository, so it cannot have
   been the fallback in `quote-order.ts:1028`.

One row having a **NULL `order_number`** is the tell that closes it:
`buildOrderRow` always sets `order_number`, and `order_number` is in the **`base`**
set — so even a fallback insert would carry it. That row cannot have come through
`insertOrderRow` at any point in its history.

### What it most likely was, stated as the inference it is

`INFERRED`, not proven, and unprovable from this repository: a pre-history version
of the card lane that did not populate those columns, or an older tolerant-insert
of its own. The *class* of defect — a forgiving write silently dropping a guard —
is corroborated. The specific J-04 code path is not.

### Live risk: none from these rows

- Every order from **Aug 7 onward (7 orders, all lanes)** carries
  `idempotency_key` and `state`. The current code populates them correctly and
  the J-04 fallback has not fired in any observable order.
- `admin-tax-report` filters `.gt("tax_amount", 0)` (`admin-tax-report.ts:63`).
  All five affected rows have `tax_amount = 0.00`, so they are **excluded from the
  sales-tax report** — there is no tax misstatement from them.
- `VL-49CA32C1`'s missing `idempotency_key` is historical. It cannot retroactively
  cause a double charge.

**Remediation:** none urgent. The five rows are missing customer state, phone and
billing address, which matters only if any needs to be re-shipped or re-invoiced;
four are `canceled`. The NULL `order_number` row is worth deleting or labelling so
it stops appearing in order counts.

---

## §J-08 — The NULL `order_number` row: exact impact, and why the safest cleanup is to leave it

**Grade:** `DATABASE-PROVEN` · **Severity:** P4 cosmetic · **Recommendation: no production write.**

The row is `order-64d083fa-f17a-4793-a960-427ec58263c0`, Aug 3 03:13 UTC.

### What it actually contains

`payment_status = canceled`, `fulfillment_status = cancelled`, `amount_paid 0.00`,
`tax_amount 0.00`, `customer_email` NULL, `customer_user_id` NULL, no
`referral_code`, no `ambassador_id`, no `attributed_campaign_id`, no
`shippo_order_id`. **Zero `order_items`, zero `commissions`, zero
`inventory_reservations`.** It is an empty shell from an abandoned checkout.

### Every surface that reads it — traced, not assumed

| Surface | Effect | Why |
|---|---|---|
| `admin-profit` | **excluded** | filters to paid / partially_refunded (`admin-profit.ts:270`) |
| `admin-revenue` | **excluded** | canceled is not counted as revenue |
| `admin-tax-report` | **excluded** | `.gt("tax_amount", 0)` and this row is 0.00 |
| `admin-reconciliation` | **no flags** | `expectedTotal` 0 vs `amountPaid` 0 → no mismatch; refund 0; not `paid`; not `pending_payment` |
| Admin order search | **never matches** | `order_number.ilike` cannot match NULL — it is simply invisible to search |
| Admin order list | **blank reference** | renders `order.order_number ?? null` |
| Fulfillment workstation | **falls back to order_id** | `String(row.order_number ?? "") \|\| String(row.order_id)` (`admin-orders.ts:274`) |
| Customer account | **invisible** | `customer_user_id` is NULL, so it belongs to nobody |
| Shippo matching | **N/A** | no `shippo_order_id`, and it is cancelled |

The codebase already types the column `order_number: string | null` and handles
the null defensively at every read. **Nothing is broken by this row.**

### Recommendation, in order of preference

1. **Leave it (recommended).** Impact is one blank cell in an admin list, on a
   cancelled £0 order. Every production write carries risk; this one buys
   tidiness. The cost exceeds the benefit.
2. **Backfill, if the blank genuinely bothers the owner.** A single-row,
   reversible `UPDATE` to a value that is obviously not a real order number and
   is derived from the id it already has:
   `update orders set order_number = 'VL-LEGACY-64D083FA' where order_id = 'order-64d083fa-f17a-4793-a960-427ec58263c0' and order_number is null;`
   The `and order_number is null` clause makes it idempotent and impossible to
   overwrite a real number. **Not run — Rule 4 requires the owner for any
   production write.**
3. **Delete it — do not.** It is the only remaining record that this checkout
   attempt happened, deletion is irreversible, and it costs nothing to keep.

### The underlying gap, and why the obvious fix needs care

`orders.order_number` is **nullable** (confirmed via `information_schema`). Every
current insert path sets it — it is in `insertOrderRow`'s base set and in both
membership paths — so under current code the column is always written.

Adding `NOT NULL` would prevent recurrence, but it **cannot be applied while this
row exists**, so it would require option 2 first. That is a production DDL and is
**not proposed for launch**: the constraint guards against a code path that no
longer exists, and the migration has a real failure mode (it takes an
`ACCESS EXCLUSIVE` lock on `orders`). Recorded as hygiene for a quiet moment, not
as launch work.

### One correction to the reported evidence

`tax_rate_percent` is **`NOT NULL DEFAULT 0`** in the live schema. So `0.000` is
what the column holds whether the value was written explicitly as 0 (a non-taxed
order) *or* omitted entirely. It was never evidence of a dropped column in either
direction, and should not be used as a signal for this class of defect.
`shipping_protection_fee` is the same shape (`NOT NULL DEFAULT 0`). The columns
that genuinely discriminate are the **nullable** ones: `state`, `phone`,
`tax_state`, `billing_address`, `idempotency_key`.

---

## §J-09 — The same fallback defect is still live in the replacement path `SOURCE-INSPECTED`
**Severity:** P1 · **Status:** OPEN — recorded with a fix, deliberately not applied

Found while confirming that every insert path sets `order_number`.
`admin-replacements.createReplacementOrder` (`admin-replacements.ts:195-212`) has
its own three-step version of exactly what J-04 just fixed:

```
1. fullOrderRow
2. retryRow      — drops replacement_of, replacement_reason, shipping_address_2
3. baseOrderRow  — drops state and phone as well
```

Step 2 is careful and correct. **Step 3 contradicts step 2's own comment**, which
reads:

> `baseOrderRow` has no state and no phone, and carriers reject a US shipment
> without a state. Retry with them re-attached rather than falling all the way
> back to a row that cannot ship.

The code states that `baseOrderRow` cannot ship — and then falls back to it anyway
as step 3.

What step 3 produces is worse than an unshippable order. It also drops
**`replacement_of`**, the only link between the replacement and the order it
replaces. The result is a row with `payment_status = 'paid'`, `amount_paid = 0`,
`order_type = 'replacement'`, no destination state, and no record of what it is a
replacement for. And per **§J-03**, `sweepUnsyncedOrders` does not exclude
replacements, so it is then pushed to Shippo unattended.

**Proposed fix** (same shape as J-04's, and small): peel the column the error
names rather than stepping down to a fixed row; treat `replacement_of`, `state`
and `phone` as integrity columns; alert loudly rather than degrading silently. If
the row genuinely cannot be written with a destination state, **failing is
correct** — `createReplacementOrder` already throws, and a replacement that cannot
ship should surface to the admin who asked for it, not be created blind.

**Not applied.** The owner directed one specific repair (J-04) and asked me not to
over-focus on this issue. This is the same defect class in a different money path
and is a small, well-understood change, but it is a separate decision and is
recorded for the owner to make. `admin-replacements.ts` had no mapper in Phase 1
and is not claimed by any block.

---

## What Block J could not do

- **Only one collision was proven by a test written *as* a collision test** —
  §J-04, which is also the only one this block fixed. The other five PROVEN
  verdicts come from single-subsystem tests that happen to prove a cross-system
  consequence (D-01, D-02, D-04, D-05) or from another block's committed
  evidence. §J-03 most deserves a real end-to-end test and did not get one.
- **§J-09 is recorded but not fixed** — the same fallback defect as J-04, live in
  the replacement path. It is a separate decision for the owner.
- **13 of 45 pairs are PENDING** on blocks I, K, E and F. Blocks I and K have
  already published substantial findings (`BLOCK-I.md`, `BLOCK-K.md`), cited above
  but deliberately **not** used to grade a pair, since those blocks are not
  declared final.
- **No browser, no network, no database of my own.** D-07's production evidence is
  the owner's, attributed as such.

## ⚠️ Block A+B has no findings file

The matrix was built expecting one. **No `BLOCK-AB.md` exists on any branch** —
every remote branch was scanned. The only block findings files anywhere are
`BLOCK-C.md`, `BLOCK-D.md`, `BLOCK-I.md` and `BLOCK-K.md`, and no commit on any
branch carries an A or B block message.

A+B-relevant evidence *does* exist, but in the ledger rather than a block file:
`FINAL-CERTIFICATION-AUDIT.md` (F-009, F-002) and commit `b19db0c` on `main`
("Make partner creation atomic, converge the two tables, and stop under-reporting
what is owed"), which is Block B's affiliate-money work landed before the parallel
protocol began.

So rows 1, 6 and 8 are graded on the **ledger's** evidence, not on a Block A+B
file. **This is worth the owner's attention**: the matrix would otherwise read as
though A+B were covered, and Block A's concurrency findings are exactly what rows
11, 12, 14, 38 and 41 are waiting on. If a session is still working A+B, those
rows should be re-graded when it lands.


---

## Block J verification

| Check | Result |
|---|---|
| `npx vitest run` | **207 files, 3602 tests, 0 failures** (1 file / 7 tests skipped, pre-existing) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 38 warnings — **one fewer than before this block**; none in files it touched |
| `npm run build` | succeeds |
| Production access | **read-only**, via Supabase MCP, per Rule 4. No production write was made or proposed for execution. |

**Files changed by Block J**

- `src/lib/quote-order.ts` — the J-04 repair (Rule 3 shared file, owner-directed)
- `src/lib/order-insert-fallback-collision.test.ts` — 12 tests, RED → GREEN → 3 mutations
- `docs/findings/BLOCK-J.md` — this file

**CROSS-BLOCK (F, and any block touching `quote-order.ts`):** `insertOrderRow` was
rewritten. It no longer uses `draft.base`, which `buildOrderRow` still computes and
which is retained on `OrderRowDraft` for compatibility. A consolidating session may
want to remove it once no branch depends on it.
