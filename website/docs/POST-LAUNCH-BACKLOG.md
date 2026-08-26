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
| PLB-04 | P3 | the probe degrades correctly; the offers bar renders | apply `coupon-storefront-fields.sql` |

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

