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
| 16 | PAY × DB | **PROVEN** | `insertOrderRow`'s PGRST204 fallback drops **`idempotency_key` — the duplicate-charge guard** — plus the tax audit trail and billing address, on a drift in any unrelated column. Verified line by line; see §J-04. |
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

Block J is analysis-only and `quote-order.ts` is a Rule 3 shared file, so this is
proven and left unfixed by design.

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

## What Block J could not do

- **Only one collision was proven by a test written *as* a collision test** —
  §J-04. The other five PROVEN verdicts come from single-subsystem tests that
  happen to prove a cross-system consequence (D-01, D-02, D-04, D-05) or from
  another block's committed evidence. §J-03 most deserves a real end-to-end test
  and did not get one.
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
