# Spin to win — design

Status: awaiting review. Requested via chat 2026-09-16.

## Goal

A win-back email sends a lapsed customer to a wheel. They spin once, land on
one of sixteen prizes, and get a single-use offer bound to their address that
expires in 72 hours. Every spin wins. Every prize redeems only through normal
checkout, on an order at or above that prize's minimum.

The point is to give a lapsed buyer a reason to come back that costs less and
feels bigger than the flat percentage a win-back email normally leads with.

## The finding that shapes this design

**The prize engine already exists.** `customer_offers` is a per-address,
single-use, expiring offer with a minimum-subtotal gate, atomic
reserve/redeem/release RPCs, and a partial unique index enforcing one live
offer per `(offer_key, email)`. It already carries every reward shape the
wheel needs:

| Wheel prize | `reward_kind` | Fields |
|---|---|---|
| Free vial | `free_product` | `product_slug`, `quantity` |
| Free shipping | `free_shipping` | — |
| 15% / 20% off | `percent` | `percent_off` |

`quoteOrder` already prices these. `OFFER_CATALOG`
(`src/lib/offers/customer-offers.ts:87`) already holds a `winback_60_*` family
built on exactly this reasoning — its own comments cost GHK-Cu at $3.65
against $39.99 and argue that "the efficient recovery offer is MORE PRODUCT and
LESS DISCOUNT".

So this is not a new discount system. **It is a draw plus a UI over machinery
that is already load-bearing in cart recovery.**

## What already exists (reused, not rebuilt)

- **`customer_offers`** (`src/lib/sql/customer-offers.sql`) — the offer row.
  `min_subtotal_cents`, `expires_at`, `reward_kind`, `product_slug`,
  `percent_off`, `gift_items`, plus `reserved_*` / `redeemed_*` / `revoked_at`
  lifecycle columns. Token stored only as a hash.
- **`issueResolvedOffer()`** (`customer-offers.ts:380`) — mints an offer from a
  reward resolved at call time rather than from a static catalogue key. This is
  what campaign gifts use, and it is what the wheel needs: one campaign key,
  sixteen possible rewards.
- **`reserveCustomerOffer()` / the reserve-redeem-release RPCs** — atomic hold
  for an in-flight checkout, permanent consume on payment, release on
  abandonment. Refuses an offer belonging to another address.
- **`quoteOrder`** (`src/lib/quote-order.ts`) — the single authoritative pricing
  pass. Already resolves a customer offer's gift, percentage and shipping
  waiver, and already runs the profit-floor guard that refuses any order below
  break-even.
- **`OFFER_COOKIE`** (`vl_offer`) — carries the offer token from landing page to
  checkout.
- **Campaign gift validation** (`src/lib/offers/campaign-gift.ts`) —
  `GIFT_MAX_MIN_SUBTOTAL_CENTS`, `GIFT_MAX_TTL_DAYS`,
  `GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS`, and `campaignOfferKey(campaignId)`.
- **The lifecycle sweep** (`/api/cron/sweep` → `runCampaignSweep`) — the cron
  that will select lapsed customers and send the email.

## Scope

**In:** the prize table, the draw, the spin API, the wheel page, the email
hook, and the terms/odds disclosure.

**Out (deliberately):** storefront popup entry (the 21+ age gate already
interstitials new visitors; a second one is worse UX and this campaign targets
people whose address you already hold), weighted odds, losing wedges, any prize
redeemable without an order.

## No new tables

The `(offer_key, email)` unique index — live rows only — already expresses
"one spin per person per campaign" if every prize shares **one** campaign
offer key. So the wheel issues through `issueResolvedOffer` with
`offer_key = campaignOfferKey(<wheel campaign id>)` and the drawn prize's
reward, and the database enforces the one-spin rule with no ledger of its own.

"Have they already spun?" is a lookup of the live-or-redeemed offer for that
`(offer_key, email)`. The slice to animate to is derived from the stored
reward. Two slices carry an identical reward (15% off appears twice) so a
returning visitor may be animated to the other one — cosmetic, and not worth a
column.

If per-spin analytics beyond redemption rate are wanted later, that is a
reporting view over `customer_offers`, not a table this feature needs now.

## The prize table

Sixteen slices, each a true 1-in-16 draw. Retail and cost are live Admin
values as of 2026-09-16.

