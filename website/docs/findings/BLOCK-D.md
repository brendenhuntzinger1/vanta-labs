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

---

### D-05 — A membership upgrade moves the perks but not the price; Veyra keeps charging the old tier forever
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P0 · **Status:** FIXED (repo)

**Reproduction.** `src/lib/membership-tier-change-repricing.test.ts`. An active
member on a $29 tier is upgraded to a $99 tier. Before the fix no call reached
Veyra at all, the local row moved to the new tier, and a `tier_change` event was
written as `succeeded`.

**Root cause.** `membership-billing.ts:526` (`startMembershipSignup`) handles an
upgrade/downgrade by updating `tier_id` and `next_billing_amount_cents` in
`customer_memberships`, recording the event, reconciling store credit, and
returning. Veyra owns the subscription and the amount it charges. So:

- an **upgrade undercharges forever** — the member gets the $99 perks at $29
- a **downgrade overcharges forever** — the member keeps paying $99
- every subsequent `membership.renewed` webhook carries the stale amount

`veyra-membership.ts`'s own comment records the endpoint list, verified
2026-08-03: *cancel / skip_cycle / change / card / retention*. The `change`
endpoint existed the whole time and simply had no wrapper.

This is the identical failure shape that file's header calls out in red for
pause, cancel and card updates — "local-only state for a subscription somebody
else owns". Those three were found and fixed. The tier change was missed.

**Fix.** New wrapper `changeVeyraMembershipPlan` (`veyra-membership.ts`) posting
to `/{id}/change` with `amount_cents` and `interval`, following the same
conventions as `startVeyraMembership`. The tier-change branch calls it **first**
and only writes the local row if it succeeds; on refusal the member is left
exactly where they were, the attempt is recorded as `status: "failed"`, and the
caller gets `success: false`. Granting new-tier perks while the old price is
still what gets charged is precisely the bug, so a partial application is refused
rather than half-applied.

A member with **no `veyra_membership_id`** (charged once, nothing at the
processor — the state the ledger already documents as sold to a real account) has
no ongoing subscription billing them, so the local change stands on its own and
no processor call is made. Covered by its own test.

**Tests.** 4 tests, 3 confirmed failing before the fix.

**Residual risk (`NOT VERIFIED`):** the exact request/response shape of Veyra's
`change` endpoint is taken from the conventions of `startVeyraMembership` and the
sibling lifecycle wrappers. It is **not** verified against the live processor —
this block used no network. Consolidation should treat the payload shape as
`SOURCE-INSPECTED` and confirm it before release.

---

### D-06 — `startMembershipSignup` is globally mocked out, so nothing in the repo can test it
**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** OPEN (recorded, not fixed)

`vitest.setup.ts:119` replaces the whole `@/lib/membership-billing` module with
two stubs (`activateAnnualMembership`, `createAnnualMembershipManualOrder`).
Every other export — `startMembershipSignup` among them — is simply absent from
the mock, so any test that imports it gets:

```
Error: [vitest] No "startMembershipSignup" export is defined on the
"@/lib/membership-billing" mock.
```

`startMembershipSignup` is the function that takes membership money. It had
**zero behavioural coverage**, and D-05 sat inside it undetected. The only
mention anywhere in the suite is a comment in `membership-lifecycle.test.ts:147`
describing behaviour no test exercises.

D-05's test works around this with a local `vi.unmock`. That is a patch, not the
fix: the global stub still hides the rest of the module from every other test.

**CROSS-BLOCK (E, and whoever owns `vitest.setup.ts`):** the global mock should be
narrowed to the two functions that need stubbing, or replaced with per-test mocks.
`vitest.setup.ts` is shared by every block, so per Rule 3 this session did not
edit it. Worth auditing the other 20+ global `vi.mock` calls in that file for the
same effect — a module-wide stub silently removes everything it does not re-export.

---

## Block D verification

Run at the end of the block, on the merged result of all five findings:

| Check | Result |
|---|---|
| `npx vitest run` | **206 files, 3590 tests, 0 failures** (1 file, 7 tests skipped — pre-existing) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 38 warnings (all pre-existing; the one this block introduced was fixed) |
| `npm run build` | succeeds |
| Browser | **NOT RUN** — Block D is a no-network block per the assignments table |

