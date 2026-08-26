# BLOCK G + H — Browser verification

**Session scope:** G (phases 3, 5, 6, 7 — customer journey, stock display, cart
discounts, checkout UI, membership) and H (phases 13, 9, 10(a11y), 1(storage),
2(multi-tab) — mobile, accessibility, hydration, stale state, multi-tab).

**Environment:** local Postgres 16 carrying a schema verified column-for-column
against production (`mlpimwgkwuqpsvsrlpqv`), fronted by
`scripts/pgrst-shim.mjs`. Production build (`npm run build && npm run start`),
never `next dev`. Rebuild it from cold with `scripts/setup-local-harness.sh`.

**Evidence grades used here**
- `BROWSER-PROVEN` — driven through the real UI on the production build, with
  the database checked at each step.
- `DB-PROVEN` — established against the harness database or, where stated,
  against production via a read or a rolled-back probe (execution-plan Rule 4).
- `PROD-SCHEMA-PROVEN` — established by reading production's own catalog.
- `NOT VERIFIED` — auth- or RLS-dependent, or otherwise not exercised. The shim
  has no RLS and no GoTrue; nothing behind a login is graded above this.

---

## THE HEADLINE: one complete purchase, end to end

Checkout had never been exercised in any environment. It has now been run twice.

Order `VL-0061C142` (`order-23e40002-…`), guest, 2 × BPC-157 10mg, ambassador
code `EXPLICIT15`:

| Step | Screen | Database | Verdict |
|---|---|---|---|
| Cart | subtotal $131.10 | — | ✅ |
| Discount | `Ambassador code EXPLICIT15 −$13.80` | `orders.discount_amount = 13.80` | ✅ |
| Totals | ship $15.00, protection $5.24, fee $4.13, **$141.67** | `shipping_amount=15.00 shipping_protection_fee=5.24 card_processing_fee=4.13 amount_paid=141.67` | ✅ |
| Order row | order placed | `orders` 1 row, `payment_status=pending_payment` | ✅ |
| Line items | 2 × BPC-157 10mg | `order_items` 1 row, `x2 @65.55 = 131.10` | ✅ |
| Inventory hold | — | `inventory_reservations` qty 2, `active` | ✅ |
| Payment | see note | `payment_status=paid`, `paid_at` set, `payment_events` 1 row | ✅ |
| Inventory decrement | — | dose `25 → 23`, reservation `finalized` | ✅ |
| Confirmation email | — | `order_email_log` 1 row, `pending_emails` 1 row | ✅ |
| Fulfilment queue | — | `fulfillment_status=awaiting_fulfillment`, matches the queue's own predicate | ✅ |
| **Commission** | — | **`referral_orders` 0 rows, `commissions` 0 rows** | ❌ **G-01** |

**The payment step, stated precisely.** It was NOT clicked through a card form.
The mock gateway is unreachable on any production build: `next build` inlines
`process.env.NODE_ENV` as `"production"`, and mock payments are hard-blocked
there with no override (`resolvePaymentProviderName`, and the regression test in
`mock-payment-lockout.test.ts`). That control is correct and was not weakened.
The runbook's "production build + `PAYMENT_PROVIDER=mock`" is therefore not
achievable as written — see H-01.

Instead the order was completed by signing the same `payment.succeeded` event
the mock gateway builds and POSTing it to the real `/api/webhooks/payment`
(`scripts/harness-pay-order.mjs`). That is the identical code path a live
processor callback takes: signature verify → mark paid → inventory → commission
→ confirmation email → fulfilment. So: everything up to and including order
creation is `BROWSER-PROVEN`; everything after the processor handoff is
`DB-PROVEN` through the genuine webhook pipeline. The card form itself and the
processor handoff are `NOT VERIFIED`.

**Verdict: a customer can complete a purchase, and the database agrees with the
screen at every step — except that the ambassador earns nothing (G-01).**

---

## G-01 — Every ambassador commission accrual fails, silently — P0

**Grade:** `BROWSER-PROVEN` (harness) + `DB-PROVEN` against production
**Status:** CONFIRMED, not fixed (fix is one line, but `payment-webhook.ts` is
shared — see CROSS-BLOCK below)