| # | Prize | `reward_kind` | Min order | Retail | Cost | Cost/min |
|---|---|---|--:|--:|--:|--:|
| 1 | Free Recon Water 10mL | `free_product` `recon-water` | any | $14.99 | $1.43 | — |
| 2 | Free shipping | `free_shipping` | any | $15.00 | $7.93 | — |
| 3 | 15% off | `percent` 15 | any | — | ~$21 | — |
| 4 | 20% off | `percent` 20 | any | — | ~$28 | — |
| 5 | 15% off | `percent` 15 | any | — | ~$21 | — |
| 6 | Free GHK-Cu 50mg | `free_product` `ghk-cu` | $75 | $39.99 | $3.65 | 4.9% |
| 7 | Free MT-2 10mg | `free_product` `mt-2-melanotan-ii` | $75 | $39.99 | $5.30 | 7.1% |
| 8 | Free GLP-1 5mg | `free_product` `glp-1` | $99 | $44.99 | $3.83 | 3.9% |
| 9 | Free GLP-2 5mg | `free_product` `glp-2` | $99 | $49.99 | $4.38 | 4.4% |
| 10 | Free GLP-3 5mg | `free_product` `glp-3` | $99 | $49.99 | $6.32 | 6.4% |
| 11 | Free Semax 10mg | `free_product` `semax` | $99 | $49.99 | $5.86 | 5.9% |
| 12 | Free CJC-1295 + Ipamorelin | `free_product` `cjc-1295-ipamorelin` | $125 | $69.99 | $11.12 | 8.9% |
| 13 | Free HGH GH-191 24iu | `free_product` `hgh-gh-191` | $125 | $64.99 | $12.00 | 9.6% |
| 14 | Free Tesamorelin 10mg | `free_product` `tesamorelin` | $150 | $74.99 | $20.33 | 13.6% |
| 15 | Free GLOW 70mg | `free_product` `glow` | $175 | $109.99 | $21.54 | 12.3% |
| 16 | Free KLOW 80mg | `free_product` `klow` | $200 | $119.99 | $25.07 | 12.5% |

Average prize: **feels like $50.93, costs $12.42**, against a live AOV of
$140.07 (18 paid orders; median $97.48, p90 $319.68).

**Minimums follow a rule, not taste.** Hard floor: a gift's cost must stay
under 20% of its minimum — every row above clears it. Default: minimum ≈ 2×
the gift's retail. The top two slices sit below that default on purpose, so the
jackpot stays reachable against a $97 median basket.

**Doses.** Multi-dose products (`glp-1`, `glp-2`, `glp-3`, `bpc-157`, `nad`,
`hgh-gh-191`) must pin the exact dose the prize grants — the 5mg and 24iu
entries above, not the parent default. `customer_offers` carries a `variantId`
in `gift_items`; the single-product path pins by slug alone, so the plan must
confirm which dose a bare `product_slug` resolves to before relying on it.

## Architecture

```
Lifecycle sweep (/api/cron/sweep → runCampaignSweep)
  └─ selects customers with no paid order in 60 days
       └─ email carries /spin?t=<token>
            t = base64url( email | campaignId | HMAC-SHA256(email|campaignId, SPIN_SECRET) )
            Stateless — no row exists until they actually spin.

GET /spin  (page)
  ├─ verify token (constant-time compare); invalid → generic "link expired"
  ├─ look up live-or-redeemed offer for (campaignOfferKey, email)
  │    found    → render the wheel already resolved, showing their prize
  │    not found → render the wheel ready to spin
  └─ age gate + research-use disclaimers apply as on any customer-facing page

POST /api/spin  { t }
  ├─ rate limit by IP (checkRateLimit, as /api/ads/funnel-event does)
  ├─ verify token → email, campaignId
  ├─ re-check for an existing offer → return it unchanged (never re-draw)
  ├─ drawPrize()  ── uniform 1-in-16, crypto.randomInt, SERVER SIDE
  ├─ issueResolvedOffer({ email, offerKey, reward, minSubtotalCents, ttlHours: 72 })
  ├─ set OFFER_COOKIE
  └─ 200 { sliceIndex, label, minSubtotalCents, expiresAt }

Client animates to sliceIndex, reveals the prize card + countdown.

Checkout — unchanged. quoteOrder reads the offer cookie, prices the gift or
percentage, enforces min_subtotal_cents, runs the profit guard. The
reserve/redeem RPCs hold and consume it.
```