18 new tests across 4 files; **15 were confirmed to fail before their fix** and
were checked to fail *for the right reason*. The 3 that did not were kept as
controls on behaviour the fix must not change.

Two tests were caught being unable to fail and corrected before use: one asserting
on `r.status` where the column is `to_status`, and one whose failure injection
stopped applying once the code path changed.

### What this block does NOT claim

- No finding here is graded above `BEHAVIORAL-TEST-PROVEN`. Nothing was observed
  against production, a preview, a browser or the live database.
- The Veyra `change` payload shape (D-05) is inferred from sibling wrappers, not
  verified against the processor.
- The `replace_doses` editor payload (D-04) still has **no caller in `src/`**, so
  the shape the admin UI actually sends remains unverified; the fix is written to
  be safe under either shape.
- The dose merge (D-04) is ordered so no interleaving leaves a product unsellable,
  but it is still multiple statements rather than one transaction.

---

### D-07 — Bac Water is the one sellable unit in the catalogue with no oversell protection
**Grade:** `DATABASE-PROVEN` · **Severity:** P1 · **Status:** OPEN — needs an owner decision, not a code fix

**Evidence provenance:** queried against production by the owner, 2026-08-26, and
recorded here. This session ran no network and did not observe it directly.

Bacteriostatic Water (`bacteriostatic-water`, 10mL, the **default** dose) has
`track_inventory = false` on **both the dose and the parent row**, displays
"In Stock" with 39 units, and was last updated 2026-08-25.

It is the **only unprotected sellable unit out of 49**. Everything else in the
catalogue is tracked. So the storefront shows a stock number that nothing
enforces, on what is very likely the highest-volume line in the catalogue —
nearly every peptide order includes bac water.

Concretely: `reserve_inventory` holds nothing for this dose, so concurrent
checkouts cannot be prevented from overselling it, and the 39 on display will not
decrement the way a customer or the owner would reasonably expect.

**Whether this is a defect is the owner's call, and is deliberately not decided
here.** Some shops treat bac water as effectively unlimited and turn tracking off
on purpose. If that is the intent, the honest fix is to stop displaying a
specific number for it rather than to switch tracking back on. If it is not the
intent, one `UPDATE` restores protection.

**Why it belongs in Block D.** It is a live demonstration of D-04's blast radius.
Whatever set this flag — a deliberate choice or an ordinary product Save under the
old `replaceProductDoses` — the point stands that before D-04's fix, *any* Save on
*any* product silently disarmed that product's protection the same way, with no
audit trail and nothing in the UI to show it had happened. D-04 closes the
mechanism. D-07 is the one row currently in that state.

**Not verified:** which of the two caused it. `product_doses` carries no column
recording who last wrote `track_inventory`, and `admin_audit_logs` was not queried
for this session. Consolidation could settle it by checking whether the
2026-08-25 update coincides with a `replace_doses` call.

---

### CROSS-BLOCK (I) — `src/lib/admin-products.ts` is edited by both blocks

**Files:** `website/src/lib/admin-products.ts`
**Other branch:** `claude/block-ab-audit-6fogsm` (Block I — admin + security)

| Branch | Lines changed | Region |
|---|---|---|
| Block D (this branch) | 104 | `createDoseRows` (~l.343) and `replaceProductDoses` (~l.991) |
| Block I | 23 | `uploadProductImageToStorage` (~l.1061) — image type sniffing and a size cap |

`git merge-tree` reports the file as "changed in both", which is true at file
level. **The hunks do not overlap.** A real three-way merge of the two branches
was run and returns **exit 0 with zero conflict markers**:

```
git merge-tree --write-tree HEAD origin/claude/block-ab-audit-6fogsm
→ 730771f65f9a4b8c9fffa09af6b65aaa8c327a6b   (exit 0, 0 conflicts)
```

So this is a mechanical merge, not a semantic collision: the two changes touch
different functions with no shared state, and **both should survive**. Under Rule
3 the earlier-lettered block wins a genuine conflict, but no arbitration is
actually needed here.

**What consolidation should still do:** re-run the merge at final HEAD rather than
trusting this result — either branch may move — and confirm both changes are
present afterwards, since a clean auto-merge is exactly the case where a silently
dropped hunk would go unnoticed. The two anchors to check for are
`editableDoseValues` (Block D) and `sniffImageType` (Block I).