**Reproduction.** Place any paid order carrying a valid referral code. The order
completes normally. No `referral_orders` row and no `commissions` row is
created. The customer sees nothing wrong; the ambassador is simply never paid.

**Root cause.** `src/lib/payment-webhook.ts:694` sets `payment_status: "pending"`
in `basePayload`, which feeds the INSERT at `src/lib/payment-webhook.ts:745`.
`referral_orders` carries a check constraint permitting only
`paid | refunded | partially_refunded`. The insert is rejected with SQLSTATE
23514, the error is caught by the caller and written to the log as "Unable to
record commission for order …", and processing continues as if nothing happened.

Observed, from the running server:

```
Unable to record commission for order order-23e40002-…
  code: '23514',
  message: 'new row for relation "referral_orders" violates check constraint'
  details: 'Failing row contains (…, pending, …)'
```

**This is production's constraint, not a harness artefact.** Verified against
production with a rolled-back `DO`-block probe (the execution plan's approved
pattern — nothing persisted):

```
PROBE RESULT: pending_rejected=t   (production, rolled back)
```

`pending_rejected` was set only by catching `check_violation` specifically, so
production's own CHECK is what rejects the value the code writes.

**Negative control** (harness, both arms rolled back). Same row twice, only
`payment_status` differing:

```
CONTROL A: payment_status='pending' -> ERROR: violates check constraint
CONTROL B: payment_status='paid'    -> INSERT 0 1
```

Nothing else about the row matters. The commission maths itself is correct:
the rejected row carried `commission_percent=15.00`, `commission_amount=17.60`
on `amount_paid=117.30` — exactly 15%.

**Why it has never been noticed.** Production has zero paid orders carrying a
referral code (`paid_orders_with_referral = 0`, `referral_orders = 0`,
`commissions = 0`). The first real ambassador sale will lose its commission.

**Fix.** `payment_status` on the accrual insert must be a value the constraint
permits. `'paid'` is the correct one — the accrual is written from a
`payment.succeeded` event, i.e. money has been captured. Payout state is tracked
separately in `payout_status` (default `'unpaid'`), which is what "not yet paid
out" actually means; `payment_status: "pending"` appears to be conflating the
two.

**CROSS-BLOCK:** `src/lib/payment-webhook.ts` — Block A+B owns the affiliate
paths in this file (deconfliction Rule 3). One-line change at line 694:
`payment_status: "pending"` → `"paid"`. Needs a regression test asserting a
`referral_orders` row exists after a paid referral order, with a negative
control that mutates the status back to `'pending'` and shows the test fails.

---

## G-02 — Refunded and cancelled orders never return stock to the shelf — P1

**Grade:** `PROD-SCHEMA-PROVEN` + `DB-PROVEN` (harness reproduced it exactly)
**Status:** CONFIRMED, not fixed (migration, owned by Block D)

**Reproduction.** Refund a paid order (`refund.completed`). The refund is
processed correctly — `payment_status=refunded`, `refund_amount=148.77` — and
the refund email is queued. Stock does not move: the dose stayed at 21 when it
should have returned to 23.

**Root cause.** `restockInventoryForOrder` is gated behind
`claimInventoryRestock`, an exactly-once claim that flips
`orders.inventory_restocked_at` from NULL. **That column does not exist in
production.** Verified directly against production's catalog:

```
select column_name … where table_name='orders'
  and column_name in ('inventory_restocked_at','paid_side_effects_at')
-> "paid_side_effects_at"          -- inventory_restocked_at is absent
```

So the claim errors 42703 and, by its own documented fail-safe, returns false so
the caller does **not** restock:

```
Inventory restock claim failed (skipping restock) for order …
  code: '42703', message: 'column "inventory_restocked_at" does not exist'
```

The fail-safe is deliberate and the direction is the safe one (under-restock
rather than phantom stock). The bug is that the migration was never applied, so
the safe branch is the *only* branch that ever runs.

**Impact.** Production has inventory tracking ON (`inventory.tracking_enabled =
true`, set by the owner on 2026-08-25), so stored quantities genuinely gate
sales. Every refund or cancellation permanently removes its units from sellable
stock. Products will read "Out of Stock" while physically sitting on the shelf,
and the error is only ever a log line.

