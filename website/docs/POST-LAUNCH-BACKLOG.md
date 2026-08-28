# POST-LAUNCH BACKLOG

Defects that are **real and verified**, but **latent** — none can produce a wrong
outcome on the live store today, and none blocks the launch. Each was found by
the final independent verification session and is recorded here so it is not
rediscovered from scratch, and not resurrected as a blocker.

Every claim below was verified by command or production query in that session,
not carried over from an earlier write-up.

---

## PLB-01 — `isShippoLive()` is dead code guarding money, under a false comment

**Severity:** P2 · latent · dead code + false assertion
**Files:** `website/src/lib/shippo/config.ts:49`

**What is wrong.** The comment above `isShippoLive()` states:

> "Every money-spending path checks this."

**No path checks it.** Verified:

```
$ grep -rn 'isShippoLive' --include=*.ts --include=*.tsx website/src
website/src/lib/shippo/config.ts:52:export function isShippoLive(): boolean {
```

One occurrence in the entire repository — its own definition. **Zero callers.**

**Why it is latent, not live.** Nothing calls it, so it cannot return a wrong
answer. Label purchasing is actually gated by `labelPurchasingEnabled()` and by
the `SHIPPO_ALLOW_LABEL_PURCHASE` environment variable, which is to be left unset
until a real label is intended.

**Why it still matters.** This is the exact shape of N-04, which *was* fixed: a
function written to be the single source of truth for a money decision, with zero
call sites, sitting under a comment asserting that everything consults it. The
next author to read that comment will believe the guard is in place. It also
means a genuine "is Shippo in live mode" check does not exist anywhere.

**What closes it.** One of two, and it is a real decision, not a cleanup:
either wire `isShippoLive()` into the label-purchase path alongside
`labelPurchasingEnabled()`, or delete it and the comment. **Do not "fix" this by
editing the comment to match the code** — that would hide the fact that the guard
was intended and never built.

---

## PLB-02 — the two refunded-tax rules are not identical, and each claims the other is authoritative

**Severity:** P2 · latent · duplicate business rule
**Files:** `website/src/lib/admin-tax-report.ts:77` (`refundedTaxFor`),
`website/src/lib/admin-profit.ts:88` (`refundedTaxPortion`)

**What is wrong.** Both functions answer "what share of the tax came back with
this refund", and both carry a comment naming the *other* as the shared source of
truth so the filing report and the profit report "cannot disagree". They are not
the same function.

```
admin-tax-report.refundedTaxFor           admin-profit.refundedTaxPortion
  tax==0 || refund==0                       taxCollected<=0 || refund<=0
    -> status=='refunded' ? tax : 0           -> 0                    <-- DIVERGES
  paid<=0 -> tax                            amountPaid<=0 -> taxCollected
  else min(tax, tax*min(1,refund/paid))     else (identical formula)
```

**The divergent case.** An order marked `refunded` that carries **no**
`refund_amount` and non-zero tax:

- the **filing report** counts the **whole** tax as refunded
- the **profit report** counts **zero**

Two screens, one refund, two different answers — precisely what both comments
claim is impossible.

**Why it is latent.** Verified against production:

```sql
select payment_status, count(*) from orders group by payment_status;
-- paid 6 | canceled 5 | pending_payment 4
```

**There are zero refunded orders in production.** The divergence cannot be
producing a wrong filing today. It is reachable only through a legacy-shaped row
— `payment_status='refunded'` with `refund_amount` null or zero — and current
code always writes `refund_amount` on a refund.

**What closes it.** Pick one rule, implement it once, and have the other import
it — the N-04 pattern. The substantive question is which behaviour is right for a
refunded order with no recorded refund amount: the tax report's "trust the status,
assume a full refund" is the conservative choice for a filing (it does not
under-report tax already remitted), and is probably the one to keep. **Whichever
is chosen, both comments are false today and must be corrected with it.**

---

## PLB-03 — a returned parcel does not put its units back on the shelf

**Severity:** P2 · latent · unrecorded business decision
**Files:** `website/src/lib/order-pipeline.ts` (`TRACKING_STATUS_MAP`, terminal
statuses), `website/src/lib/shippo/service.ts` (`setOrderFulfillmentStatus`)

**What is wrong.** The cancel/restock work (K-17 / G-02 / N-07) put the inventory
return at the single chokepoint that writes a fulfilment status, and it fires on
exactly one transition: `→ cancelled`. `returned` is a separate terminal status,
reached automatically from the carrier feed:

```
TRACKING_STATUS_MAP:  RETURNED -> "returned"
                      FAILURE  -> "returned"    (undeliverable, refused, damaged)
```