**The server draws before the wheel moves.** The client is told where to land;
it never decides. Client-side randomness means refresh-until-KLOW.

## Anti-abuse

- **One spin per address per campaign**, enforced by the existing partial
  unique index rather than by application logic.
- **Re-POSTing `/api/spin` returns the same prize**, because the existing-offer
  check precedes the draw. Idempotent by construction.
- **The token is an HMAC**, not a guessable id. Anyone holding the link can
  spin as that address — the same exposure as any emailed coupon link, and
  acceptable for the same reason. Worth stating, not worth defending against.
- **Rate limit** on the spin route.
- **The offer is bound to the address**; the reserve RPC already refuses an
  offer belonging to another email.
- **Nothing ships without an order**, so the 21+ gate and the three
  research-use acknowledgements fire on a free vial exactly as on a paid one.

## Compliance

Every prize requires a purchase, and no wedge loses. That keeps this a
discount reveal rather than a sweepstakes — no official rules, no free-entry
route, no state prize registration. The structure is load-bearing, so it must
not be softened later into "free product, no purchase" without counsel.

The page carries a terms link stating: every spin wins; each prize is 1-in-16;
one spin per customer; prizes expire 72 hours after the spin; each prize
requires the minimum order shown; no cash value; not transferable.

**Wedge and email copy goes through the `vanta-creative-director` skill.**
Slice labels are product names and dose only — no benefit language of any
kind, per `CLAUDE.md` and the research-use-only positioning.

## Testing

TDD, per `CLAUDE.md`. Vitest, colocated as this repo does.

- `drawPrize()` is uniform across sixteen slices and reads from the same table
  the wheel renders — a structural test asserts the rendered slice count,
  labels and minimums match the prize table exactly. A wheel that advertises
  what checkout will not honour is the failure mode this repo has already
  designed against elsewhere.
- A second POST returns the first prize, not a new draw.
- An order below a prize's minimum does not receive the gift.
- An expired offer does not apply.
- The free-shipping prize applies below $200 and is a no-op at or above it.
- A prize for another address is refused.
- Every prize's cost is under 20% of its minimum — a guard test, so a future
  price edit that breaks the rule fails CI rather than margin.

Browser verification against the local harness per
`website/docs/BROWSER-TESTING-RUNBOOK.md`, **not** `npm run dev`. Checked at
390×844, which is where most of this traffic will land.

## Open questions

1. **Tesamorelin is 5 units in stock**, against 13–54 for everything else. At
   1-in-16 it will be won faster than it can ship. Restock before launch, or
   swap for Kisspeptin 10mg ($74.99, $8.98 cost, 19 in stock). **Needs a
   decision before launch, not before implementation.**

2. **Percent caps are not expressible today.** The agreed design caps 15% at
   $30 and 20% at $40, but `customer_offers` has `percent_off` and no
   maximum-discount column. Either add one (a nullable
   `max_discount_cents`, read by `quoteOrder` where the percentage is applied)
   or ship uncapped. At the live AOV of $140 a cap almost never binds; at the
   p90 of $319.68 an uncapped 20% is $63.94 against a $40 cap. **Recommend
   adding the column** — it is small, and it is the only uncapped exposure on
   the wheel.

3. **Does a wheel gift stack with an ambassador or referral discount?**
   `quoteOrder` resolves a single best discount, but a gift is not a discount
   and may sit outside that resolution. The plan must establish the current
   behaviour before choosing one, rather than assuming either way.

4. **Gift inventory.** Whether a free-vial line reserves stock the way a
   purchased line does needs confirming in `quoteOrder` /
   `reserveInventoryForOrder`. If it does not, a winner can redeem a vial that
   is already sold.

5. **Free shipping is $200** (admin audit log, set 2026-08-23), not the $250
   in `PRICING_STRATEGY.md`. That doc is stale and should be corrected
   separately. Consequence here: slice 2 is worth nothing to anyone spending
   $200+, and slice 16 requires exactly $200, so KLOW winners never pay
   postage. Accept, or make slice 2 a priority-shipping upgrade so it has
   value at every basket size.

6. **Campaign cadence.** 60 days lapsed is assumed from the existing
   `winback_60_*` family. Confirm that is the intended audience, and whether
   the wheel replaces those offers for that segment or runs beside them.