**Fix.** Add the column and its partial index, mirroring `paid_side_effects_at`:

```sql
alter table public.orders add column if not exists inventory_restocked_at timestamptz;
```

**CROSS-BLOCK:** inventory is Block D's scope. Needs a regression test that
refunds a paid order and asserts stock returns, plus a second refund event
asserting it does not return twice (the claim's actual purpose).

---

## G-03 — An order and its stock hold are written before the payment session exists — P2

**Grade:** `BROWSER-PROVEN`
**Status:** CONFIRMED, not fixed

**Reproduction.** With the live provider configured but unreachable, click
"Continue to secure payment". The UI correctly reports "We couldn't start
checkout just now. No charge was made and no order was placed." The database
disagrees: a `pending_payment` order row and an `active` inventory reservation
for 2 units both exist.

**Root cause.** Order creation and the inventory hold happen before
`createCheckoutSession` is called; the session failure (`Missing VEYRA_API_BASE`)
is surfaced to the user afterwards. `create-session/route.ts` opens with a
comment stating the gate exists so there are "no orphan orders, no false
'confirmed' state" — that guarantee holds for the *checkout-closed* case it
guards, but not for a processor failure one step later.

**Impact.** Any processor outage or transient error produces orphan
`pending_payment` orders that hold real stock until the reservation expires,
while telling the shopper no order was placed. It also makes the "no charge was
made and no order was placed" copy untrue.

**Fix direction.** Either create the session before writing the order, or roll
back the order and release the hold when session creation fails. Not fixed here:
this is checkout-transaction ordering and wants Block A's concurrency view.

**CROSS-BLOCK:** `src/app/api/checkout/create-session/route.ts` + `quote-order.ts`.

---

## G-04 — `adjust_inventory_on_sale` does not exist in production — P2, latent

**Grade:** `PROD-SCHEMA-PROVEN`; live consequence NOT reproduced
**Status:** CONFIRMED mismatch, consequence currently masked

The app calls `supabaseAdmin.rpc("adjust_inventory_on_sale", …)` from
`src/lib/inventory-fulfillment.ts:66`. Production has no such function in any
schema:

```
select … where proname ilike '%adjust_inventory%'  ->  NO SUCH FUNCTION IN ANY SCHEMA
```

It exists only in `deploy-run-once.sql`, i.e. in the repo but never deployed.

**I expected this to be a P0 and it is not — I tested it rather than assuming.**
I dropped the function from the harness to match production and ran a second
full purchase. Stock still decremented correctly (23 → 21), because the paid
path's stock movement is done by `finalize_inventory_for_order` (which
production *does* have). `decrementInventoryForOrder` is only the fallback when
the reservation is degraded or absent, and it was never reached.

**Remaining exposure**, all silent (every caller catches and logs):
- the paid-path fallback (expired hold, untracked item, pre-migration order) —
  `payment-webhook.ts:1138`
- replacement orders — `admin-replacements.ts:241`
- refund restock — `inventory-fulfillment.ts:124`, currently unreachable anyway
  because G-02 stops it earlier

**Fix.** Deploy the function, or delete the dead call path. Do not do both
halfway — the current state is code calling a function that isn't there.

---

## G-05 — Sales never appear in the inventory ledger — P3

**Grade:** `DB-PROVEN`

After two paid orders moving 4 units, `inventory_transactions` has 0 rows.
`recordInventoryTransaction` is only ever called from
`src/lib/inventory-operations.ts:126` and `src/lib/admin-inventory.ts:433` —
admin adjustments. Nothing on the sale, refund or replacement path writes it.

**Impact.** `/admin/inventory` history and its CSV export show manual
adjustments only. A stock level that fell because of sales looks like it changed
for no recorded reason, which is precisely when someone goes looking at the
ledger.

---

## H-01 — The runbook's mock-payment setup is not achievable — process finding

`docs/BROWSER-TESTING-RUNBOOK.md` §5–6 says to run `npm run build && npm run
start` with `PAYMENT_PROVIDER=mock`. These are mutually exclusive:

- `next start` sets `NODE_ENV=production` itself;
- `next build` inlines `process.env.NODE_ENV` as `"production"` into the
  compiled bundle, so a runtime override cannot reach it;