A parcel that comes back — refused, undeliverable, or damaged — moves the order to
`returned` and **nothing restocks it**. The units stay written off.

**Why it is latent.** No order has ever shipped, so nothing has ever returned.
This has never cost a unit.

**Why it is not simply a bug.** Whether returned goods go back into sellable stock
is a **business decision the owner has to make**, and for a research-peptide store
it is genuinely not obvious — a vial that has left custody and come back may not be
sellable at all, and a damaged or refused parcel almost certainly is not. That is
why this is recorded rather than fixed: shipping an automatic restock on
`→ returned` could put non-sellable product back on the shelf, which is worse than
the current under-count.

**Note on scope.** No previous block filed this. The cancel work deliberately
scoped itself to `cancelled` and the audit never asked what happens to
`returned`. It is recorded here so the question is asked before the first return,
not after it.

**What closes it.** An owner decision, then one of:
- restock automatically on `→ returned` (same chokepoint, same claim), or
- raise an alert on `→ returned` the way `label_purchased → cancelled` already
  does, and let a human adjust the count after inspecting the parcel — **this is
  the recommendation**, because it matches how the store already handles the other
  "a human must look at this" inventory case, or
- record explicitly that returned units are written off, so the next reader knows
  it is intended.

---

## Summary

| id | severity | latent because | closed by |
|---|---|---|---|
| PLB-01 | P2 | zero callers, so it cannot return a wrong answer | wire it up or delete it — not a comment edit |
| PLB-02 | P2 | production has zero refunded orders | one rule, one implementation, both comments corrected |
| PLB-03 | P2 | nothing has ever shipped, so nothing has returned | owner decision, then alert (recommended) or restock |
| PLB-04 | P3 | the probe degrades correctly; the offers bar renders | **CLOSED 2026-08-27** — migration applied to production, and the probe now remembers its answer |

None of these blocks the launch. All three should be closed before the store has
enough volume to make them reachable — PLB-03 the soonest, since it becomes
reachable the first time a parcel comes back.

---

## PLB-04 — a by-design column probe logs a permanent 42703 against production

**Severity:** P3 · observability · pre-existing, inherited unchanged by this branch
**Files:** `website/src/lib/storefront-offers.ts:81` · closed by `website/src/lib/sql/coupon-storefront-fields.sql`

**Found by:** the owner, from live production logs, during the migration run.
Not previously recorded by any block.

**What production logs, continuously:**

```
42703  column coupons.storefront_headline does not exist
400    GET /rest/v1/coupons
```

**This is not a failure.** `publicCoupons()` is a deliberate degradation ladder
that tries three column-sets widest-first and steps down on error. Verified
against production: `is_private` and `member_scope` exist,
`storefront_headline` and `storefront_priority` do not, so **tier 2 succeeds and
the offers bar renders correctly** with the generated headline and default
priority 10. No customer sees anything wrong.

**Why it is still worth closing.** A permanently-red `42703` in Sentry is
indistinguishable at a glance from a real missing-column error — and this
codebase has load-bearing ones in exactly that class
(`orders.inventory_restocked_at` failed with the same code and went unnoticed
because a caller reported it as success). A by-design probe that cries wolf every
render is how the next real one hides.

Secondary: operators cannot override an offer's headline or ordering. The
generated headline is derived from the coupon's own discount and so cannot drift
from it, which makes the current fallback the safer default anyway.

**Does it block the deploy?** No. It is unchanged by this branch, additive to
fix, and customer-invisible.

**What closes it.** Apply `sql/coupon-storefront-fields.sql` (adds
`storefront_headline` and `storefront_priority`). Additive, zero blast radius.
Alternatively, probe `information_schema` once per process instead of probing by
provoking an error — but the migration is the smaller change.

### CLOSED — 2026-08-27

Both halves were done, because they close different failure modes.

**The migration was applied to production** (`coupon_storefront_fields`), on the
owner's explicit instruction. Verified before and after with the publishable key
against the live REST endpoint, using the exact tier-1 column list from
`storefront-offers.ts`:

```
before   [HTTP 400]  {"code":"42703","message":"column coupons.storefront_headline does not exist"}
after    [HTTP 200]  []
```

`information_schema` confirms both columns present, `text` and `integer`, both
nullable. No existing row was touched and no default was set.

**The probe also got a memory**, which the migration alone would not have
provided: `selectColumnTier` (`storefront-offers.ts`) now remembers the tier
that worked for the life of the process, so ANY future unrun optional migration
costs one probe per cold start rather than one per page load. Only a success is
cached, and a remembered tier that later fails re-probes the whole ladder, so
the fallback stays migration-tolerant in both directions.

