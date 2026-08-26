# Block D — Fulfillment, inventory and discounts

**Session branch:** `claude/block-ab-audit-8xz6fb`

> Branch-name caveat for consolidation: this session's branch was pinned by the
> harness before the block was reassigned, so its name says `block-ab` while its
> contents are **Block D**. No Block A or B work is in it.

Base: `origin/claude/audit-superpowers-playwright-extension-c2oyhm`, merged in at
session start per Rule 1.

Grades use the ledger's scale. Nothing here is graded above its evidence: no
network was used, so the ceiling for this block is `BEHAVIORAL-TEST-PROVEN`.

---

### D-01 — Every shipping status write is a lost-update race; the pipeline's no-regression rule is unenforceable
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** FIXED (repo)

**Reproduction.** `src/lib/shippo/tracking-write-race.test.ts`. A TRANSIT scan is
held between its read of `fulfillment_status` and its write while a DELIVERED
scan runs to completion, then released. Before the fix the order ends at
`in_transit` with `delivered_at` already set:

```
AssertionError: expected 'in_transit' to be 'delivered'
```

This is a genuine interleaving, not two sequential calls. The two scans carry
different `event_key`s (`<transaction>:<status>:<status_date>`), so both clear the
idempotency claim and are free to run concurrently — the dedupe cannot prevent
this.

**Root cause.** `order-pipeline.ts` is a pure function and is correct: it refuses
a move whose `progressRank` is lower than the current status, and refuses any
move out of a terminal one. But it can only judge the snapshot it is handed, and
the write that followed was unguarded:

```ts
.update({ fulfillment_status: transition.next }).eq("order_id", order.order_id)
```

Last writer wins. Five call sites shared the pattern:
`service.applyTrackingUpdate`, `service.purchaseLabelForOrder`,
`service.voidLabelForOrder`, `service.setOrderFulfillmentStatus`, and
`order-sync.applyTransactionCreated`. The state machine's central guarantee was
decorative in all five.

**Fix.** Compare-and-swap. New helper `updateOrderGuardedByStatus`
(`src/lib/shippo/service.ts`) applies the write only while `fulfillment_status`
still holds the value the decision was made against, and reads back the affected
rows to learn whether it won.

The money paths are deliberately split rather than simply refused:

- **Tracking** — a lost race writes nothing, records no history row, sends no
  email, and releases the event claim so Shippo's retry re-decides against the
  current status (where the pipeline correctly rejects it as a regression).
- **Label purchase / void** — postage is already spent, so the *label facts*
  (cost, tracking, carrier, `label_voided_at`) are written either way; only the
  *status* is guarded. Losing a status is survivable; losing a paid label is not.
  `statusApplied` gates the history row and the returned `fulfillmentStatus` so
  neither claims a transition that did not happen.
- **Admin set-status** — refused outright with a new `status_conflict` code
  (HTTP 409), because silently undoing whatever landed first is worse than making
  the operator re-read.

**Tests.** `tracking-write-race.test.ts` (2 tests, both confirmed failing before
the fix). Negative control: the second test originally asserted on `r.status`,
which is not a column — it could not fail. Corrected to `to_status`, at which
point it failed for the right reason.

**Collateral.** Five existing test doubles modelled `update().eq()` as terminal
and unconditional, so they could not express a compare-and-swap at all — they
would pass whether or not the guard existed. Replaced with one faithful double,
`src/lib/shippo/test-support/orders-table-double.ts`, which holds the predicates,
applies the write only while they match, and returns the rows it touched.

**Verification.** `npx vitest run src/lib/shippo` — 18 files, 288 tests, all pass.
`npx tsc --noEmit` clean.

---

### D-02 — `transaction_created` re-runs in full on every redelivery; a voided label's cost is resurrected
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** FIXED (repo)

**Reproduction.** `src/lib/shippo/transaction-created-dedupe.test.ts` drives the
real `POST /api/webhooks/shippo` twice with an identical body. Before the fix
`applyTransactionCreated` ran both times.

**Root cause.** `src/app/api/webhooks/shippo/route.ts` called the handler FIRST
and only afterwards upserted `shippo_webhook_events` — and nothing ever read that
row back. The tracking path has always claimed its key before doing any work;
this path did the opposite. Shippo retries on any non-2xx, so each redelivery:

- moved `label_purchased_at` to `now()`
- re-ran `recordActualShippingCost`, re-setting `profit_finalized = true` and
  inserting another `order_shipping_cost_audit` row
- **resurrected the cost of a label that had since been voided** — `voidLabelForOrder`
  clears `postage_cost_cents` and reverses the recorded cost, and a replayed
  `transaction_created` put it all back and re-finalised profit on a refunded label