- mock payments throw unconditionally when `NODE_ENV === "production"`, by
  design and with no escape hatch.

Confirmed by trying all three: runtime `NODE_ENV=test`, rebuild under
`NODE_ENV=test` (which also silently drops `.env.local`, since Next excludes it
in test), and a custom server (`scripts/harness-server.mjs`). The lockout held
every time — which is good news about the lockout.

**The lockout is correct and must not be relaxed to make testing convenient.**
The runbook should instead say: drive the browser to order creation with
`CHECKOUT_ENABLED=true`, then complete payment via the signed-webhook script.
`scripts/harness-pay-order.mjs` is committed for that.

---

## Verified working (no defect)

| Item | Grade | Evidence |
|---|---|---|
| **One complete purchase** | BROWSER-PROVEN / DB-PROVEN | table above |
| **F-001 — parent-zero, dose-stocked renders In Stock and is purchasable** | BROWSER-PROVEN | with tracking ON (production's setting): parent `inventory_quantity=0`, dose 25 → "$69.00", Add to Cart enabled, no stock warning. This is the shape of 31 of 36 live products |
| **Out-of-stock control** | BROWSER-PROVEN | all-doses-zero product shows "Out of Stock" and "NOTIFY ME" instead of Add to Cart |
| **Historical defect #1 — ambassador discount resolution** | BROWSER-PROVEN | see below |
| **`info_requested` code is inert** | BROWSER-PROVEN | `HOLDPROBE` → "That referral code is not active.", discount line removed |
| **Referral minimum-order rule** | BROWSER-PROVEN | at $69: "Referral codes require a minimum order of $100.00" |
| **Mock-payment production lockout** | SOURCE + BROWSER | unbypassable, see H-01 |
| **Mobile 390×844** | BROWSER-PROVEN | product + cart: `scrollWidth == 390`, no horizontal overflow, no tap target under 24px |

### Historical defect #1 is fixed — and the number that looks wrong is right

This nearly went in as a P0. On screen the cart shows subtotal **$131.10** and
`Ambassador code EXPLICIT15 −$13.80`. $13.80 is exactly 10% of $138.00, which
reads like a 15% ambassador being paid the 10% program default.

It is not. The no-stacking rule nets a referral against bundle savings already
granted (`resolveCustomerDiscount`, `compete()`):

```
list price        2 × $69.00       = $138.00
bulk price        (already granted)= $131.10   (saves $6.90)
referral 15% of $138.00            =  $20.70
less already granted $6.90         =  $13.80   <- the line shown
merchandise total $131.10 − $13.80 = $117.30
check: $138.00 × 0.85              = $117.30   exactly 15% off list
```

Both resolutions are correct, browser-proven:

| Ambassador | `customer_discount_percent` | Discount line | Net vs list |
|---|---|---|---|
| `EXPLICIT15` | 15.00 | −$13.80 | $117.30 = **15%** off $138.00 ✅ |
| `INHERITME` | NULL (inherits) | −$6.90 | $124.20 = **10%** off $138.00 ✅ |

The `referral_orders` row the webhook tried to write agrees ($117.30, commission
$17.60 = 15%). **Historical defect #1: REFUTED — behaving correctly.**

**Presentation note (not a defect).** The displayed discount is not a round
percentage of any number visible on screen, because the subtotal shown is
already net of bulk pricing. "You saved $13.80" also understates the true saving
of $20.70 against list. Worth a copy change; no money is wrong.

---

## Disproved during this session

Recording these because the execution plan asks for it, and two of them would
have been convincing P0s in the report.

1. **"Ambassador gets 10% instead of their explicit 15%"** — arithmetic above.
   The coincidence that $13.80 is exactly 10% of $138.00 made this look certain.
   REFUTED by doing the arithmetic against list price.
2. **"A fully out-of-stock product is purchasable"** — first observed with
   `Add to Cart` enabled and no stock warning on an all-zero product. This was
   my own harness artefact: availability is gated by a *global* admin setting
   (`inventory.tracking_enabled`), not per-row `track_inventory`, and my harness
   had it unset. Production has it **true** (owner, 2026-08-25). Re-tested with
   it on: correct. REFUTED. It also invalidated my first F-001 test, which was
   re-run.
3. **"Missing `adjust_inventory_on_sale` means paid orders never decrement
   stock"** — disproved by dropping the function and running a real purchase;
   stock moved anyway via `finalize_inventory_for_order`. Downgraded to G-04.
4. **"The runbook file and shim don't exist"** — my error at session start: I
   read `git log --all` as authoritative when it only covers fetched refs. The
   branch simply hadn't been fetched.

---

## NOT VERIFIED (and why)

Nothing below is a pass or a fail; it was not exercised.

| Area | Reason |
|---|---|
| Every RLS policy | Shim connects as superuser. Policies would be inert; creating them would falsely imply they were tested |
| Signed-in customer journeys, account pages, wishlist, points redemption | No GoTrue in the shim |
| Membership purchase and tier grant | Requires a signed-in customer |
| Admin UI — fulfilment queue, orders, inventory screens | Admin session was not accepted over plain HTTP. `isSameOriginRequest` (`middleware.ts:84`) defaults `x-forwarded-proto` to `https`, so a local http origin never matches. **This is a harness artefact, not a production bug** — Vercel sets that header, and the default fails closed, which is the right direction. Queue membership was instead confirmed at the data layer against the queue's own predicate (`fulfillment-queues.ts:141`) |
| The card form and processor handoff | See H-01 |
| Order-confirmation page; cart clearing after purchase | The browser never reached confirmation (payment completed out-of-band), so the client never got the order-placed signal. The cart still holding the purchased items afterwards is expected here and is **not** evidence of a defect |
| Accessibility beyond mobile layout — keyboard path through checkout, focus trapping, labels | Not reached this session |
| Multi-tab races, cart persistence across refresh/back-forward, hydration error sweep | Not reached this session (Block H remainder) |
| Coupon + referral interaction, Buy-3-Get-1 | Not reached. Coupon correctly refused while a referral was applied, but the combination itself was not exercised |

---

## Harness fidelity — what the evidence above rests on

The schema was **not** taken on trust from the repo's SQL, which had drifted
(`orders` 87 columns vs production's 103, `order_attribution` missing entirely).
It was reconciled against production and verified:

- 68 tables, matching production exactly
- every table's column set a superset of production's, built from production's
  own catalog (`harness-prod-parity-columns.sql`)
- every unique index and check constraint in production's list present locally,
  checked name by name — including the three the runbook calls out
  (`orders_idempotency_key_uniq`, `inventory_reservations_order_line_key`,
  `order_email_log_one_live`)
- the plpgsql functions the runbook names, from
  `BASELINE-live-functions-2026-08-25.sql` plus production
- no RLS, deliberately

**Known harness gaps** (each would be a false negative, never a false positive):
- `create_partner_invite` and five `admin_*` rollup functions not loaded
- local has a few columns production lacks (`orders.gross_profit_cents`,
  `processing_fee_cents`, `product_cost_cents`, `shipping_cost_cents`,
  `commission_cost_cents`, `gross_margin_percent`; `ambassadors`/`partners`
  `referral_code_locked`, `referral_code_changed_at`) and two tables production
  lacks (`referral_code_aliases`, `referral_code_changes`). **App code reads
  `referral_code_aliases` in five places** — a lead for whoever owns referral
  codes, since production has no such table.
- `orders.inventory_restocked_at` is missing locally *and* in production, which
  is G-02.

Rebuild: `scripts/setup-local-harness.sh`, then
`node scripts/pgrst-shim.mjs --port 54321 --db postgres://postgres@localhost:55432/storefront`,
then `npm run build && npm run start`.

---

## Suggested next actions

1. **G-01** — one-line fix, owned by Block A+B. Nothing else on this list costs
   the business money on the first real ambassador sale.
2. **G-02** — one-column migration, owned by Block D. Verify against production
   before assuming any other environment has it.
3. **G-03** — checkout ordering, wants Block A's concurrency view.
4. Block H's remainder (multi-tab, storage, a11y, hydration) is untouched and
   needs a session.
5. Correct the runbook per H-01 so the next session does not re-derive it.
