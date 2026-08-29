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

Two items should be **decided before you spend on traffic** — neither is a code
fault, both are yours to call:

1. **Sales tax has been switched off since 2026-08-23** — $0 collected on every
   order since, including both recent real orders.
2. **15 of your 36 live products currently show "Out of Stock"** and cannot be
   bought.

Everything else is operational tidy-up.

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

### Out-of-stock gating is honest — BROWSER

A tracked product at zero (`stock_status` still says "In Stock" in the column,
tracking on) renders a **disabled "Out of Stock" button**, and
`reserve_inventory` independently returns `false` for it. Display and checkout
agree, so there is no path where a customer is shown a purchasable product that
fails at the till.

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

### 1. Sales tax is switched off — PROD-DATA

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

### 2. 15 of 36 live products cannot be bought — PROD-DATA

Tracking is **on** in production, and these have `inventory_quantity = 0`, so
they render "Out of Stock":

`5-amino-1mq`, `b12`, `bpc-157`, `bpc-157-tb-500`, `cjc-1295-ipamorelin`,
`epithalon`, `glp-2`, `glp-3`, `kisspeptin`, `klow`, `mt-2-melanotan-ii`,
`nad`, `selank`, `semax`, `snap-8`

That includes several of your headline SKUs. The system is behaving correctly —
the question is whether the shelf is genuinely empty or the counts were simply
never entered in `/admin/inventory`. Sending paid traffic to a catalogue where
42% of it is unbuyable is the most expensive thing on this list.

**The other half of the same setting:** 17 of the 36 live products have
`track_inventory = false`, so they sell with **no stock gate at all** and can
oversell without limit. Now that you fulfil your own orders, that is a
fulfilment risk in the opposite direction. The split is currently 19 tracked
(15 of them at zero) / 17 untracked.

---

## Operational tidy-up

| # | Item | Evidence |
|---|---|---|
| 3 | Two paid orders awaiting fulfilment with no tracking number: **VL-3B91237B** (Aug 28), **VL-C98B8AB1** (Aug 27) | PROD-DATA |
| 4 | 2 express orders pending >24h at the processor, holding inventory — abandoned 3DS challenges. They will never settle on their own; cancel or complete them | Sentry `VANTA-LABS-2` |
| 5 | 2 orders need shipping cost entered by hand (Shippo can't read the postage back); 1 Shippo label purchased that matched no order | Sentry `VANTA-LABS-6`, `VANTA-LABS-4` |
| 6 | **Supabase leaked-password protection is disabled.** One toggle; checks new passwords against HaveIBeenPwned | Supabase advisor |
| 7 | 3 of 25 accounts never confirmed their email. 22/25 confirmed *and* signed in, so delivery is working — these look like ordinary abandoned signups, not a systemic failure | PROD-DATA |

---

## Minor findings

**8. The referral-code endpoint leaks the ambassador roster — PROD-DATA + CODE.**
`validate_referral_code` is `SECURITY DEFINER` and executable by `anon`, which is
*by design* — the cart validates codes in the browser with the anon key. But it
returns `ambassador_name` **and** `ambassador_id` on a hit, with no rate limit at
the PostgREST layer. Brute-forcing short referral codes against
`/rest/v1/rpc/validate_referral_code` would harvest the real names and internal
UUIDs of every approved ambassador. The cart needs the name to display "referred
by"; it does not need the UUID. Dropping `ambassador_id` from the return would
cost nothing.

**9. The CASL consent split has no regression test — EXECUTED.** Finding 6 above
(marketing box unchecked for Canada) is correct in code and browser-proven, but
no test covers it. A one-line change to that ternary would silently create a
compliance problem in Canada with every suite still green.

**10. Two harness-tooling gaps found while running this audit — EXECUTED.**
Neither affects production, both cost time:

- `scripts/harness-pay-order.mjs` — the documented way to drive payment
  outcomes — selects `payment_id`, `provider_event_id`, `referral_code` and
  `ambassador_id`, which are the **exact four columns** the harness schema
  lacks versus production. It crashes on `column "payment_id" does not exist`
  until they are added. The harness therefore cannot exercise affiliate
  attribution or webhook idempotency out of the box; both are covered by unit
  and DB tests only.
- Pointing `VANTA_TEST_DATABASE_URL` at the harness `storefront` database
  **destroys it** — the suites rebuild `orders` with their own minimal schema
  (107 columns → 39). The parity self-check then passes on a stale run while the
  live database is wrong. Worth a line in the runbook, and worth having the
  suites refuse a database named `storefront`.

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

Before you turn on traffic: **restore sales-tax nexus, and fix the stock counts
so your catalogue is actually buyable.** Those two are worth more than
everything else in this document combined.