**Fix.** Claim the key before the work, matching the tracking path: `INSERT` the
`event_key`, treat `23505` as a duplicate and return `200 {duplicate: true}`, run
the handler, then upsert the outcome. On a thrown handler the claim is released
(`DELETE ... WHERE processed_at IS NULL`) so a genuine retry still re-runs.

An event with no `object_id` is deliberately **not** deduped — collapsing every
unidentifiable event onto one `transaction_created:unknown` key would silently
drop genuinely different labels.

**Tests.** 4 tests: dedupe, duplicate reported, a different transaction still
processes, and a thrown handler releases the claim. The first two were confirmed
failing before the fix.

---

### D-03 — A test named "dedupes a repeated purchase event" asserted only a source-code substring
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** FIXED (repo)

`src/lib/handoff-invariants.test.ts:553` asserted that the route source *contained*
the string `event_key: \`transaction_created:${...}\`` and `onConflict: "event_key"`.
Both were true for the entire period in which D-02 was live: the route did mention
an event key, it simply used it after the fact. The test's name claimed the
protection existed; it passed throughout.

This is the exact failure mode Block E is chartered to find, met head-on in Block
D's own files. Replaced with an assertion on the thing that actually matters — the
claim statement appearing *before* the handler call — and the behavioural proof
now lives in `transaction-created-dedupe.test.ts`, which drives the real handler.

**CROSS-BLOCK (E):** worth a sweep for sibling assertions in
`handoff-invariants.test.ts`; several remaining `it()` blocks in that file assert
`toContain` against source text and share this weakness.

---

### CROSS-BLOCK notes

- **CROSS-BLOCK (I): `src/app/api/admin/orders/[orderId]/shipping/error-status.ts`**
  — one line added mapping the new `status_conflict` service code to HTTP 409.
  The map is typed `Record<ShippoServiceErrorCode, number>`, so omitting it fails
  the build for every block. Type-forced companion edit only; no change to admin
  auth, capability gates or IDOR surface, which is what Block I actually owns.

---

### D-04 — Saving a product edit switches off its oversell protection and discards live reservations
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** FIXED (repo)

**Reproduction.** `src/lib/dose-replacement-preserves-inventory.test.ts`. Seed one
dose with `track_inventory=true, reserved_quantity=2, incoming_quantity=25,
low_stock_threshold=20, shipping_weight_oz=3`, then call `replaceProductDoses`
with the payload the editor round-trips (the same dose, same id). Before the fix
all five columns came back at their schema defaults; 5 of 8 assertions failed.

**Root cause.** `admin-products.ts` issued `DELETE FROM product_doses WHERE
product_id = ?` and then re-inserted from the payload. `DoseInput` has **no field
for any of those five columns** — they are server-side operational state owned by
checkout, the reservation sweeper and the receiving flow — so an editor payload
could only ever reset them. One ordinary "Save" in the product editor therefore:

- flipped `track_inventory` to `false`, so `reserve_inventory` stops holding
  stock for that dose and it can be **oversold without limit**
- reset `reserved_quantity` to 0, discarding the holds on every checkout in
  flight while their `inventory_reservations` rows stayed `'active'`
- lost `shipping_weight_oz`, so the parcel is quoted at the fallback weight
- minted a **new uuid** when the payload omitted an id, orphaning every
  `order_items` `"slug::doseId"` and every reservation pointing at the old row

The delete was also not transactional with the insert: a failure in between left
the product with zero doses and the storefront falling back to the stale parent
row — which per ledger F-001 is `inventory_quantity = 0` for 86% of the catalog.

**Fix.** Merge instead of replace. Existing doses are `UPDATE`d in place with the
editable columns only (extracted into `editableDoseValues`, shared with the insert
path so the two cannot drift), keeping their ids and their operational state.
Genuinely new doses are inserted. The doses the admin actually removed are
deleted **last**, once the writes that keep the product sellable have succeeded —
so a part-way failure leaves the product over-supplied rather than empty.

A dose is matched by id, and failing that by `slug_suffix`: an id-less payload is
far more likely to be the same 5mg dose round-tripped than a brand new one. This
directly answers the open question in `PHASE1-SYSTEM-MAP.md:552` — the editor's
payload shape is still unverified because **no caller of `action: "replace_doses"`
exists in `src/`** (only the route handler at
`src/app/api/admin/products/[productId]/route.ts:92`), so the id-less case is now
handled safely rather than assumed away.

**Tests.** 8 tests, 5 confirmed failing before the fix. They cover each preserved
column, that the admin's actual edit still applies, id stability, slug matching
for an id-less payload, genuine dose removal, and that a failed write never
empties the product.

**Residual risk (`NOT VERIFIED`):** the merge is still several statements rather
than one transaction. It is now ordered so that no interleaving leaves the product
unsellable, but a true fix is an RPC. Recorded rather than claimed as solved.