Rediscovered from production edge logs during the 2026-08-27 alert review before
this entry was read — which is the thing this document exists to prevent. The
volume it was costing, measured over 24h: **2,350 × 400 on `/rest/v1/coupons`**,
roughly one per page load.

Worth recording separately, because it was found while chasing the same logs and
is NOT what the offers bar's emptiness is about: all 335 active coupons carry an
`assigned_email`, so there are currently **zero** publicly advertisable coupons.
The bar has nothing to show for reasons that have nothing to do with this probe.


---

## SECURITY REVIEW: `/api/mcp/*` routes proposed on an unmerged branch

**Status:** open, unmerged. Raised 2026-08-26 from the checkout-flow lane.
Recorded here only — that branch was deliberately NOT touched by this lane.

**Branch.** `copilot/add-mcp-server-with-devtools-integration`
(`46b5df2`, `9d432d8`; last activity 2026-08-25). It adds 16 files, among them:

    website/src/app/api/mcp/contexts/route.ts
    website/src/app/api/mcp/contexts/[contextId]/route.ts
    website/src/app/api/mcp/events/route.ts
    website/src/app/api/mcp/ws/route.ts
    website/devtools/mcp-extension/*      (a browser extension)

**Why it is on this list.** The project's own working agreement says, verbatim:

> Never add `/api/mcp/*` routes, browser-control endpoints, or debugging
> backdoors to the customer-facing app. All tooling here is development-only
> and lives outside the Next.js runtime.

The branch does exactly the thing that rule names. These are unauthenticated-by-
default route handlers inside the customer-facing Next.js app, plus a WebSocket
endpoint and an extension that drives the browser — a remote-control surface on
the same origin that serves checkout. The blast radius is the storefront itself,
so the question is not style: it is whether a public deployment would expose
context read/write and event streaming to anyone who can reach the domain.

**Do not merge it without a security review that establishes, at minimum:**

1. Whether the routes ship in a production build at all, or are dead-coded out.
2. Auth on every handler, including the `ws` upgrade path.
3. What `contexts` can read or mutate, and whether any of it reaches order,
   customer or payment data.
4. Whether the extension can be pointed at the production origin.

**Recommended default:** move the whole surface out of `website/src/app` and run
it as a separate development-only process, which is what the working agreement
already prescribes. That removes the question rather than answering it.

**Not investigated here.** This lane read the branch's file list only; no code on
it was reviewed, run, or modified.

---

# Added 2026-08-28 — overnight polish pass

Found while walking the store as a customer and as the owner, and while
measuring the admin surfaces against a local harness seeded with **20,000
orders**. Everything in this section was verified by measurement or by a
production query; none of it was changed, and each entry says why.

The fixes that WERE made that night are in the git history on `main`
(`0b4b9a2`, eight commits) — this section is only what was deliberately left.

---

## PLB-11 — Eleven duplicate index pairs, and two repo files that disagree about them

**Severity:** P3 · real · write-path cost on the hottest tables
**Where:** production schema; `src/lib/sql/supabase-advisor-remaining-fixes.sql`
vs `src/lib/sql/supabase-performance-advisor-verification.sql`

**What is wrong.** Eleven pairs of exactly-equivalent indexes exist in
production. Every INSERT maintains both members of each pair, and two of the
pairs are on `orders` — the table every checkout writes to:

```
admin_credentials   admin_credentials_username_key | idx_admin_credentials_username
admin_sessions      admin_sessions_token_hash_key  | idx_admin_sessions_token_hash
ambassadors         ambassadors_referral_code_key  | idx_ambassadors_referral_code
order_shipments     order_shipments_order_id_key   | idx_order_shipments_order_id
orders              idx_orders_bulk_discount_tier  | idx_orders_bulk_tier
orders              idx_orders_customer_email      | orders_customer_email_idx
partners            partners_auth_user_id_key      | idx_partners_auth_user_id
partners            partners_referral_code_key     | idx_partners_referral_code
product_doses       product_doses_..._key          | idx_product_doses_product_slug_suffix
products            products_slug_key              | idx_products_slug
referral_orders     referral_orders_order_id_key   | idx_referral_orders_order_id
```

Confirmed interchangeable, not merely similar: `pg_stat_user_indexes` shows the
planner using BOTH members of most pairs, which is what identical indexes look
like in use.

**Why it was not fixed.** The repository already contains the fix and already
contradicts itself about it:

* `supabase-advisor-remaining-fixes.sql` defines a `drop_index_if_exact_duplicate`
  helper — which only drops an index when an exact equivalent survives — and
  calls it for nine of these eleven. It has never been applied, or was applied
  and then undone.
* `supabase-performance-advisor-verification.sql` **asserts that ten of the very
  indexes that file drops still exist.** Applying one file fails the other.
* `deploy-run-once.sql` and `schema-complete-sync.sql` recreate them with
  `create index if not exists`, so a drop is undone by the next deploy run
  unless those files change too.

Resolving that contradiction means editing nine schema files and deciding which
of the two contradictory records is authoritative. That is a schema decision for
the owner, not an overnight touch-up, and the cost of leaving it is a few
percent of insert time — not a defect.

**Recommended:** decide that `supabase-advisor-remaining-fixes.sql` is
authoritative, apply its section 2, delete the ten assertions from the
verification file, and remove the duplicate `create index` lines from
`deploy-run-once.sql`, `schema-complete-sync.sql`, `orders-schema.sql`,
`partner-system-repair.sql`, `affiliate-program-schema.sql`,
`partner-portal-schema.sql`, `membership-billing.sql` and both
performance-advisor files.

---

## PLB-12 — `/admin` costs 2.0s at 20,000 orders, and the admin layout costs ~0.35s on every page

**Severity:** P2 · real · owner-facing, scales linearly with lifetime orders
**Files:** `src/lib/admin-reconciliation.ts:101`, `src/lib/fulfillment-queues.ts:227`

**Measured** on the local harness with 20,000 paid orders, production build:

```
/admin                    2.0s   (was 3.0s before the reads were parallelised)
/admin/reconciliation     2.4s
/admin/revenue            1.5s
every other admin page   ~0.4s   <- the shared layout's cost
storefront pages         ~0.03s  <- for comparison; customers are unaffected
```

Two lifetime scans of `orders` drive it. `getReconciliationFlags` reads EVERY
order of every status to compute the flag badge, and `getBucketCounts` reads
every paid order on the shared admin layout, so it is paid once per admin page
load. Both are correct — both page to exhaustion and report `truncated` — they
are simply proportional to lifetime orders. At 100k orders this is ~10s and ~2s.

**Why it was not fixed.** `fulfillment-queues.ts:186-200` already documents the
answer and calls it what it is: *"A store that sustains more than 25,000 live
paid orders needs the exception predicates pushed into SQL, which means moving
the rules out of `fulfillment-buckets.ts` and is a design decision, not a
constant."* The same holds for the reconciliation rules. Moving both rule sets
into SQL is real design work with real risk of the SQL and the TypeScript
drifting apart — not an overnight change, and not a defect today at 19
production orders.

**What WAS done:** `/admin` now issues its twelve reads in one round instead of
three, which is pure restructuring and cut 3.0s to 2.0s.

---

## PLB-13 — Admin list pages render one anchor per page of results

**Severity:** P3 · real · admin-only, 2,000 DOM nodes at 50k orders
**Files:** `src/app/admin/orders/page.tsx:125` and four sibling list pages

`{Array.from({ length: result.pageCount }, ...)}` emits a full `<Link>` per page
with no windowing, and `pageCount` comes straight from the row total with no
clamp (`admin-orders.ts:138`). At 50,000 orders and 25 per page that is 2,000
anchors on one page.

**Why it was not fixed.** It touches five pages' markup for an admin-only
cosmetic problem, which is more churn than a polish pass should spend. The fix
is a standard windowed pager (first, last, and ±2 around the current page).

---

## PLB-14 — A declined card is a dead end with no retry control

**Severity:** P3 · real · revenue recovery
**File:** the secure-payment page, `/checkout/pay/[orderId]`

The decline copy is genuinely good — *"That payment did not go through, and your
card has not been charged. This is usually the bank declining the transaction
rather than a problem with your order. Refresh to try again, or use a different
card."* — and the behaviour behind it is completely correct. Verified end to end
by driving a real `payment.failed` through the live webhook path: order
`payment_failed`, reservation `released`, stock returned to 25 with
`reserved_quantity` 0, `inventory_committed_at` still null, zero
`referral_orders` and zero `commissions` rows, no confirmation email queued, and
the coupon's `redemptions_count` NOT burned — a customer whose card declines
does not lose their coupon.

But the only way to act on it is the browser's own refresh button. There is no
"Try again" control and no link back to the cart, and a declined card is one of
the highest-value recovery moments a store has.

**Why it was not fixed.** It is adding new UI, not repairing something broken —
feature work rather than polish.

---

## PLB-15 — Supabase Auth leaked-password protection is still off

**Severity:** P3 · real · not reachable from this session's tooling

A Supabase **project setting** (Authentication → Passwords → "Prevent use of
leaked passwords"), not schema and not code, so no migration or commit can turn
it on. It has to be switched on in the Supabase dashboard.
