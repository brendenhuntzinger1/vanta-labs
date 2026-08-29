# Final launch audit — 2026-08-29

**Commit audited:** `e2c8f90` (= `origin/main` = the live production deployment)
**Standard:** evidence-graded. Nothing is called proven unless it was executed
and observed here. Where the harness cannot reach, that is said plainly rather
than inferred from source.

**Evidence tiers used below**

| Tag | Meaning |
|---|---|
| **BROWSER** | Driven in a real browser against the local harness (real Postgres, production schema) |
| **EXECUTED** | A command was run here and its output observed |
| **PROD-DATA** | Read-only query against the production Supabase project |
| **CODE** | Read from the tree; not executed |

---

## Verdict

**No launch-blocking defect was found in the code.** Every fault this audit
chased down was either already fixed and deployed, or turned out to be a
configuration/data decision rather than a bug.

One item is **yours to decide** — it is not a code fault:

1. **Sales tax has been switched off since 2026-08-23** — $0 collected on every
   order since, including both recent real orders. *Reviewed by the owner on
   2026-08-29 and deliberately deferred.*

Everything else is operational tidy-up.

> ### Correction — 2026-08-29, after first publication
>
> The first version of this document carried a second headline finding: *"15 of
> your 36 live products cannot be bought."* **That finding was wrong and is
> withdrawn.** So were the two claims that hung off it — that 17 products could
> oversell, and that stale express orders were holding stock.
>
> The catalogue is healthy: **36 of 36 live products are sellable, and 36 of 36
> are stock-gated.** The details, and how the error happened, are in
> [Withdrawn findings](#withdrawn-findings--corrected-2026-08-29).

---

## What was proven working

### The transaction that outranks everything — BROWSER

A complete purchase was driven end to end on the audited commit, at 390×844,
and checked against the database at every step:

    add to cart -> checkout -> order VL-BFC82BC8 written (pending_payment)
      -> order_items written (2 x CJC-1295 2mg)
      -> inventory HELD, not spent: qty 15, reserved 0 -> 2
      -> signed webhook -> payment_status = paid
      -> inventory 15 -> 13, reserved 2 -> 0, reservation 'active' -> 'finalized'
      -> inventory_committed_at set, paid_side_effects_at set
      -> order_confirmation queued in order_email_log
      -> /order-confirmation renders "Thank you for your order"

**Webhook replay is safe — BROWSER.** A second `payment.succeeded` with a
different event id, against the already-paid order, did **not** double-decrement
(stock stayed 13) and did not create a second order. The atomic paid-claim
holds.

**PII hygiene — BROWSER.** The confirmation page and `order_email_log` both mask
the customer address (`a************@example.com`).

### Stock gating is honest in BOTH directions — BROWSER

Verified on the two shapes that actually exist in this catalogue:

- **Genuinely empty** (no doses, parent at zero, tracking on): renders a
  **disabled "Out of Stock" button**, and `reserve_inventory` independently
  returns `false`. Display and checkout agree, so nobody is shown a purchasable
  product that fails at the till.
- **Parent-zero but dose-stocked** — the shape 15 live products actually have:
  renders **In Stock and purchasable**, and the hold lands on the dose rather
  than the parent. This is the runbook's F-001 and it passes. See
  [Withdrawn findings](#withdrawn-findings--corrected-2026-08-29) — reading only
  the first shape is what produced the retracted claim.

### Money math — PROD-DATA

All 8 paid production orders reconcile **to the cent**:

    subtotal - discount + tax + shipping + handling + protection + card fee == amount_paid

The extra a few pence over subtotal+shipping on some orders is
`shipping_protection_fee`, the opt-in add-on — not a hidden surcharge.
`card_processing_fee` is **0.00 on every production order**.

### Consent and disclosure — BROWSER

- **Shipping protection is genuinely opt-in** — unchecked by default.
- **Marketing consent is jurisdiction-aware**: pre-checked for a US address,
  **unchecked when the country is set to Canada**. That is the correct split
  (CAN-SPAM is opt-out; CASL requires express consent, which a pre-ticked box
  is not). Verified by toggling the country in the browser.
- **Age gate**: four separate attestations, both entry buttons disabled until
  all four are checked.

### Suites and static checks — EXECUTED

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **0 errors** |
| `npm run lint` | **0 errors**, 49 warnings (all unused vars in test files) |
| `npm test` | **5,508 passed**, 106 skipped |
| `npm test` **with real Postgres** (`VANTA_TEST_DATABASE_URL`) | **5,614 passed / 389 files, 0 skipped** |
| Re-run after this audit's fixes | **5,627 passed / 390 files, 0 skipped** |

The 106 normally-skipped tests are the ones that matter most — double payout,
exactly-once payout claim, refund correctness, inventory return path, invite
atomicity. They were run here against a real Postgres 16 and all pass.

### Already fixed and deployed — no action needed

Each of these appears in Sentry or Vercel history and is closed on the running
commit:

| Symptom | Status |
|---|---|
| `cron_sweep_failed` × 3 jobs + `expire_stale_reservations` (PGRST303 clock skew) | Fixed by `runJobWithAuthRetry`. **No recurrence in 24h.** |
| Reddit conversions rejected — `action_source: website` | Fixed to uppercase `WEBSITE`, with a regression test |
| `/api/catalog/bac-water` 404 killing the cross-sell | Resolver now accepts both published slugs |
| `Invalid Sentry Dsn` across 8 routes | Resolved; Sentry is receiving events |
| Express checkout referral-minimum error | **Not a 500** — caught and returned as a customer-safe message |

Inventory reservations in production are clean: every row is `released` or
`finalized`. Nothing is stuck holding stock.

---

## Decide before you scale traffic

### Sales tax is switched off — PROD-DATA

`admin_control` has `tax.nexus_states = ""` (empty), set **2026-08-23**. With no
nexus states configured, `computeSalesTax` returns `no_nexus` and collects
nothing, anywhere.

The order history shows the switchover exactly:

| Order | Date | Tax |
|---|---|---|
| VL-8847B157 | Aug 3 | $3.85 |
| VL-64F8EDE4 | Aug 3 | $6.03 |
| VL-EA5529EF | Aug 7 | $1.99 |
| VL-37C1E4B0 | Aug 25 | **$0.00** |
| VL-8D132452 | Aug 25 | **$0.00** |
| VL-C98B8AB1 | Aug 27 | **$0.00** |
| VL-3B91237B | Aug 28 | **$0.00** |

The engine is correct and well-tested — it is being told there is nowhere to
collect. Selling and shipping from your own premises normally creates nexus in
your home state from the first order, so this is very likely under-collection
that accrues as a liability against you, not the customer. If it was cleared
deliberately, ignore this; if it was cleared while testing and never restored,
it should go back before volume increases.

**Where:** Admin → tax settings → `nexus_states`.

---

## Withdrawn findings — corrected 2026-08-29

Three claims in the first version of this document were **wrong**. They shared a
single root cause, and correcting them removes the second of the two "decide
before you scale" items entirely.

### What was claimed, and what is actually true

| Claimed | Actual |
|---|---|
| 15 of 36 live products cannot be bought | **All 36 are buyable** |
| 17 products can oversell without limit | **All 36 are stock-gated**; none is ungated |
| 2 express orders are holding inventory | **No stale order holds any stock** |

### The root cause: the parent row is a stale shadow

This catalogue sells through **doses** (variants in `product_doses`), not through
the parent `products` row. For a dosed product, `products.inventory_quantity`
is not the stock — `src/lib/catalog.ts` says so in as many words, and
`mapProductRow` acts on it:

```ts
const backingAvailability = defaultDose
  ? defaultDose.availableQuantity ?? undefined
  : sellable(productLevelQuantity, reservedQuantity);
```

A dosed product's badge comes from its **default dose**, never from the zero
parent. All 15 products I flagged have an enabled default dose marked In Stock
carrying 15–29 units — with 144 units behind `glp-3`, 116 behind `glp-2`, 48
behind `bpc-157` and 38 behind `nad`. Roughly 530 units of real inventory that
I reported as unsellable.

The same mistake produced the oversell claim, which was wrong twice over:

- **The catalogue never reads per-product `track_inventory`.** `resolveStockStatus`
  gates on `inventoryActive` (`catalog.ts:37`), which is the single **global**
  admin setting (`inventory-settings.ts:47`). A parent flagged untracked is gated
  exactly as hard as one flagged tracked.
- **`reserve_inventory` gates the dose, not the parent.** With a variant supplied
  it locks `product_doses` on `(track_inventory = true or inventory_quantity > 0)`,
  and `inventory-enforce-positive-stock.sql:112-118` backfills
  `track_inventory = true` for every product *and* dose holding stock. A dose with
  real stock is tracked by construction.

Nothing is ungated.

### Two narrower things that ARE true — CODE

Correcting an overclaim must not swing into the opposite overclaim, so both of
these survive the retraction:

1. **`quoteOrder`'s secondary guard has a blind spot.** `getStockLevelsBySlugs`
   filters `track_inventory === true` for products (`catalog.ts:532`) and doses
   (`catalog.ts:549`), so any row enforced *solely* by holding a positive count is
   silently omitted from that map. This is a pre-checkout UX gap, **not** an
   oversell hole — `reserve_inventory` still returns false and refuses the sale.
2. **A legacy cart line with no `variantId` reads the parent's zero.**
   `sanitizeCartItems` rehydrates persisted localStorage lines verbatim and never
   re-resolves a missing variant (`cart-context.tsx:240`), and `/api/cart/validate`
   falls to its `bySlug` branch for such a line (`route.ts:194`), which reads
   `products.inventory_quantity` — zero for all 15 of these. That line is then
   marked sold out and dropped from the cart. Already logged as a P1 in
   `docs/PHASE1-SYSTEM-MAP.md:508`. Stated at **CODE** tier: the read paths were
   confirmed in the tree, but this was not reproduced in a browser.

### Proven, this time on the right shape — BROWSER

Reproduced against a harness product carrying production's exact shape (parent
`inventory_quantity = 0`, tracking on, default dose holding 25 units):

    /products/bpc-157-10mg  ->  ADD TO CART enabled, no Out of Stock badge
      -> added to cart -> checkout -> order written
      -> hold placed AGAINST THE DOSE (reservation.variant_id set)
      -> default dose reserved_quantity 0 -> 1
      -> parent row untouched: inventory_quantity 0, reserved 0

That also closes **F-001**, the runbook's own number-one priority, which had
never been verified.

### Why I got it wrong

The browser check that "confirmed" the finding ran against a harness database I
had corrupted earlier in this same audit — pointing the DB-backed suites at it
via `VANTA_TEST_DATABASE_URL` had rebuilt the schema and wiped `product_doses`.
The product I tested therefore had **no doses at all**, so its Out of Stock
badge was correct for that database and meaningless for production. I
generalised from it anyway.

That is precisely the trap recorded as finding 10 below, and it caught me
before I wrote it down. Two lessons, both now fixed in the tooling: the harness
guard in finding 10 exists so this cannot recur, and a stock claim must be read
from the **dose** rows, never the parent.

---

## Operational tidy-up

| # | Item | Evidence |
|---|---|---|
| 3 | Two paid orders awaiting fulfilment with no tracking number: **VL-3B91237B** (Aug 28), **VL-C98B8AB1** (Aug 27) | PROD-DATA |
| 4 | 5 abandoned checkouts sit >24h in `pending_payment`. Sentry warned they hold inventory; **they do not** — every one shows `active_holds = 0`, the sweep released their stock. No money moved. Clear them at leisure | PROD-DATA (supersedes Sentry `VANTA-LABS-2`) |
| 5 | **VL-E8F4D52F** shipped with tracking but no postage cost, so its profit is still unfinalized; 1 Shippo label purchased that matched no order | PROD-DATA, Sentry `VANTA-LABS-4` |
| 6 | **Supabase leaked-password protection is disabled.** One toggle; checks new passwords against HaveIBeenPwned | Supabase advisor |
| 7 | 3 of 25 accounts never confirmed their email. 22/25 confirmed *and* signed in, so delivery is working — these look like ordinary abandoned signups, not a systemic failure | PROD-DATA |

---

## Minor findings

**8. The referral-code endpoint exposes the ambassador roster — known, deferred
by owner decision. No change made.** `validate_referral_code` is
`SECURITY DEFINER` and anon-executable *by design* — the cart validates codes in
the browser with the anon key. Brute-forcing short codes against
`/rest/v1/rpc/validate_referral_code` would harvest approved ambassadors' real
names, with no rate limit at the PostgREST layer.

I proposed dropping `ambassador_id` from the return and **withdrew it after
review**. Three reasons, all verified against the tree:

- **It would not close the leak.** The roster is `ambassador_name`, and that
  field is load-bearing: `referral-qualification.ts:138` renders it on three
  surfaces (`cart-drawer.tsx:479`, `cart/cart-client.tsx:476`,
  `checkout/page.tsx:1105`). The UUID buys an anon caller nothing — `ambassadors`
  is RLS-locked to owner-or-admin, and no anon-callable RPC accepts an
  ambassador id.
- **It would risk a live price path.** `cart-context.tsx:261` does
  `Boolean(code.ambassadorId)`. That guard is a no-op only while the RPC always
  returns the PK; drop the field alone and the cart silently stops previewing a
  discount the server still charges — the exact defect class this file has
  already been repaired for twice.
- **The real remedy is already documented and consciously deferred.**
  `referral-rpc-minimise.sql:50-53` names it — move validation behind a
  rate-limited application route and revoke the anon grant — and records it as
  too large a change to a live checkout path to attempt opportunistically.
  `20260827233116_...sql:212` marks it *"Owner decision (RLS-09)"*.

So this stays open as a **question for the owner**, not a patch: accept the
exposure, or fund the move to a rate-limited server route. Note also that
`customer_discount_percent` must **not** be removed from the RPC —
`referral-rpc-minimise.sql:1-9` carries an explicit DO-NOT-RUN header recording
that doing so regressed a real incident (a 15% ambassador's customers were
offered 10%).

**9. The CASL consent split had no regression test — FIXED. EXECUTED.** The
jurisdiction split above is correct and browser-proven, but nothing guarded it:
changing `isUnitedStates(form.country)` to `true` would put every Canadian
shopper back on the mailing list with the whole suite still green.

`src/lib/marketing-consent-default.test.ts` now covers it — 13 tests, no
production code touched. `isUnitedStates` and the ternary are module-private to
a `"use client"` page and vitest runs `environment: "node"` with no jsdom, so the
test **lifts the real expression out of the page and executes it**, the technique
`harness-embed-parity.test.ts:73` already uses on the shim's parser and the trade
`checkout-no-bypass.test.ts:14` already made for this same file.

It asserts the result rather than the spelling: both country helpers are injected,
so the behaviour-identical `!isCanada(...)` rewrite still passes while
`: true`, `: marketingChoice` and an inverted test all fail. **Proven to fail for
the right reason** — flipping the live ternary to `true` turned 3 assertions red;
restoring it returned all 13 to green.

**10. The harness could silently serve a wrong database — FIXED. EXECUTED.**
This is the defect that produced the retracted finding above, so it is written
up as one fault rather than the two symptoms it presented as.

**Root cause.** `src/lib/admin-financial-surfaces.test.ts` is the one DB-backed
suite that connects straight to `VANTA_TEST_DATABASE_URL`, and it runs
`ORDERS_DDL` from `src/lib/e2e/block-f-fixture.ts:14-17`, which does
`drop table if exists public.orders cascade` and rebuilds it with 39 columns.
Point that variable at the harness database and its `orders` table is replaced
in place, losing `payment_id`, `provider_event_id`, `referral_code` and
`ambassador_id`.

**Why it stayed invisible — the part that actually mattered.** Re-running
`setup-local-harness.sh` could not repair it: `createdb || true` never drops the
database, and every orders DDL in the build is `create table if not exists`, so
the base schema is a no-op against an existing table. Meanwhile the parity
self-check reported every row green, because it only covered columns
`harness-prod-parity-columns.sql` re-adds. The harness went on serving a wrong
database while insisting it was correct, and `scripts/harness-pay-order.mjs`
died on `column "payment_id" does not exist`.

**Fixed, three ways, each verified:**

| Change | Proof |
|---|---|
| `harness-prod-parity-columns.sql` now re-adds the four columns, so setup *repairs* a damaged table | Dropped all four, re-ran setup, all four returned |
| Four new parity checks assert them | Check SQL returns `f` with the column dropped, `t` once restored |
| `vitest.setup.ts` refuses to run when `VANTA_TEST_DATABASE_URL` names the harness database | Blocks `storefront` with a message naming the fix; a throwaway DB still runs (5 tests pass) |

---

## What this audit could not prove

Stated plainly rather than glossed:

- **The real card iframe.** `SCRIPT_SRC` is hardcoded to `veyragate.com` and
  should stay that way. Card entry, 3DS and decline-at-the-bank were not
  exercised; the payment *outcome* paths were, via signed webhooks.
- **Live email delivery.** The harness runs `EMAIL_PROVIDER=none`, so the
  confirmation email was proven *queued and correctly addressed*, not
  *delivered*. Production evidence (22/25 accounts confirmed and signed in)
  says the real provider works.
- **RLS behaviour under a signed-in user.** The local shim has no auth and no
  RLS. RLS deny-by-default is proven by the DB suite against real Postgres, not
  through the HTTP layer.
- **Anything on production itself.** Per the working agreements, production was
  read-only throughout: no test orders, no payments, no state changes.

---

## Bottom line

The code is in good shape. The suites are genuinely comprehensive (5,614 tests,
including the concurrency proofs that usually get skipped), the money math is
exact on every real order, the purchase path works end to end, and the recent
round of fixes is deployed and holding — only one new Sentry issue in 24 hours,
and that one is benign.

The catalogue is healthy too — 36 of 36 live products sellable and stock-gated.
The finding that said otherwise was mine, and it was wrong; the correction and
its cause are recorded above rather than quietly edited out.

That leaves **sales-tax nexus** as the one open judgement call, and the owner
has reviewed it and chosen to defer. Everything else outstanding is physical
work — ship the two paid orders, enter the postage on VL-E8F4D52F — plus one
toggle in the Supabase dashboard.
