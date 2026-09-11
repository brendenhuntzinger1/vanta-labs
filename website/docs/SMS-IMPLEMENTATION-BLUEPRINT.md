# Vanta Texts — implementation blueprint

**Status:** blueprint for approval. **No production code written.**
**Date:** 2026-09-11 · **Supersedes nothing; extends** `SMS-LIFECYCLE-STRATEGY.md`
**Source of truth:** production code at `website/src` and the live database, both read 2026-09-11.

> Where this document and the strategy document disagree, this one wins — it was
> written against verified production behaviour. Conflicts are flagged inline as
> **⚠ CONFLICT**.

---

## 0. Two findings that change your decisions

Both verified in source. Read these before the architecture.

### ⚠ CONFLICT 1 — the gift cuts ambassador commission too, through a path a naive fix will miss

Your decision 4 says preserve ambassador commission when a separate SMS incentive wins.
I found that a free-product gift **already reduces commission**, and not the way the 15%
did.

`quote-order.ts:910-947` — *"A GIFT OF SOMETHING ALREADY IN THE CART FREES THOSE UNITS."*
When the gift product is already in the basket, the paid line's quantity is **decremented**
and the units move to a $0 gift line. That reduces **`subtotal` itself**, not
`discount_amount`.

Commission is `commissionableSubtotal = max(0, subtotal − discount_amount)`
(`payment-webhook.ts:1038`). So:

| Case | subtotal | discount_amount | commission base |
|---|---|---|---|
| Gift added (not in cart) | unchanged | unchanged | **unaffected** ✅ |
| Gift **absorbs** a unit already in cart | **−$39.99** | unchanged | **−$39.99** ❌ |

A fix that restores commission by adding back `discount_amount` **will not catch the absorb
case.** The correct base is a new, explicitly-computed `commissionableBase`.

**Decided (D1, §13). The formula, and the proof that it neither double-counts nor changes
non-SMS orders, is in §B1–B4.** Two further findings surfaced while proving it —
`commissionableSubtotal` is shared with **points earning and refund proration** (§B1), and
gift absorption can **silently cost a Vanta Pro member their store credit** (§B5).

### ⚠ CONFLICT 2 — the strategy doc said "build one benefit engine". Production already has one

`quoteOrder()` (`quote-order.ts:457`) is already the single authoritative pricing pass. It
is re-run at order creation (`payment-service.ts:115`) and refuses underpayment. Its
`QuoteResult` already carries line items, subtotal, shipping, `discountAmount`, `referral`,
`couponCode`, `appliedOffer`, `discountLabel` and `profitFloor`.

**So the deliverable is not a new engine. It is closing four holes in the existing one.**
Four costs are decided *outside* `quoteOrder` and no single value answers "is this order
economically acceptable":

| Cost | Decided where | Visible to the floor snapshot? |
|---|---|---|
| Ambassador commission | `payment-webhook.ts`, after payment | Partially — `computeProfit` models it, the snapshot is built with `components: []` |
| Store credit | `quote-order.ts`, after the floor block | **No** |
| Loyalty points | `quote-order.ts`, after the floor block | **No** |
| Gift COGS | never | **No** |

Building a parallel engine would create exactly the second source of truth you told me to
avoid. **The plan is to extend, not replace.**

---

## 1. Proposed architecture — the entitlement layer

One new pure module, two new types, and one call site inside `quoteOrder`. Nothing existing
is rewritten.

```
                    ┌─────────────────────────────────────────┐
                    │  resolveEntitlements()      PURE, NEW    │
                    │  "what is this customer entitled to?"    │
                    │                                          │
  membership ──────►│  collects every candidate benefit from   │
  sms membership ──►│  every source into ONE list, each with   │
  referral ────────►│  { kind, value, costToVanta, stacks,     │
  coupon ──────────►│    attribution, tieBreakIndex }          │
  bundle / BXGY ───►│                                          │
  customer_offer ──►│  then DELEGATES the contest to the       │
                    │  EXISTING resolveCustomerDiscount()      │
                    └──────────────────┬──────────────────────┘
                                       │ BenefitDecision
                    ┌──────────────────▼──────────────────────┐
                    │  computeOrderEconomics()    PURE, NEW    │
                    │  "what does this order actually leave?"  │
                    │  revenue − COGS − giftCOGS − processing  │
                    │    − commission − postage − credit       │
                    │    − points                              │
                    │  → { contributionCents, acceptable }     │
                    └──────────────────┬──────────────────────┘
                                       │
                         quoteOrder() ─┴─► QuoteResult (+ two new fields)
```

**`resolveEntitlements()` does not re-implement the contest.** It assembles candidates and
calls `resolveCustomerDiscount()` exactly as `quoteOrder` does today. The contest logic,
its tie-break order, its `compete()` netting and its two coupon-stacking licences are
**untouched**. This is what keeps `cart-server-discount-parity.test.ts` meaningful.

### The one question, answered

```ts
type BenefitDecision = {
  entitled:    Benefit[];       // everything the customer qualifies for
  winner:      Benefit | null;  // what controls the price (from the existing contest)
  stacked:     Benefit[];       // what legitimately rides alongside (shipping, gift, credit)
  suppressed:  Array<{ benefit: Benefit; reason: string }>;  // and WHY — for the admin
  costCents:   { discount; giftCogs; shipping; storeCredit; points; commission };
  attribution: { marketingSource; ambassadorId; commissionableBaseCents };
  economics:   OrderEconomics;  // contributionCents + acceptable + bindingConstraint
};
```

**`suppressed` is the load-bearing field.** Today, when a benefit loses, it vanishes
silently — which is why the coupon copy was wrong for months until
`describeCouponOutcome()` was written. Recording *why* each benefit lost gives the admin,
the customer copy and the tests one shared explanation.

### Where the cart gets its half

The cart must see the same entitlements or it previews a total the card does not charge.
**No new endpoint.** `/api/account/me` already returns `memberDiscountPercent` and is
already the cart's source (`cart-context.tsx:1408`). SMS entitlement is added to that same
response. A second endpoint is a second staleness window.

---

## 2. Database and schema changes

All additive. Two existing tables take nullable columns. No table is renamed or dropped.
Convention: hand-written idempotent SQL in `src/lib/sql/`, RLS enabled with no policies
(deny-by-default, service-role only), receipt in `src/lib/sql/migrations-applied/`.

### New tables

```sql
sms_subscribers
  phone_e164            text primary key          -- E.164 only, ever
  user_id               uuid references auth.users(id) on delete set null
  status                text not null             -- pending|verified|opted_out|blocked
  verified_at           timestamptz
  verify_attempts       integer not null default 0
  last_verify_at        timestamptz
  marketing_consent     boolean not null default false   -- NEVER defaults true
  marketing_consent_at  timestamptz
  transactional_consent boolean not null default false   -- separate, see §6
  consent_source        text                      -- back_in_stock|account|checkout|post_purchase|popup
  disclosure_version    text                      -- FK-ish to the versioned copy
  opted_out_at          timestamptz
  opt_out_keyword       text
  resubscribed_at       timestamptz
  resubscribe_count     integer not null default 0
  line_type             text                      -- from Twilio Lookup: mobile|voip|landline
  carrier               text
  created_at / updated_at

sms_consent_events        -- APPEND ONLY. The legal evidence. No UPDATE, no DELETE.
  id, phone_e164, event, disclosure_version, exact_copy_shown,
  ip, user_agent, source_url, twilio_message_sid, user_id, created_at
  -- event: disclosure_shown | verify_sent | verified | marketing_granted
  --        | marketing_revoked | resubscribed | suppressed_by_migration

sms_suppressions
  phone_e164 text primary key, scope text not null, reason text, created_at
  -- scope: 'marketing' | 'all'   ← see §6, this is why two numbers matter

sms_send_log              -- deliberately mirrors email_send_log column-for-column
  id, campaign_type, reference_id, phone_e164, template_key, sent_at,
  status, twilio_message_sid, segments, price_cents, delivered_at,
  failed_at, error_code, clicked_at
  unique (twilio_message_sid)

sms_delivery_events       -- Twilio status callbacks, ignoreDuplicates upsert
  twilio_message_sid, status, error_code, raw, received_at

sms_link_clicks           -- first-party short links only. NEVER a public shortener
  id, sms_send_log_id, phone_e164, path, clicked_at, user_agent
```

### Altered tables — minimal

```sql
-- back_in_stock_requests: ONE request row, two channels. Not a second table.
alter table public.back_in_stock_requests
  add column if not exists phone_e164 text,
  add column if not exists notify_sms boolean not null default false;
-- The existing unique index on (product_slug, coalesce(variant_id,''), email)
-- where notified = false is UNCHANGED and still correct: one person, one
-- request, notified once on whichever channels they chose. A parallel SMS
-- table would notify the same person twice.

-- orders: attribution + audit. Both nullable, both write-once.
alter table public.orders
  add column if not exists sms_attributed_send_id uuid,
  add column if not exists sms_benefit_cost_cents integer;
```

### Reusing `abandoned_cart_emails` for the SMS stage

**Recommended: reuse it. Do not create a parallel table and do not rename it.**

`abandoned_cart_emails` has `unique (abandoned_cart_id, stage)`. That index *is* the
one-send-per-stage-per-cart claim that `reserveAndSendStage` depends on, and it is the fix
for incident C-06. Adding `stage = 'sms_t4h'` inherits:

- the atomic claim, so a coarser cron can never double-send;
- `selectDueStage`'s one-stage-per-cart-per-tick rule;
- `MIN_STAGE_GAP_MS` (8h) spacing against the email stages;
- purchase suppression via `markAbandonedCartsRecovered`, for free.

A parallel `abandoned_cart_sms` table would sit outside all four and reintroduce every race
those guards exist to stop.

**Cost:** a table named `..._emails` holds an SMS row. That is a naming wart, and it is the
correct trade. Renaming a live table with an FK and a load-bearing unique index is the kind
of coordinated migration `DATABASE.md` Appendix A explicitly defers. Add a comment at the
table and in `cart-recovery.ts` saying why.

---

## 3. Consent records and proof requirements

A defensible consent record answers: *who, what number, what exact words, when, from where,
and prove the number was theirs.*

| Element | Stored | Why |
|---|---|---|
| Phone, E.164 | `sms_subscribers.phone_e164` | Normalised once, at the edge |
| Marketing consent + timestamp | `marketing_consent`, `_at` | The consent itself |
| **Exact copy shown** | `sms_consent_events.exact_copy_shown` | Not a version pointer to text that may later change — the literal string |
| Disclosure version | `disclosure_version` | Cross-reference to the versioned block |
| Source URL + collection point | `source_url`, `consent_source` | Where they were standing |
| IP + user agent | `ip`, `user_agent` | Corroboration |
| Verification event | event `verified` + `twilio_message_sid` | **Proof the number was theirs** |
| Account, if any | `user_id` | Ties consent to an identity |

**Rules.** `sms_consent_events` is append-only — no UPDATE, no DELETE, enforced by
convention and asserted by a test. Consent is never inferred: no row, no marketing. The
`exact_copy_shown` column stores the literal rendered string, because a version number
pointing at editable copy proves nothing a year later.

**Gap worth noting:** today's *email* consent records only a `source` string and
`opted_in_at` — no IP, no copy, no version. The SMS design is strictly better. Backporting
it to email is a good idea and is **explicitly out of scope here** (§15).

---

## 4. Suppression architecture

Three layers, fail-closed, modelled on the email suppression design which already fails
closed (`marketing.ts:205-212` refuses a send when the suppression read errors).

1. **Seed layer — the migration.** The first migration inserts every phone number already
   in the database into `sms_suppressions` with `scope='marketing'`,
   `reason='pre_consent_migration'`, and writes a matching `sms_consent_events` row. Sources:
   `orders.phone`, `ambassadors.phone`, `partners.phone`, `customer_preferences.phone`.
   Measured today: **~35 distinct numbers.** This implements your decision 5 as a row, not a
   policy.
2. **Audience layer.** Any audience read subtracts suppressions **last**, so presence in a
   consent store can never win. Truncation is fatal (`AUDIENCE_TRUNCATED`), copying
   `audience.ts:26`.
3. **Per-send layer — the guarantee.** `sendSms()` re-checks suppression immediately before
   dispatch and **refuses on a read error**. This is the layer that actually holds; the
   other two make the admin's counts honest.

**Leaving suppression** requires completing verification *and* an explicit marketing grant.
There is no admin button to bulk-unsuppress, and that is deliberate.

---

## 5. Subscriber state machine

```
                         ┌──────────┐
    phone submitted ────►│ pending  │
                         └────┬─────┘
             code verified    │         verify expired / 5 failed attempts
                              ▼                      │
                        ┌───────────┐◄───────────────┘ (back to pending)
                        │ verified  │  transactional OK · marketing NOT yet
                        └─────┬─────┘
        marketing box ticked  │              STOP / admin / hard bounce
                              ▼                        │
                     ┌──────────────────┐              │
                     │ marketing_active │──────────────┤
                     └──────────────────┘              ▼
                              ▲                 ┌─────────────┐
                 START + cooldown elapsed ──────│ opted_out   │
                                                └─────────────┘
                                                       │ repeated abuse
                                                       ▼
                                                 ┌──────────┐
                                                 │ blocked  │ terminal, admin only
                                                 └──────────┘
```

**Invariants, each with a test:**

- `marketing_active` requires `status='verified'` **and** `marketing_consent=true` **and**
  no `scope IN ('marketing','all')` suppression. Three conditions, checked together, in one
  function — never re-derived at a call site.
- `verified` alone never sends marketing. This is the single most important rule in the
  system.
- `opted_out → marketing_active` requires a fresh consent event. Re-subscribing is a new
  consent, not a flag flip.
- `blocked` is terminal and only an admin can set it.

---

## 6. Transactional vs marketing separation

Two Twilio Messaging Services, **two phone numbers**, two campaign registrations.

| | Transactional | Marketing |
|---|---|---|
| Number | 813-A | 813-B |
| A2P campaign | Customer Care / 2FA | Marketing — **register second** |
| Consent | `transactional_consent` | `marketing_consent` |
| Quiet hours | exempt | enforced |
| Frequency cap | exempt | enforced |
| STOP scope | `scope='all'` | `scope='marketing'` |
| Content | order, shipping, delivery, payment failure, verification codes | everything else |

**Why two numbers is not optional.** Twilio's STOP is scoped to *(sender number,
recipient)*. With one number, a customer who opts out of marketing also loses shipping
notifications — which is both bad service and arguably worse compliance, because it
conflates two consents the FCC treats separately. With two, STOP on the marketing number
leaves order notifications intact.

**The rule that prevents the classic violation:** a transactional message may not carry
marketing content. A shipping notice with "20% off your next order" in it **is a marketing
message** and needs marketing consent. Enforced by a copy-lint test over the transactional
templates, mirroring the existing `copy-compliance.ts`.

**⚠ Deliverability note.** Transactional messages are what earn Known Sender status, and
they go out first (phase 4, before any marketing). That ordering is deliberate and should
not be reversed for convenience.

---

## 7. Twilio integration boundaries

Vanta stays the source of truth. Twilio delivers bytes and verifies numbers. Nothing else.

| Owned by **Vanta** | Owned by **Twilio** |
|---|---|
| Consent, suppression, subscriber state | Message transmission |
| Segmentation and audiences | Delivery receipts |
| Frequency caps, quiet hours | Carrier negotiation |
| Message content and scheduling | OTP generation/validation (Verify) |
| Attribution and economics | Line-type lookup |
| Opt-out state of record | Per-number STOP (belt-and-braces only) |

**No Twilio SDK.** Match the repo's hand-written-fetch pattern (Shippo, Resend): one module
owns the HTTP call, nothing throws, every failure returns a typed result carrying
`safeToRetry`, every `fetch` carries `AbortSignal.timeout(...)` — there is a source-text
test enforcing that last one.

Twilio's Advanced Opt-Out stays **on** as a second line of defence, but Vanta's own
suppression is authoritative. We never ask Twilio what a subscriber's state is.

**Credentials** follow the two-tier pattern: env var documented in `.env.example`, layered
under an operator-editable control-store key, sealed with AES-256-GCM under
`ADMIN_CONTROL_SECRET_KEY` (add to `SECRET_CONTROL_KEYS`), redacted on every read path.

---

## 8. STOP / START / HELP, opt-in, and the double-opt-in decision

### Inbound keyword handling

| Input | Action |
|---|---|
| STOP, STOPALL, END, QUIT, CANCEL, UNSUBSCRIBE, REVOKE, OPT OUT, OPTOUT | Suppress at the number's scope, write a consent event, state → `opted_out`. **One confirmation message, then silence.** |
| START, UNSTOP, YES | Only if a prior verified consent exists **and** the cooldown has elapsed → `verified`; marketing still requires a fresh grant |
| HELP, INFO | Identity, contact, opt-out instructions. Always answered, even when suppressed |
| Anything else | Logged, never auto-replied, flagged for review if it reads like revocation |

Free-text revocation ("stop texting me", "remove me") is reviewed — the FCC's 2024 rules
require honouring revocation by any reasonable means. Auto-detect conservatively and route
ambiguous cases to an admin queue rather than guessing in either direction.

**Timing:** honoured immediately in Vanta's state. The regulatory ceiling is 10 business
days; immediate is the only sane implementation and the only one that survives a complaint.

### ⚠ Double opt-in — this is forced, not a preference

Twilio's rules require **text-based double opt-in for abandoned-cart messaging
specifically.** You want cart-recovery SMS (your decision 2). Therefore:

**Recommendation: full double opt-in for marketing, everywhere.**

```
web form → phone → Verify OTP → number proven
        → marketing box ticked → confirmation SMS → subscriber replies YES
        → marketing_active
```

It costs opt-in rate. It buys: cart-recovery eligibility, a cleaner list, a much stronger
consent record, and — via the reply — **a user-initiated inbound message, which is exactly
what earns Known Sender status on a new 813 number.** The deliverability benefit
substantially offsets the conversion cost on a list this small.

**Alternative if you disagree:** single opt-in for everything *except* cart recovery, with
cart recovery gated on a separate double-opt-in flag. More states, more tests, more ways to
get it wrong. I recommend against it. **(D2 in §13.)**

---

## 9. The first-SMS-order gift

### Rules

| Rule | Value | Why |
|---|---|---|
| Trigger | First qualifying order after `marketing_active` | Not on signup — signup costs nothing to fake |
| Reward | Free GHK-Cu (`free_product`) | $3.65 cost, $39.99 shown, 11.0× |
| Minimum subtotal | **$60.00** (`minSubtotalCents: 6000`) | Matches `winback_60_free_ghkcu`; "a little under one full-price unit, so the customer is always spending more than the gift costs" |
| TTL | 30 days | Real offer, bounded liability |
| Uses | Once, ever, per person | |
| Mechanism | `issueCustomerOffer()` — existing | Hashed bearer token, httpOnly cookie, atomic reserve |

**Do not invent a new grant mechanism.** `customer_offers` already gives: sha256-only
storage, `vl_offer` httpOnly SameSite=Lax cookie (never a URL parameter), advisory-lock
reserve at order creation that **refuses the order** if it fails, permanent redemption
keyed on order, `closeCustomerOfferCycle` revoking other live gifts on purchase, and
`revokeUnredeemedOffer` when a send fails.

**⚠ If the free-shipping variant is ever used instead**, `OFFER_CATALOG` records the trap:
the store ships free over $200, so a free-shipping gift with a $200 minimum "silently grants
no discount at all, while still looking like a gift". The minimum has a ceiling as well as
a floor.

### Abuse protection

| Vector | Control |
|---|---|
| One person, many numbers | Gift keyed on **account email**; `customer_offers_one_live_per_email` partial unique index already enforces one live token per person |
| One number, many accounts | `sms_subscribers.phone_e164` is the PK — one row per number. A number already bound to another `user_id` cannot grant a second gift |
| Opt-out → opt-in farming | `resubscribe_count` + cooldown; gift is once-ever, not once-per-subscription |
| Verification flooding / SMS pumping | Rate-limit per phone, per IP, per account; Twilio Fraud Guard on; **block `line_type='voip'`** at signup |
| Gift with nothing else in basket | `min_subtotal_cents`, re-judged by `quoteOrder` on what the customer *actually pays* after every other discount |
| Redeem → refund → redeem | Already impossible: redemption is permanent by design |

### ⚠ The gift's real economic edge case

`min_subtotal_cents` is judged on the post-discount total. On a $60 order where the gift
**absorbs** a $39.99 GHK-Cu already in the cart, paid subtotal falls to ~$20 — below the
minimum — and `quoteOrder:1287-1340` **withdraws the whole gift and gives the units back.**
That is correct behaviour and it will look strange to a customer who added GHK-Cu
deliberately. Copy must set the expectation ("on orders of $60 or more, after discounts").

---

## 10. The benefit interaction matrix

This is the deterministic table your decision 3 and 4 require. **Precedence is unchanged
from production** — I am documenting it, not altering it.

### What competes (one wins, greatest savings)

Push order **is** the tie-break; both resolvers must match exactly.

```
1. bundle / Buy-X-Get-Y  (or the bundle+coupon package)
2. referral
3. membership (Vanta Pro)
4. bulk savings
5. ambassador personal
6. coupon                 ← last, so a tie goes to the offer they didn't have to type
```

**The SMS gift adds no candidate to this list.** A `free_product` reward changes line items,
not the discount race. **This is the single best property of the gift design** — it cannot
cannibalise Vanta Pro, because it never competes with it. Your decision 3 is satisfied
structurally rather than by a rule someone has to remember.

### What stacks (outside the race)

| Benefit | Stacks | Gate |
|---|---|---|
| Free shipping | yes | `isShippingWaived` — deliberately outside |
| SMS gift (`free_product`) | yes | `min_subtotal_cents`, once ever |
| Store credit | yes | blocked when `referralDiscountApplied` |
| Loyalty points | yes | blocked when `referralDiscountApplied` |
| Ambassador commission | always | never a customer discount — see below |

### ⚠ The bound your decision 4 needs

Preserving commission **and** guaranteeing no unprofitable order are in mild tension. With
a $3.65 gift the tension is small, but it is not zero: gift + free shipping + 20% commission
tier + store credit + points on a small basket still goes negative.

**Proposed deterministic rules — all four, or none of them work:**

1. **Commission base is explicit.** New `commissionableBaseCents` = paid subtotal **+** the
   winning discount **+** the retail value of absorbed gift units. The ambassador is paid on
   what the customer would have spent absent incentives they did not provide. *(Resolves
   CONFLICT 1. Costs more than today — see D1.)*
2. **Store credit and points are blocked when an SMS gift applied**, exactly as they are
   blocked on a referral win. Same gate, same reason, one new condition.
3. **The gift's minimum is evaluated after every other discount** — already true, keep it.
4. **`computeOrderEconomics()` returns `acceptable: false`** when contribution after *all*
   costs (including credit, points and gift COGS) is negative. It **reports and alerts** —
   it does not refuse the sale, preserving the owner's existing rule (§11).

Rules 1–3 are the *preventive* bound. Rule 4 is the detector for anything they miss.

---

## 11. The profit floor — what changes, and what deliberately does not

**Does not change:** `quoteOrder` still never refuses an order for margin.
`quote-order.ts:1484` records why — the old `throw` refused 8 of 24 ordinary baskets,
including a single $39.99 vial, silently. That decision stands.

**Does change:** `buildProfitFloorSnapshot` currently has **no field for store credit or
points**, and is called with `{ amount: discountAmount, components: [], label: "resolved" }`
— an empty components array. So a credit-funded loss is invisible to the owner's alert.

The fix is to widen the snapshot, not to re-arm the gate:

```
ProfitFloorSnapshot + storeCreditCents + pointsCents + giftCogsCents
                   + commissionCents  + contributionCents
                   + bindingConstraint: 'none'|'margin'|'credit'|'gift'|'commission'
```

`alertIfBelowProfitFloor` then fires on **cash contribution**, not just gross profit. This
is the smallest change that makes your decision 4's "unintended stacking cannot make an
order unprofitable" actually observable.

---

## 12. Lifecycle flows

### Frequency caps — extending the existing claim

`marketing_send_claim` takes `pg_advisory_xact_lock(hashtext('marketing_send:' || email))`.
**The claim is the record, not a lookup.**

**⚠ Safety correction to the strategy document.** It proposed rekeying the lock to a person.
That changes behaviour for *every existing email send*. Safer:

> Add a `person_key text` parameter, **defaulting to the email**. Existing callers pass
> nothing and behaviour is byte-identical. SMS passes the same person key. One migration,
> zero behaviour change until SMS is enabled.

Caps: **1 marketing message per person per 24h across both channels** (the existing
`MARKETING_QUIET_MS`), **max 4 SMS per person per 30 days**, transactional exempt.

### Quiet hours — and the problem nobody mentions

8am–9pm **in the recipient's local time**, with stricter state windows (FL, OK, WA, MD, TX,
OR, CT). Transactional exempt.

**⚠ We do not know the recipient's timezone.** Area code is unreliable — number portability
means a 813 number may live in Seattle. Resolution order:

1. Most recent order's shipping state (available for buyers — the majority here).
2. Account billing state.
3. **Fallback: a continental-safe window.** 12:00–20:00 ET is inside 8am–9pm local for every
   continental US zone. Conservative, correct, needs no data.

Never guess from the area code.

### Abandoned cart — one SMS, inside the existing sequence

```
T+1h    email  stage t30m                      [unchanged]
T+4h    SMS    stage sms_t4h   ← ONE message
T+12h   email  stage t12h                      [unchanged]
T+24h   email  stage t24h  (gift)              [unchanged]
T+72h   email  stage t72h  (gift + percent)    [unchanged]
```

`sms_t4h` sends only if: `marketing_active` · double opt-in complete · **no human click on
stage 1** · cart still open · inside quiet hours · under both caps · the carrier's one-per-
48h rule satisfied.

Purchase suppression is inherited, not rebuilt: `markAbandonedCartsRecovered` already runs
synchronously in the payment webhook's paid transition, and `sms_t4h` is *a stage*, so a
recovered cart stops it by the same mechanism that stops the email stages.

### Back-in-stock — the flagship

Highest-intent moment in the store and the highest-converting SMS flow in the benchmark data
(36–59% CTR). One `back_in_stock_requests` row, `notify_sms` flag, notified once per channel
chosen. **Transactional-adjacent but treated as marketing** — it is a solicitation, requires
marketing consent, and respects quiet hours. Being strict here costs little and removes an
argument.

### Post-purchase

Order confirmation, shipping, delivery, payment failure — **transactional, no marketing
consent required, no quiet hours, no cap.** Marketing content in them is forbidden (§6).
Post-purchase *marketing* (review request, replenishment) stays on email; the customer just
bought, and SMS adds nothing but cost.

### Win-back

One SMS, only after the email win-backs have failed, only for `marketing_active`
subscribers, only for customers with a paid order history. Last in priority, exactly as
`browse_abandonment` is last in the email automation order.

---

## 13. Locked decisions

Decided by the owner, 2026-09-11. Part B proves each one against production.

| # | Decision | **Locked as** |
|---|---|---|
| **D1** | Commission base | **Preserve commission via an explicit `commissionableBaseCents`.** Restores revenue displaced by a Vanta-funded SMS incentive; never double-counts; never increases commission for unrelated reasons. Formula and proof in **§B1–B3** |
| **D2** | Double opt-in | **Full SMS double opt-in.** Consent evidence durable and auditable. Existing order/shipping/ambassador/contact numbers remain **non-marketing** |
| **D3** | SMS-only gift entitlement | **Yes.** A verified SMS subscriber earns the introductory gift **without** email marketing consent and **without** Vanta Pro. Tied to verified person identity, not a browser session. Abuse controls in **§B7** |
| **D4** | Introductory gift | **GHK-Cu 50mg**, subject to pre-launch COGS/inventory verification. **Admin-configurable, never hard-coded** — see §B-D4 |
| **D5** | Store credit + points | **Yes on eligible PAID merchandise. No value from the $0 gift.** Explicit `rewardBaseCents`, immune to gift-driven subtotal mutation. Proof in **§B5** |
| **D6** | Quiet hours | **Real timezone when genuinely known** (order/billing state). **Never inferred from area code.** Unknown → continental-safe **12:00–20:00 ET**, pending compliance sign-off |
| **ARCH** | One engine | **`quoteOrder()` remains authoritative.** No second engine. Phase 3 is a proven no-op refactor; non-SMS behaviour parity-identical |
| **ARCH** | `marketing_send_claim` | **`person_key` defaults to the email.** Email lifecycle unchanged until SMS explicitly uses the new path |

---

## 14. Implementation phases, safest order

Every phase merges with `sms_enabled = false`. Nothing sends until A2P clears.

| Phase | Work | Exit gate |
|---|---|---|
| **0** | Seed `sms_suppressions` from all existing phones. Add Twilio's mobile-number non-sharing sentence to the privacy policy. Scrub storefront copy of indication/dosing language. Register **transactional** campaign | Suppression row count matches the distinct-phone query; policy live |
| **1** | Schema + migrations. E.164 normalisation. Twilio client + Lookup. Webhook with signature validation. Kill switches. **No sending** | Unit + SQL suites; webhook rejects unsigned |
| **2** | Subscriber state machine. Verify flow. Disclosure versioning. STOP/START/HELP. Suppression enforcement | State-machine, consent, STOP, duplicate-number tests |
| **3** | **Entitlement layer** (§1) — with SMS entitlement returning nothing. Pure refactor: same inputs, same outputs, zero behaviour change | **Parity suite green, unchanged.** This is the highest-risk phase — see §16 |
| **4** | Economics: widen the floor snapshot, wire credit/points/giftCOGS/commission, alert on cash contribution | Stacking + profit-combination tests |
| **5** | Collection points: back-in-stock → account → post-purchase → checkout → product-page two-tap | Mobile 390×844 on the local harness |
| **6** | Transactional messages. **Go live once transactional A2P clears** | Live smoke test to one number |
| **7** | The gift. `OFFER_CATALOG` entry, issuance on first qualifying order, eligibility + abuse rules | Gift eligibility, abuse, stacking tests |
| **8** | Marketing sends: frequency cap extension, quiet hours, cart-recovery `sms_t4h`, back-in-stock SMS, win-back. **Requires marketing A2P** | Orchestration + suppression tests |
| **9** | Admin, attribution, analytics, holdout | Nav + permission-matrix tests |

**Phase 3 before phase 7 is deliberate.** The entitlement layer lands as a no-op refactor,
proven by the existing parity suite, *before* anything new rides on it.

---

## 15. Files and tables likely affected

**New** — `src/lib/sms/` (client, verify, subscribers, consent, suppression, keywords,
quiet-hours, send, webhook-verify), `src/lib/benefits/` (entitlements, economics),
`src/app/api/webhooks/twilio/route.ts`, `src/app/api/account/sms/*`,
`src/lib/sql/sms-*.sql`.

**Modified, small and surgical:**

| File | Change |
|---|---|
| `quote-order.ts` | Call `resolveEntitlements()`; widen the floor snapshot. **Do not touch the discount race** |
| `profit-engine.ts` | `ProfitBreakdown` gains credit/points/giftCOGS fields. `resolveCustomerDiscount` **unchanged** |
| `discount-resolution.ts` | Only if a competing SMS benefit is ever added. **Not needed for the gift** |
| `payment-webhook.ts` | Commission base, per D1 |
| `store-credit-redemption.ts` | One new gate condition, per D5 |
| `cart-recovery.ts` | `sms_t4h` in the stage table and `selectDueStage` |
| `back-in-stock.ts` | `notify_sms` branch |
| `api/account/me/route.ts` | Add SMS entitlement beside `memberDiscountPercent` |
| `admin-nav-config.ts`, `admin-roles.ts` | SMS section + permission row (two tests fail without both) |
| `marketing-frequency-guard.sql` | `person_key` parameter, defaulting to email |
| `vercel.json` | **No change** — extend `/api/cron/lifecycle` |

**Explicitly NOT touched (§17).**

---

## 16. Risks and rollback

| Risk | Severity | Mitigation | Rollback |
|---|---|---|---|
| **Phase 3 refactor changes pricing** | **Critical** | Land as a proven no-op; parity suite must stay green with zero edits to its assertions. If a parity test needs changing, the refactor is wrong | Revert one commit; no data migration to undo |
| Cart previews ≠ server charges | Critical | Both halves in one commit; `/api/account/me`, not a new endpoint | Revert |
| Texting a non-consented number | **Critical / legal** | Phase 0 suppression seed; three-layer fail-closed check; `verified` never implies marketing | Kill switch; suppression is already the default state |
| A2P rejection (30941 / 30951) | High | Transactional first; copy scrub before submission; counsel on the ambassador programme | Non-remediable — **this is why phase 0 comes first** |
| Commission change costs more than expected (D1) | Medium | Model against real orders before enabling; feature-flag the new base | Flag off, revert to post-discount base |
| Gift abuse | Medium | Once-ever per email, one row per number, VOIP blocked, rate limits | Revoke unredeemed offers — `revokeUnredeemedOffer` exists |
| New-number filtering | Medium | Two-tap, DOI reply, contact card, transactional first | Time and volume; no code fix |
| Frequency-guard change breaks email | Medium | `person_key` defaults to email — byte-identical until SMS enabled | Drop the parameter |

**Master rollback:** `sms_enabled = false` in the control store stops all sending within one
cron tick (≤15 min) with no deploy. Every table is additive; leaving them in place after a
rollback costs nothing and preserves the consent evidence, which must **never** be deleted.

---

## 17. What should NOT be touched

- **`resolveCustomerDiscount()` and `resolveCartDiscount()`** — the contest, its push order,
  its `compete()` netting, its two coupon-stacking licences. Documented at length because
  each rule is a past incident.
- **`cart-server-discount-parity.test.ts`** — if it needs editing, the change is wrong.
- **The profit floor's report-only posture.** Widen the snapshot; do not re-arm the gate.
- **`payment-service.ts` / `create-session` total verification**, and the rule that
  identifiers come from the session or a cookie, never the request body.
- **`customer_offers` issue/reserve/redeem lifecycle** — use it, don't modify it.
- **The email lifecycle**: 7 automations, their priority order, `EVENT_GRACE_DAYS`, the
  4 cart stages, their windows, `MIN_STAGE_GAP_MS`, tier bands, offer cooldowns.
- **`marketing_send_claim`'s existing behaviour** — extend by parameter only.
- **Renaming any live table**, `abandoned_cart_emails` included.
- **The age/portal access model** and `access-policy.ts`.
- **Email consent records** — better SMS records are not a licence to migrate email now.

---

## 18. Go / no-go checklist

**Commercial**
- [ ] D1–D6 answered
- [ ] Commission-base change modelled against real orders (D1)
- [ ] Gift minimum confirmed at $60 with the absorb case understood (§9)
- [ ] Vanta Pro positioning confirmed unchanged — the gift adds no discount candidate

**Compliance — blocking**
- [ ] Twilio's mobile-number non-sharing sentence **live** in the privacy policy
- [ ] Counsel on: ambassador programme vs 30951; peptide catalogue vs 30941; quiet-hour applicability; state mini-TCPA
- [ ] Storefront copy scrubbed of indication/dosing language **before** vetting
- [ ] Transactional A2P campaign **approved** (marketing may still be pending)
- [ ] Disclosure copy reviewed and versioned

**Technical**
- [ ] Suppression seed verified: row count = distinct phones across all four sources
- [ ] `sms_enabled` defaults **false**; verified it blocks sending
- [ ] Webhook rejects unsigned and replayed requests
- [ ] Phase 3 parity suite green **with no edits to its assertions**
- [ ] Full vitest suite green (677 files today)
- [ ] Playwright: signup → verify → gift → cart → checkout → best promotion → purchase →
      recovery suppressed
- [ ] Playwright: STOP → inactive → marketing stops → gift unavailable → **order history
      unaffected**
- [ ] Mobile 390×844 on the local harness for every collection point

**Operational**
- [ ] Rollback rehearsed: flip the kill switch, confirm sending stops within one tick
- [ ] Alerts wired: send failure rate, opt-out rate, suppression-read failure, cash
      contribution below floor
- [ ] Admin can see subscriber state, consent evidence, and revoke

---

## 19. Automated and browser tests

**Unit / integration** — E.164 normalisation (incl. rejection cases); state-machine
transitions and every illegal transition; `verified` never sends marketing; consent-event
append-only; suppression fail-closed on read error; STOP/START/HELP including free-text
revocation; quiet-hour boundaries at each timezone edge and the continental fallback;
frequency cap across both channels; gift eligibility, minimum, once-ever, absorb case;
stacking matrix incl. the negative-contribution cases from the economics model; commission
base under each D1 option; webhook signature + replay; idempotency on `twilio_message_sid`;
retry classification (`safeToRetry`); attribution window and assist-vs-primary.

**Playwright, against the local pgrst-shim harness** (never `npm run dev`) — the two
journeys in §18, plus: a suppressed number cannot subscribe; verification rate limiting;
the cart preview matches the charged total on a gift order; and the admin surfaces show
consent evidence.

---

## 20. Monitoring

`recordSystemAlert()` into `system_alerts` + Sentry + operator email on critical, deduped —
the existing pattern, never throwing.

**Critical:** suppression read failure (sends are refusing); send failure rate > 10% over 30
min; webhook signature failures (possible forgery); any marketing send while
`sms_enabled = false` (should be impossible — alert if it happens).

**Warning:** opt-out rate > 2% on a send; delivery rate < 90%; error 30007 (carrier spam
filtering) on any message; cash contribution below floor; verification attempt spike
(pumping fraud).

**Reported, not alerted:** subscribers by state and source, messages and cost by flow,
revenue per recipient and per message, holdout lift, gift issuance vs redemption.

---
---

# Part B — Locked decisions, proved against production

Every figure below is computed by `scratchpad/d1-model.mjs` from constants read out of
production source or the live database on 2026-09-11. The model is analysis, not shipped
code, and imports nothing from `src`.

| Input | Value | Source |
|---|---|---|
| COGS ratio | 0.1883 | measured, revenue-weighted default doses |
| GHK-Cu 50mg | $39.99 retail / $3.65 cost / 40 in stock | `product_doses`, live |
| Recon Water 10mL | $14.99 / $1.43 / 50 in stock | `product_doses`, live |
| Processing | 8% | `PROCESSING_FEE_DEFAULT_PERCENT` |
| Postage | $7.93 | `FALLBACK_POSTAGE_CENTS` |
| Bundle tiers | 5 / 8 / 12 / 20% at 2 / 3–4 / 5–9 / 10+ | `DEFAULT_BUNDLE_CONFIG` |
| Free shipping | $200, else $15 | `FREE_SHIPPING_THRESHOLD` |
| Points redemption | 100 points = $1 | `POINTS_PER_DOLLAR_REDEMPTION` |

### ⚠ CONFLICT 3 — the membership tiers in the strategy document are wrong

`membership_tiers`, live: **Vanta Essential (5%) is `is_active = false`.** The active paid
tiers are **Pro 8% ($24.99)**, **Elite 10% ($39.99)**, **Black 12% ($89.99)**, plus the free
Research Member tier. Points per dollar differ by tier (2 / 3 / 4 / 5) and store-credit
minimums are $100 / $150 / $250.

The strategy document's cannibalisation table listed Essential as live. **Correct the
narrative, not the conclusion** — a free 15% would still have beaten Black, which is why it
was dropped.

---

## B1. The D1 `commissionableBase` proposal

### Why the obvious fix is wrong

`commissionableSubtotal = max(0, subtotal − discount_amount)` is recomputed at **three**
sites (`payment-webhook.ts:1038, 1593, 2528`) and feeds **four** consumers:

| Consumer | Line | Effect if we change the variable |
|---|---|---|
| Ambassador commission | 1179 | intended ✅ |
| **Points earning** | 1771, 3126 | **customer earns points on a free gift — violates D5** ❌ |
| **Refund proration `merchandiseBase`** | 2539 | **changes how every refund is prorated** ❌ |
| `amount_paid` on the commission record | 1215 | audit drift ❌ |

**So D1 must not touch `commissionableSubtotal`.** D1 and D5 collide head-on if implemented
on one variable. They need three separate bases.

### The three bases

```
paidMerchandiseCents   = max(0, subtotal − discount_amount)          ← UNCHANGED, today's value
                         consumers: refund proration, amount_paid

rewardBaseCents        = paid merchandise, evaluated gift-independently
                         consumers: points earning, store-credit eligibility   (D5)

commissionableBaseCents = paidMerchandiseCents + giftDisplacedRevenueCents
                         consumer: ambassador commission ONLY                  (D1)
```

### `giftDisplacedRevenueCents` — the definition

> The paid subtotal the basket would have had **without** the Vanta-funded gift, minus the
> paid subtotal it has **with** it.

Concretely, from the `absorbedFromCart` bookkeeping `quoteOrder` **already maintains**
(`quote-order.ts:814` — *"This records enough to restore them exactly"*, used today to undo
a gift when its minimum is not met at `1287-1340`):

```
giftDisplacedRevenueCents =
      Σ (absorbed units × their unit price at absorption)
    + bundleRepricingDelta     // survivors dropped to a lower bundle tier (quote-order.ts:934-942)
```

Two properties make this safe:

1. **Added gift → zero.** A `$0` gift line appended to the basket displaces nothing, so
   `giftDisplaced = 0` and commission is untouched. This is the no-double-count guarantee.
2. **No SMS gift → zero.** All three bases collapse to today's single value. This is the
   parity guarantee.

**Cap:** `commissionableBase ≤ paidMerchandise + (gift retail × quantity)`. A displaced
amount can never exceed what the gift was worth.

**Scope:** only incentives Vanta funds *for this programme*. Not bundle pricing, not
membership, not the referral's own discount, not a coupon.

---

## B2. Before / after by basket — ambassador referral, gift ABSORBS a unit

10% customer referral, 15% commission tier. `comm IDEAL` is what the ambassador would have
earned on the same basket with **no gift at all** — the proposal is correct when `comm NEW`
lands on it.

| Basket | units after | subtotal | paid merch | gift displaced | commissionable | comm NOW | comm NEW | comm IDEAL | residual | contribution |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| $50 | 0 | $0.00 | $0.00 | $49.99 | $49.99 | $0.00 | $7.50 | $6.75 | $0.75 | -$5.28 |
| $100 | 1 | $49.99 | $44.99 | $44.99 | $89.98 | $6.75 | $13.50 | $13.50 | **$0.00** | $19.81 |
| $150 | 1 | $74.99 | $67.49 | $67.49 | $134.98 | $10.12 | $20.25 | $20.25 | **$0.00** | $28.60 |
| $250 | 3 | $172.47 | $168.72 | $57.49 | $226.21 | $25.31 | $33.93 | $33.74 | $0.19 | $87.66 |
| $500 | 6 | $377.16 | $377.16 | $62.86 | $440.02 | $56.57 | $66.00 | $66.00 | **$0.00** | $190.85 |
| $1,000 | 13 | $742.82 | $742.82 | $57.14 | $799.96 | $111.42 | $119.99 | $119.99 | **$0.00** | $397.10 |

**Reading it.** Today the gift silently cuts the ambassador by **$6.75–$10.13** per order —
roughly **half their commission** on small baskets. The proposal restores it exactly on four
of six baskets.

**The residual is honest and bounded.** It appears only when the gift also changes the
winning discount's size (absorbing units shrinks the list subtotal the percentage is taken
on). Worst observed: **$0.19 on a $250 order — 0.08%.** Options: accept it (recommended,
it favours the partner), or cap at the no-gift counterfactual, which costs a second pricing
pass. **Recommend: accept, and assert the bound in a test.**

**The $50 row cannot occur.** Absorbing the only unit leaves a $0 paid subtotal; the gift's
$60 minimum withdraws the gift and restores the units (`quote-order.ts:1287-1340`). The row
is printed to show *why the minimum exists* — without it, that order contributes **−$5.28**.

## B3. Gift ADDED (product not already in cart) — the no-double-count proof

| Basket | subtotal | paid merch | gift displaced | comm NOW | comm NEW | delta |
|---|--:|--:|--:|--:|--:|--:|
| $50 | $49.99 | $44.99 | $0.00 | $6.75 | $6.75 | **$0.00** |
| $100 | $94.98 | $89.98 | $0.00 | $13.50 | $13.50 | **$0.00** |
| $150 | $142.48 | $134.98 | $0.00 | $20.25 | $20.25 | **$0.00** |
| $250 | $229.96 | $224.96 | $0.00 | $33.74 | $33.74 | **$0.00** |
| $500 | $440.02 | $440.02 | $0.00 | $66.00 | $66.00 | **$0.00** |
| $1,000 | $799.96 | $799.96 | $0.00 | $119.99 | $119.99 | **$0.00** |

A $0 line displaces no revenue, so commission does not move. **Commission never rises for
an unrelated reason.**

## B4. NO SMS entitlement — the parity proof

| Basket | subtotal | discount | winner | paid merch | reward base | commissionable | comm NOW | comm NEW | identical? |
|---|--:|--:|:--|--:|--:|--:|--:|--:|:--|
| $50 | $49.99 | $5.00 | referral | $44.99 | $44.99 | $44.99 | $6.75 | $6.75 | **YES** |
| $100 | $94.98 | $5.00 | referral | $89.98 | $89.98 | $89.98 | $13.50 | $13.50 | **YES** |
| $150 | $142.48 | $7.50 | referral | $134.98 | $134.98 | $134.98 | $20.25 | $20.25 | **YES** |
| $250 | $229.96 | $5.00 | referral | $224.96 | $224.96 | $224.96 | $33.74 | $33.74 | **YES** |
| $500 | $440.02 | $0.00 | none | $440.02 | $440.02 | $440.02 | $66.00 | $66.00 | **YES** |
| $1,000 | $799.96 | $0.00 | none | $799.96 | $799.96 | $799.96 | $119.99 | $119.99 | **YES** |

All three bases collapse to one value. **Every existing non-SMS order is byte-identical.**

(The $500 and $1,000 rows show the bundle ladder beating the referral outright —
`compete()` nets 10%-of-list against 12%/20% bundle savings and returns 0. Existing
behaviour, unchanged.)

## B5. Vanta Pro + SMS gift — and the store-credit hazard

Pro: 8% member discount, free shipping, 3 points/$, $15 monthly credit, **$100 minimum**.

| Basket | mode | winner | subtotal | paid merch | credit NOW → NEW | points | gift COGS | contribution |
|---|:--|:--|--:|--:|:--|--:|--:|--:|
| $50 | none | member | $49.99 | $45.99 | $0.00 → $0.00 | 137 | — | $23.60 |
| $100 | none | member | $94.98 | $91.98 | $0.00 → $0.00 | 275 | — | $56.06 |
| $100 | absorb | member | $49.99 | $45.99 | $0.00 → $0.00 | 137 | $3.65 | $19.95 |
| $150 | none | member | $142.48 | $137.98 | $15.00 → $15.00 | 413 | — | $73.05 |
| **$150** | **absorb** | member | $74.99 | $68.99 | **$0.00 → $15.00** | 206 | $3.65 | $20.71 |
| $250 | none | bundle | $229.96 | $229.96 | $15.00 → $15.00 | 689 | — | $138.44 |
| $250 | absorb | bundle | $172.47 | $172.47 | $15.00 → $15.00 | 517 | $3.65 | $94.44 |
| $500 | absorb | bundle | $377.16 | $377.16 | $15.00 → $15.00 | 1131 | $3.65 | $238.08 |
| $1,000 | absorb | bundle | $742.82 | $742.82 | $15.00 → $15.00 | 2228 | $3.65 | $494.66 |

### ⚠ CONFLICT 4 — the gift can silently cost a Pro member their store credit

The **$150 absorb** row is the finding. `resolveStoreCreditCents` gates on
`subtotalCents: Math.round(subtotal * 100)` (`quote-order.ts:1629`) — the **post-gift**
subtotal. A gift absorbing a $74.99 unit drops the subtotal to $74.99, under Pro's $100
minimum, and the member **silently loses $15 of credit they were entitled to**.

That is a paying member losing a paid benefit because they accepted a free gift. It is
exactly the "subtotal mutation caused by gift absorption" D5 names.

**Fix:** gate store-credit eligibility on `rewardBaseCents + giftDisplacedRevenueCents` —
i.e. what the basket was worth before the Vanta-funded gift touched it. Redemption stays
capped at what is actually owed, so nothing is given away; only *eligibility* stops moving.

**Vanta Pro is never cannibalised.** In every row the member discount still wins the
contest or the bundle ladder does. The gift adds **no candidate** to the discount race, so
it cannot beat a tier. **D3 is satisfied structurally.**

### Points — D5 is already satisfied, and must stay that way

`points NOW` equals `points NEW` in every row. Points are earned on paid merchandise; a $0
gift line adds nothing and absorbed units leave the subtotal. **No points are generated by
the gift today, and the `rewardBaseCents` split is what keeps it true after D1 lands** —
without the split, D1's add-back would start minting points on free product.

## B6. Worst-case legitimate stack

Vanta Black (12%, 5 points/$, $75 credit, $250 min) **+** ambassador referral (20%
commission tier) **+** SMS gift absorbing a unit **+** store credit **+** points **+** free
shipping. Commission on the proposed base.

| Basket | subtotal | discount | paid merch | commissionable | commission | credit | points $ | gift | contribution |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| $50 | $0.00 | $0.00 | $0.00 | $49.99 | $10.00 | $0.00 | $0.00 | $3.65 | **-$21.58** |
| $100 | $49.99 | $6.00 | $43.99 | $88.98 | $17.80 | $0.00 | $2.19 | $3.65 | **-$0.51** |
| $150 | $74.99 | $9.00 | $65.99 | $133.48 | $26.70 | $0.00 | $3.29 | $3.65 | $5.02 |
| $250 | $172.47 | $7.50 | $164.97 | $222.46 | $44.49 | $0.00 | $8.24 | $3.65 | $54.98 |
| $500 | $377.16 | $0.01 | $377.15 | $440.01 | $88.00 | $75.00 | $18.85 | $3.65 | $82.53 |
| $1,000 | $742.82 | $0.00 | $742.82 | $799.96 | $159.99 | $75.00 | $37.14 | $3.65 | $259.81 |

**Two negatives, and neither is the gift.**

- **$50: −$21.58.** Prevented by the $60 gift minimum. Cannot occur.
- **$100: −$0.51.** A Black member using an ambassador code on a small basket. The
  referral **loses** the discount contest (member 12% beats referral 10%) but still accrues
  **$17.80 of commission** on the restored base. That is the dominant cost — 40% of the
  basket — and it is a **pre-existing property of the commission model**, not something the
  SMS gift creates. D1 raises it from $8.80 to $17.80 on this order.

**This is the real cost of D1** and it needs a bound. Recommended: **cap
`commissionableBase` at `paidMerchandise + giftRetail`, and add a floor rule that
commission may never exceed contribution before commission.** The second is a new guard and
is the only thing standing between D1 and a negative order on a small referred basket.
**Flagged as D7 below.**

## B7. Abuse scenarios (D3 — SMS-only entitlement)

D3 unties the gift from the account email, so the abuse surface widens. Controls, ordered by
what they cost the honest customer (nothing, at the top):

| Vector | Control | Customer friction |
|---|---|---|
| Same person, many phone numbers | Gift ledger keyed on **verified person identity**: `user_id` when known, else the verified `phone_e164`. One `sms_subscribers` row per number (PK) | none |
| One number, many accounts | `phone_e164` is the PK and carries at most one `user_id`. Re-binding to a second account writes a consent event and **does not re-issue** a gift | none |
| Opt-out / opt-in farming | Gift is **once ever per identity**, not once per subscription. `resubscribe_count` + cooldown | none |
| Disposable / VOIP numbers | Block `line_type = 'voip'` at signup via Twilio Lookup | none for real mobiles |
| Verification flooding (SMS pumping) | Rate-limit per phone, per IP, per account; Twilio Fraud Guard; cap `verify_attempts` | none under normal use |
| Gift with an empty basket | `min_subtotal_cents = 6000`, re-judged after every other discount | visible, and it is the point |
| Redeem → refund → redeem | Redemption permanent by design, keyed on order | none |
| Two concurrent checkouts, one token | `reserveCustomerOffer` advisory lock; a failed reserve **refuses the order** | none |
| Guest checkout claiming a phone | Benefit never applies to a body-supplied identifier — server-established identity only | starts next order |
| Account-per-gift farming | New accounts with a fresh number are the residual hole. Mitigation is **detection, not prevention**: alert on gift-redemption rate per day and on repeated same-device/same-address signups | none |

**The residual is accepted deliberately.** At $3.65 a gift with a $60 minimum, farming is
not profitable for the farmer. Blocking it fully would mean identity checks that cost more
conversion than the abuse costs margin.

## B8. Migration and rollout sequence

Unchanged from §14, with the D1/D5 work made explicit and placed **after** the no-op
refactor.

| Step | Action | Reversible? |
|---|---|---|
| M0 | Seed `sms_suppressions` from all four phone sources. Verify count = distinct-phone query | additive only |
| M1 | Create SMS tables. No writes from app code yet | drop (empty) |
| M2 | Add `back_in_stock_requests.phone_e164 / notify_sms`, `orders.sms_*`. All nullable | drop columns |
| M3 | `marketing_send_claim` gains `person_key text default null`, resolving to the email when null | drop parameter |
| M4 | **Phase-3 no-op refactor.** Introduce the three bases, all equal, no behaviour change | revert commit |
| M5 | Widen `ProfitFloorSnapshot`; wire credit / points / gift COGS / commission | revert commit |
| M6 | Store-credit eligibility gated on the gift-independent base (**CONFLICT 4**) | revert commit |
| M7 | `commissionableBaseCents` behind a flag, default OFF — today's value when off | flag |
| M8 | SMS entitlement returns a real gift. Flag on | flag |

**M4 is the gate.** It must land with the parity suite green and **no edits to its
assertions**. If a parity assertion needs changing, the refactor is wrong.

## B9. Invariants the suite must prove

**Parity — the no-SMS guarantee** (each asserted with SMS absent):
1. `paidMerchandise === rewardBase === commissionableBase` for every basket.
2. Commission, points earned, store credit, `discount_amount` and the order total are
   identical to the pre-change values across the whole `REACHABLE` scenario table.
3. `cart-server-discount-parity.test.ts` passes **with no edits to its assertions**.
4. The 100,000-case fuzz in `ambassador-financial-invariants.test.ts` passes unchanged.

**D1 — commission:**
5. Gift **added** → `giftDisplaced === 0` → commission unchanged. (B3)
6. Gift **absorbing** → `commissionNew === commissionNoGift` when the winning discount is
   unchanged. (B2)
7. Residual `commissionNew − commissionNoGift` is `≥ 0` and `≤ giftRetail × commissionPct`.
8. `commissionableBase ≤ paidMerchandise + giftRetail × quantity`, always.
9. No non-SMS incentive (bundle, membership, referral, coupon, BXGY) ever adds to
   `commissionableBase`.
10. `paidMerchandise` — and therefore refund proration and `amount_paid` — is **untouched**
    by every SMS code path.

**D5 — reward base:**
11. Points earned from a $0 gift line = 0.
12. Points earned on an absorbing gift = points on paid merchandise only.
13. Store-credit **eligibility** is unchanged by gift absorption. (CONFLICT 4 / B5)
14. Store-credit **redemption** never exceeds the balance owed.
15. Existing store-credit and points behaviour is identical with no SMS entitlement.

**Consent and suppression:**
16. `verified` alone never sends marketing.
17. Every phone seeded at M0 is suppressed and stays suppressed without a fresh grant.
18. A suppression read error **refuses the send**.
19. Opt-out is honoured within one cron tick; transactional continues.
20. `sms_consent_events` rejects UPDATE and DELETE.
21. Double opt-in incomplete → no marketing send.

**Economics:**
22. `computeOrderEconomics().acceptable === false` for every negative-contribution stack in
    B6, and the alert fires.
23. The gift minimum withdraws the gift and restores absorbed units below $60.
24. No order can be constructed where the SMS gift alone drives contribution negative.

**Idempotency and delivery:**
25. Duplicate `twilio_message_sid` writes once.
26. Replayed webhook is a no-op.
27. Unsigned webhook rejected; unconfigured secret → 503.
28. A cart recovered mid-flight cancels the `sms_t4h` stage.

## B10. Remaining decisions

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| **D7** | **Commission floor rule.** Should commission be capped so it can never exceed contribution before commission? | B6 shows a $100 Black + referral + gift order at **−$0.51**, driven by $17.80 of commission that D1 raises from $8.80. Without a floor, D1 makes small referred baskets loss-making | **Yes — cap it.** Ambassadors keep full commission on healthy orders; only pathological small baskets clip |
| **D8** | **Does the add-back apply to the existing email win-back gift** (`winback_60_free_ghkcu`), or SMS only? | The same unfairness exists today on email gifts. SMS-only is literal to D1 but creates two rules for one gift | **Apply to all Vanta-funded `free_product` offers.** One rule. **Note: this changes live email win-back behaviour** — needs your explicit sign-off |
| **D9** | **Residual tolerance.** Accept the ≤$0.19 over-restoration, or spend a second pricing pass to make it exact? | B2. Favours the partner; cost is CPU and complexity | **Accept**, assert the bound |
| **D10** | **Timezone source.** Use shipping state from the last order? That is PII-adjacent inference | D6 says "genuinely known" — an order's shipping state is known, but is it *their* timezone? | **Use it, with the continental-safe fallback** when there is no order. Flag for compliance sign-off |
| **D11** | **Gift inventory floor.** GHK-Cu has **40 units** in stock. At what level does the gift auto-disable? | A gift that oversells stock creates unfulfillable orders | **Auto-disable below 10 units**, admin-configurable, alert at 15 |

### D4 — the gift must be configuration, not code

You asked that GHK-Cu not be hard-coded. `OFFER_CATALOG` is a **code constant**, so a
catalogue key alone does not satisfy this. The mechanism that does already exists:
`issueResolvedOffer()` takes a **resolved `GiftConfig`**, which is exactly how
operator-built campaign gifts work today (`campaign-gift.ts:35-43`) — they file under
`campaign:<id>` and carry no catalogue key at all.

**Proposal:** the SMS gift is an **admin-control setting** (`sms.gift`) holding
`{ productSlug, variantId, quantity, minSubtotalCents, ttlDays }`, resolved to a
`GiftConfig` at issue time and passed to `issueResolvedOffer()`. Changing the gift is then a
Control Center edit, no deploy — and because the offer row records what was **promised**, a
token minted under the old gift still redeems as the old gift. Validation on save: product
exists, is enabled, is not archived, is in stock, and the admin sees the cost and the
perceived-value multiple before saving (the pattern `tierEconomics` already uses).

---
---

# Part C — D7–D11 approved: the floor, the audit trail, and the last blockers

All figures below are produced by `docs/sms-economics-model.mjs` (§B header for inputs).

### ⚠ CONFLICT 5 — the refund path would silently un-cap the commission

Found while designing the audit trail, and it would have been invisible until the first
partial refund on a capped order.

`computeRetainedCommission` (`payment-webhook.ts:1446`) does **not** read the stored
commission. It recomputes it:

```ts
const original = roundMoney(input.base * (input.percent / 100));
return roundMoney(original * (1 - fraction));
```

And `updateCommissionOnRefund` (`:1460`) selects only
`payment_status, commission_amount, commission_percent, amount_paid`. Since
`referral_orders.amount_paid` **is** the commissionable base (written at `:1215`), any
refund recomputes `base × percent` — **discarding the cap** and paying the ambassador the
uncapped figure on the retained portion.

**Fix, and it is small:** `computeRetainedCommission` takes the **payable** commission
explicitly rather than recomputing it.

```
computeRetainedCommission({ originalPayable, refundedFraction })
  → roundMoney(originalPayable * (1 - fraction))
```

One pure function, one new argument, one test. **This must land in the same commit as the
floor** or the cap leaks on the first refund.

---

## C1. The exact D7 contribution and floor formula

### Contribution before commission

```
contributionBeforeCommission =
      paidMerchandise                    (= subtotal − discount_amount)
    + shippingCollected
    + handlingCollected
    − productCost                        COGS of the PAID lines
    − giftCogs                           COGS of Vanta-funded gift units
    − processingFee                       per profitSettings.processingFeeIncludesTax
    − shippingCost                       actual postage
    − storeCreditRedeemed                non-cash tender: cash Vanta never receives
    − pointsRedeemedValue                non-cash tender
    − pointsEarnedValue                  accrued liability created by this order
```

| Included | Excluded, and why |
|---|---|
| Paid merchandise revenue | **Sales tax** — pass-through, never Vanta's money |
| Shipping + handling collected | **Commission** — it is what the floor bounds |
| Product COGS (paid lines) | **Membership subscription revenue** — a separate product; an order must stand alone |
| **Gift COGS** | **Refunds** — settled later; the refund path prorates separately |
| Processing fee | **Customer-paid card service fee** — passed to the customer, not a Vanta cost |
| Actual postage | **Fixed overhead** — not order-attributable |
| Store credit redeemed | |
| Points redeemed | |
| **Points earned** (accrual) | |

Points *earned* is included deliberately: it is a real liability this order creates, at
2–5% of the reward base depending on tier. Excluding it would let commission push true
contribution negative while the floor reported the order as fine.

### The floor

```
commissionCalculated = commissionableBase × commissionPercent / 100

headroom             = max(0, contributionBeforeCommission − minRetainedContribution)
commissionPayable    = min(commissionCalculated, headroom)
commissionCapped     = commissionCalculated − commissionPayable
capReason            = commissionCapped > 0 ? 'contribution_floor' : null
```

`minRetainedContribution` is an admin setting defaulting to **$0** — break-even, matching
`DEFAULT_PROFIT_SETTINGS.minProfitDollars = 0`.

**The floor touches commission and nothing else.** Customer pricing, gifts, membership
benefits, points and refunds are all computed before it and are not inputs it may modify.
Per your instruction, that is a hard constraint, not a convention: the floor's only output
is `commissionPayable`.

### ⚠ What the floor cannot do

The floor can reduce commission to zero. It **cannot make a negative order positive** when
non-commission costs already exceed revenue. The **$50** row in C2 shows exactly that:
commission is capped from $10.00 to $0.00 and contribution is still **−$11.58**, because a
gift absorbing the only unit leaves no paid merchandise.

**The guard for that case is the $60 gift minimum, not the floor.** Two independent
protections, and neither substitutes for the other.

## C2. Where the floor triggers

Vanta Black (12%, 5 pts/$, $75 credit, $250 min) + ambassador referral at the **20%**
commission tier + SMS gift absorbing a unit + free shipping.

| Basket | commissionable | contrib before comm | comm calculated | **comm PAYABLE** | capped | reason | contrib after |
|---|--:|--:|--:|--:|--:|:--|--:|
| $50 | $49.99 | -$11.58 | $10.00 | **$0.00** | $10.00 | `contribution_floor` | -$11.58 |
| $100 | $88.98 | $17.29 | $17.80 | **$17.29** | $0.51 | `contribution_floor` | **$0.00** |
| $150 | $133.48 | $31.72 | $26.70 | $26.70 | $0.00 | — | $5.02 |
| $250 | $222.46 | $99.47 | $44.49 | $44.49 | $0.00 | — | $54.98 |
| $500 | $440.01 | $170.53 | $88.00 | $88.00 | $0.00 | — | $82.53 |
| $1,000 | $799.96 | $419.80 | $159.99 | $159.99 | $0.00 | — | $259.81 |

The **$100** row is the case D7 exists for: previously **−$0.51**, now exactly **$0.00**, by
clipping **$0.51** of commission. The ambassador keeps $17.29 of $17.80 — 97%.

### The floor must not touch ordinary orders

Same referral, **no SMS gift**, 15% tier:

| Basket | contrib before comm | comm calculated | comm PAYABLE | capped | untouched? |
|---|--:|--:|--:|--:|:--|
| $50 | $36.96 | $6.75 | $6.75 | $0.00 | **YES** |
| $100 | $68.98 | $13.50 | $13.50 | $0.00 | **YES** |
| $150 | $100.53 | $20.25 | $20.25 | $0.00 | **YES** |
| $250 | $151.24 | $33.74 | $33.74 | $0.00 | **YES** |
| $500 | $305.23 | $66.00 | $66.00 | $0.00 | **YES** |
| $1,000 | $561.41 | $119.99 | $119.99 | $0.00 | **YES** |

Headroom exceeds commission by 3–5× on every ordinary order. **The floor is unreachable
without a stacked non-cash tender on a small basket.**

## C3. How a capped commission appears in accounting

`referral_orders` already carries `review_required` and `review_reason`. Five additive
nullable columns complete the audit trail:

```sql
alter table public.referral_orders
  add column if not exists commissionable_base           numeric(12,2),
  add column if not exists commission_calculated         numeric(12,2),
  add column if not exists commission_capped_amount      numeric(12,2) not null default 0,
  add column if not exists commission_cap_reason         text,
  add column if not exists contribution_before_commission numeric(12,2);
```

**`commission_amount` keeps its meaning — the payable figure.** Payout code, the partner
portal and every existing read stay correct without modification. Nothing that computes a
payout changes shape.

| Field | Value on the $100 row |
|---|--:|
| `commissionable_base` | $88.98 |
| `commission_calculated` | $17.80 |
| **`commission_amount`** (payable, existing) | **$17.29** |
| `commission_capped_amount` | $0.51 |
| `commission_cap_reason` | `contribution_floor` |
| `contribution_before_commission` | $17.29 |

**Admin — order detail:**
> Commission $17.29 · calculated $17.80, **$0.51 withheld** — order contribution floor
> Base $88.98 (incl. $44.99 displaced by a Vanta-funded gift)

**Ambassador portal:** shows the payable amount with a plain-language note, never a silent
difference:
> Commission $17.29 — reduced by $0.51 on this order to keep it above our minimum margin.

**Alerting:** `recordSystemAlert` on any capped commission, so a systematic cap shows up as
an operational signal rather than a payout mystery. If the cap fires more than rarely, the
commission tiers or the gift minimum are wrong — not the floor.

**Refund interaction:** retained commission is derived from `commission_amount` (payable),
per CONFLICT 5. `commission_capped_amount` is never re-paid on refund.

## C4. D8 — the email win-back gift, before and after

Identical mechanics: same `OFFER_CATALOG` reward kind, same absorb path, same
`issueResolvedOffer`. 10% referral, 15% commission tier, floor applied.

| Basket | subtotal | paid merch | gift displaced | comm BEFORE (today) | comm AFTER (D8) | ambassador gains | contrib after |
|---|--:|--:|--:|--:|--:|--:|--:|
| $50 | $0.00 | $0.00 | $49.99 | $0.00 | $2.22 | +$2.22 | $0.00 |
| $100 | $49.99 | $44.99 | $44.99 | $6.75 | $13.50 | **+$6.75** | $19.81 |
| $150 | $74.99 | $67.49 | $67.49 | $10.12 | $20.25 | **+$10.13** | $28.60 |
| $250 | $172.47 | $168.72 | $57.49 | $25.31 | $33.93 | +$8.62 | $87.66 |
| $500 | $377.16 | $377.16 | $62.86 | $56.57 | $66.00 | +$9.43 | $190.85 |
| $1,000 | $742.82 | $742.82 | $57.14 | $111.42 | $119.99 | +$8.57 | $397.10 |

**This is a live behaviour change and a cost increase**: every win-back gift redeemed on a
referred order pays the ambassador **$6.75–$10.13 more** than today. Contribution stays
positive on every reachable basket.

**Flagging, per your instruction.** Two independent flags, defaulting off:

```
benefits.gift_displaced_commission.sms    → M7
benefits.gift_displaced_commission.email  → M9, separate release
```

Both resolve through the existing control store, so either can be rolled back without a
deploy. **The email flag ships only after its own regression suite is green** and is never
enabled in the same release as the SMS flag — a payout change and a new channel must not
land together, or an unexpected commission total has two candidate causes.

## C5. Residual bound (D9) — source, proof, and the guard against growth

**Source.** The gift absorbs units, which shrinks the **list** subtotal a percentage
discount is taken on. So `discount_amount` falls too, and `paidMerchandise` falls by *less*
than `subtotal` did. Adding back the full subtotal delta therefore slightly over-restores.
It appears **only** when a percentage discount wins and the gift absorbs.

| Basket | comm NEW | comm IDEAL | residual | % of order | within bound? |
|---|--:|--:|--:|--:|:--|
| $50 | $7.50 | $6.75 | $0.75 | n/a | YES (≤ $6.00) |
| $100 | $13.50 | $13.50 | $0.00 | 0.000% | YES |
| $150 | $20.25 | $20.25 | $0.00 | 0.000% | YES |
| $250 | $33.93 | $33.74 | $0.19 | 0.113% | YES |
| $500 | $66.00 | $66.00 | $0.00 | 0.000% | YES |
| $1,000 | $119.99 | $119.99 | $0.00 | 0.000% | YES |

**Analytic bound.** The residual cannot exceed the discount the absorbed units would have
attracted, times the commission rate:

```
residual ≤ giftRetail × quantity × maxDiscountPercent × commissionPercent
```

At GHK-Cu $39.99, one unit, a 20% worst-case discount and the 20% top commission tier:
**≤ $1.60**. The looser bound asserted in the regression test is
`giftRetail × commissionPercent` = **$8.00**, which holds for any discount depth.

**Regression guard** — two assertions so the discrepancy cannot grow unnoticed:
1. `residual >= 0 && residual <= giftRetail × quantity × commissionPercent / 100` for every
   fuzz case.
2. A pinned table asserting the exact residual per modelled basket, so a change in the
   discount engine that moves it **fails loudly** rather than drifting.

No second pricing pass. No added complexity for cents.

## C6. Proof: refund math is unchanged

`paidMerchandise` is byte-identical to today's `commissionableSubtotal`, and it is the only
value the refund path reads.

| Refund input | Source | Changed? |
|---|---|---|
| `merchandiseBase` (fraction denominator) | `paidMerchandise` | **No** |
| `refundedFraction` = cumulative refunded ÷ merchandiseBase | unchanged | **No** |
| `amountPaid` (partial-vs-full detection) | `orders.amount_paid` | **No** |
| `existingRefundAmount` | `orders.refund_amount` | **No** |
| `recordedRefundAmount`, `paymentStatus`, `shouldRestock` | unchanged | **No** |
| Retained commission | now derived from `commission_amount` (payable) instead of recomputed | **Yes — CONFLICT 5** |

The only refund change is the one that makes the cap survive a refund. Proof obligations:
invariants 10 and 29–31 in §B9/C9.

## C7. Proof: a free gift cannot mint points or store credit

Three independent reasons, any one of which is sufficient:

1. **A `$0` gift line adds nothing to `subtotal`**, so it adds nothing to `rewardBase`.
   Points are `floor(rewardBase × pointsPerDollar)`.
2. **Absorbed units leave `subtotal`**, so the customer earns points only on what they
   actually paid. Verified in §B5: `points NOW === points NEW` in every row.
3. **`rewardBase` never includes `giftDisplacedRevenueCents`.** That term exists solely in
   `commissionableBase`. This is the whole reason the two bases are separate rather than one
   variable, and it is why D1 cannot be implemented on `commissionableSubtotal`
   (§B1) — doing so would make the gift mint points.

**`rewardBase` for earning is paid merchandise only. The gift-displaced amount is used for
*eligibility thresholds*, never as an earning base** — see C8.

## C8. Proof: a gift cannot remove an earned Vanta Pro benefit

The hazard (CONFLICT 4): store-credit eligibility gates on the post-gift subtotal
(`quote-order.ts:1629`), so absorption can drop a member under their tier minimum.

| Basket | mode | subtotal | Pro minimum | credit TODAY | credit PROPOSED |
|---|:--|--:|--:|--:|--:|
| $150 | none | $142.48 | $100 | $15.00 | $15.00 |
| **$150** | **absorb** | $74.99 | $100 | **$0.00** ❌ | **$15.00** ✅ |
| $250 | absorb | $172.47 | $100 | $15.00 | $15.00 |
| $500 | absorb | $377.16 | $100 | $15.00 | $15.00 |

**Fix:** eligibility is tested against `rewardBase + giftDisplacedRevenueCents` — what the
basket was worth before a Vanta-funded gift touched it.

Two properties keep this safe:

- **Eligibility moves; the amount does not.** Redemption is still
  `min(balance, amountStillOwed)`, so nothing extra is given away. Only the *threshold test*
  stops being disturbed by the gift.
- **Earning is unaffected.** The displaced amount is used for the threshold only, never as
  an earning base — so C7 still holds.

The same rule applies to any tier minimum, so Elite ($150) and Black ($250) are covered by
construction rather than by three separate cases.

## C9. Gift inventory (D11): issued vs unissued

**GHK-Cu 50mg: 40 units in stock, verified live 2026-09-11.**

| Threshold | Value | Behaviour |
|---|--:|---|
| Alert | **15 available** | `recordSystemAlert` warning; gift keeps issuing |
| Stop issuing | **10 available** | No NEW gift offers minted; already-issued promises untouched |

### "Available" must net off outstanding promises

Raw stock is the wrong number. An already-issued, unredeemed gift is a **promise against
stock**:

```
availableForNewGifts = live stock
                     − units reserved by paid-but-unshipped orders
                     − count of LIVE unredeemed gift offers
                       (customer_offers where revoked_at is null
                        and redeemed_at is null and expires_at > now)
```

Issuing stops when `availableForNewGifts < 10`. This is what makes "do not silently
invalidate already-issued promises" true by construction rather than by hope: the headroom
for outstanding promises is subtracted **before** the threshold is tested, so the store
cannot promise more gifts than it can honour.

### What happens to issued promises

- **Never revoked for stock.** `revokeUnredeemedOffer` is for a failed *send*, not for
  inventory. Issued promises stay valid to expiry.
- **Today's fallback is graceful but silent.** `quote-order.ts:900-903` already refuses to
  grant a gift whose product is out of stock (`if (!offerProduct || !shippable) return
  null`) — the order prices and completes without the gift. Correct, but the customer is
  told nothing.
- **Recommended:** when an issued promise cannot be honoured, surface it at checkout
  ("your gift is temporarily unavailable — it will apply to an order placed before
  <expiry>") and alert the operator. Not silence.
- **Issuance is also gated at send time**, so an SMS never promises a gift the store cannot
  honour. A message already queued is checked again before dispatch.

### Admin-configurable (D4 + D11)

One control-store section, no deploy, with the same validate-and-show-the-cost pattern
`tierEconomics` already uses:

```
sms.gift = {
  productSlug, variantId, quantity,
  minSubtotalCents,        default 6000
  ttlDays,                 default 30
  alertBelowUnits,         default 15
  stopIssuingBelowUnits,   default 10
}
```

Resolved to a `GiftConfig` at issue time and passed to `issueResolvedOffer()` — the same
path operator-built campaign gifts already use. Validation on save: product exists, enabled,
not archived, in stock, `stopIssuingBelowUnits < alertBelowUnits`, and the admin sees cost,
retail and the perceived-value multiple before saving.

## C10. Remaining blockers before implementation

| # | Blocker | Status |
|---|---|---|
| **B1** | **CONFLICT 5 — `computeRetainedCommission` must take the payable commission.** Must land with the floor, or the cap leaks on the first partial refund | **Design agreed, needs your ack** |
| **B2** | `minRetainedContribution` default. Recommend **$0** (break-even, matches the existing profit-setting default) | **Needs your number** |
| **B3** | Whether the ambassador portal shows the withheld amount and reason, or only the payable figure. Recommend showing it — a silent difference is what you said you did not want | **Needs your call** |
| **B4** | **Points-earned inclusion in the floor base.** Included above (2–5% of reward base). Excluding it would let commission push true contribution negative | **Needs your ack** |
| **B5** | Phase-3 no-op refactor must land with the parity suite green and **no edits to its assertions** | Gate, not a decision |
| **B6** | A2P: transactional campaign approved; privacy-policy sentence live; storefront copy scrubbed | **External, not started** |
| **B7** | Counsel on §8.3 items 2, 3 and 6, and on the D10 timezone-inference question | **External, not started** |
| **B8** | Pre-launch verification of GHK-Cu COGS and inventory (D4) — $3.65 / 40 units read today, re-verify at launch | Open |

**Not blockers, deliberately deferred:** backporting the richer consent record to email
(§3); renaming `abandoned_cart_emails` (§2); the `Essential` tier's inactive status (§B
header).

### My assessment

**The economics are ready.** The three bases are proved identical without a gift (§B4), the
floor is proved unreachable on ordinary orders (§C2), refunds are proved unchanged except
for the one fix that must accompany the cap (§C6), and gifts are proved unable to mint
rewards (§C7) or remove an earned benefit (§C8).

**The blockers are now mostly external** — A2P registration, the privacy-policy sentence,
copy scrub, and counsel. B1–B4 are four small acknowledgements. Once those are in, M0–M6 can
proceed; M7 needs B1 and B2 settled.

---
---

# Part D — B1–B4 locked, final test matrix, rollback boundaries

Approved 2026-09-11. **M0–M6 authorised. M7 gated on D4 below.**

| # | Locked as |
|---|---|
| **B1** | Refund derives retained commission from the **stored payable** commission. Ships in the **same change** as the floor. Six regression cases in §D3 |
| **B2** | `minRetainedContribution` **default $0**. Commission may be reduced only to stop commission itself taking contribution below zero. **Never used to rescue an already-negative order** — that stays a pricing/eligibility concern. Configurable for a future positive floor |
| **B3** | Capped commission **surfaced** in admin and ambassador views: calculated, payable, withheld, reason. **Uncapped orders stay visually simple** — nothing rendered when withheld is zero |
| **B4** | **Points-earned liability included** in contribution-before-commission |

### ⚠ CONFLICT 6 — M6 is not inert either, and needs its own flag

The rollback analysis turned this up. Everything keyed on `giftDisplacedRevenueCents`
changes **live behaviour immediately**, because the existing email win-back gift
(`winback_60_free_ghkcu`) **already absorbs units today**. That applies to the store-credit
eligibility fix (§C8), not just to commission.

So M6 is not a safe inert migration as written in §B8. **Three flags, not two:**

```
benefits.gift_displaced_commission.sms          → M7
benefits.gift_displaced_commission.email        → M9, separate release (D8)
benefits.gift_displaced_credit_eligibility      → M6, own release   ← NEW
```

Each defaults **off**; each resolves through the control store; each rolls back without a
deploy. With all three off, `giftDisplacedRevenueCents` is computed and **recorded** but
consumed by nothing — which is what makes M4–M6 genuinely observable before they are load-
bearing.

## D1. The contribution formula: one authoritative implementation

B2 requires a single implementation. Following the **SOT-08** precedent
(`phase11-bucket0.test.ts:275`), which the repo already uses to stop the floor predicate
having two homes:

**One export, one home:**
```
src/lib/benefits/contribution.ts
  export function computeContributionBeforeCommission(inputs): ContributionBreakdown
  export function applyCommissionFloor({ commissionCalculated, contribution, minRetainedContribution })
```

`ContributionBreakdown` returns every line named in §C1 individually — not just the total —
so the admin can show *why* a cap fired without recomputing anything.

**Guarded by a source-text test in the SOT-08 style**, asserting:
1. `quote-order.ts` and `payment-webhook.ts` **call** it and do not restate it.
2. No module outside `contribution.ts` contains the arithmetic
   (`- pointsEarnedValue`, `- storeCredit`, `Math.min(commissionCalculated`).
3. `applyCommissionFloor` is the only place `commission_capped_amount` is derived.

This is the M7 gate: **one formula, one home, never a second inlined copy.**

## D2. Final invariant and test matrix

`P` = must pass before the milestone merges. Existing suites are named where they already
cover the invariant.

| # | Invariant | Milestone | Suite |
|---|---|---|---|
| 1 | Every phone in `orders`/`ambassadors`/`partners`/`customer_preferences` is suppressed after M0; count matches the distinct-phone query | M0 `P` | `sms-suppression-seed.test.ts` (SQL) |
| 2 | A number leaves suppression only via verification **and** an explicit marketing grant | M2 `P` | `sms-consent.test.ts` |
| 3 | `verified` alone never sends marketing | M2 `P` | `sms-state-machine.test.ts` |
| 4 | Every illegal state transition is refused | M2 `P` | `sms-state-machine.test.ts` |
| 5 | `sms_consent_events` rejects UPDATE and DELETE | M1 `P` | `sms-consent-append-only.test.ts` (SQL) |
| 6 | A suppression read error **refuses the send** | M2 `P` | `sms-send-fails-closed.test.ts` |
| 7 | Opt-out honoured within one cron tick; transactional continues | M2 `P` | `sms-keywords.test.ts` |
| 8 | Double opt-in incomplete → no marketing send | M2 `P` | `sms-double-optin.test.ts` |
| 9 | `person_key` omitted ⇒ `marketing_send_claim` byte-identical to today | M3 `P` | `marketing-frequency-guard.test.ts` (extend) |
| 10 | Email lifecycle send behaviour unchanged after M3 | M3 `P` | `marketing-choke-point.test.ts`, `automation-*.test.ts` |
| 11 | **No gift ⇒ `paidMerchandise === rewardBase === commissionableBase`** | M4 `P` | `benefit-bases.test.ts` |
| 12 | **M4 changes no total, discount, commission, points or credit anywhere in `REACHABLE`** | M4 `P` | `cart-server-discount-parity.test.ts` **unedited** |
| 13 | 100,000-case ambassador fuzz passes unchanged | M4 `P` | `ambassador-financial-invariants.test.ts` |
| 14 | `paidMerchandise` identical to today's `commissionableSubtotal`, all paths | M4 `P` | `benefit-bases.test.ts` |
| 15 | Gift **added** ⇒ `giftDisplaced === 0` ⇒ commission unchanged | M4 `P` | `gift-displaced-revenue.test.ts` |
| 16 | Gift **absorbing** ⇒ `giftDisplaced` = the exact subtotal delta incl. bundle repricing | M4 `P` | `gift-displaced-revenue.test.ts` |
| 17 | `commissionableBase ≤ paidMerchandise + giftRetail × qty`, always | M4 `P` | `gift-displaced-revenue.test.ts` |
| 18 | No non-SMS incentive (bundle, membership, referral, coupon, BXGY) adds to `commissionableBase` | M4 `P` | `gift-displaced-revenue.test.ts` |
| 19 | Residual ≥ 0 and ≤ `giftRetail × qty × commissionPct/100`; pinned per-basket table | M4 `P` | `commission-residual-bound.test.ts` |
| 20 | **One contribution formula; no second inlined copy** (SOT-08 style) | M5 `P` | `sot-contribution.test.ts` |
| 21 | Floor snapshot carries credit, points, giftCOGS, commission, contribution, bindingConstraint | M5 `P` | `profit-floor-snapshot.test.ts` |
| 22 | Floor **reports, never refuses** — no code path throws on margin | M5 `P` | `profit-floor-report-only.test.ts` |
| 23 | Alert fires on every negative-contribution stack in §B6/C2 | M5 `P` | `profit-floor-alert.test.ts` (extend) |
| 24 | **Points from a $0 gift line = 0** | M5 `P` | `reward-base.test.ts` |
| 25 | Points on an absorbing gift = points on paid merchandise only | M5 `P` | `reward-base.test.ts` |
| 26 | Points and credit identical to today when no gift exists | M5 `P` | `reward-base.test.ts` |
| 27 | **Credit eligibility unchanged by gift absorption** (flag on) | M6 `P` | `store-credit-gift-eligibility.test.ts` |
| 28 | Credit **redemption** never exceeds balance owed | M6 `P` | `store-credit-gift-eligibility.test.ts` |
| 29 | Credit behaviour byte-identical with the M6 flag **off** | M6 `P` | `store-credit-gift-eligibility.test.ts` |
| 30 | Displaced amount used for eligibility thresholds only, **never as an earning base** | M6 `P` | `reward-base.test.ts` |
| 31 | **Floor unreachable on ordinary referred orders** (headroom 3–5×) | M7 `P` | `commission-floor.test.ts` |
| 32 | Floor caps commission and **nothing else** — pricing, gifts, membership, points, refunds unchanged by it | M7 `P` | `commission-floor.test.ts` |
| 33 | Floor **never rescues** an already-negative order; contribution stays negative with commission at 0 | M7 `P` | `commission-floor.test.ts` |
| 34 | `minRetainedContribution` configurable; $0 reproduces §C2 exactly | M7 `P` | `commission-floor.test.ts` |
| 35 | **B1 — six refund cases (§D3)** | M7 `P` | `commission-refund-cap.test.ts` |
| 36 | Refund `merchandiseBase`, `refundedFraction`, `recordedRefundAmount`, `paymentStatus`, `shouldRestock` all unchanged | M7 `P` | `commission-refund-cap.test.ts` |
| 37 | Audit fields populated on every commission row; `commission_amount` remains payable | M7 `P` | `commission-audit-fields.test.ts` |
| 38 | Withheld amount + reason rendered when > 0; **nothing rendered when 0** (B3) | M7 `P` | `admin-commission-surface.test.ts` |
| 39 | Gift minimum withdraws the gift and restores absorbed units below $60 | M7 `P` | `gift-minimum.test.ts` |
| 40 | `availableForNewGifts` nets off live unredeemed offers; issuance stops below 10 | M7 `P` | `gift-inventory.test.ts` |
| 41 | An issued promise is **never revoked for stock**; unfulfillable promise surfaces a message and an alert | M7 `P` | `gift-inventory.test.ts` |
| 42 | Duplicate `twilio_message_sid` writes once; replayed webhook is a no-op | M1 `P` | `sms-webhook.test.ts` |
| 43 | Unsigned webhook rejected; unconfigured secret ⇒ 503 | M1 `P` | `sms-webhook.test.ts` |
| 44 | Quiet-hour boundaries at each zone edge + continental fallback | M2 `P` | `sms-quiet-hours.test.ts` |
| 45 | Cross-channel cap: one marketing message per person per 24h | M8 `P` | `sms-frequency.test.ts` |
| 46 | A recovered cart cancels the `sms_t4h` stage with no race | M8 `P` | `sms-cart-recovery.test.ts` |
| 47 | **D8 email: commission before/after matches §C4 with the flag on; identical with it off** | M9 `P` | `email-gift-commission.test.ts` |

**Playwright (M8, harness only — never `npm run dev`):** signup → verify → double opt-in →
gift issued → cart → checkout → best promotion chosen → purchase → recovery suppressed; and
STOP → inactive → marketing stops → gift unavailable → **order history unaffected**. Both at
390×844.

## D3. B1 — the six refund regression cases

Fixture: the §C2 `$100` capped order. `commissionableBase` $88.98, percent 20%,
`commission_calculated` $17.80, **`commission_amount` (payable) $17.29**,
`commission_capped_amount` $0.51.

| # | Case | Expected | Proves |
|---|---|--:|---|
| 1 | **No refund**, capped order | payable stays **$17.29** | the cap persists at rest |
| 2 | **Partial refund $50** of $100 | retained = 17.29 × (1 − 50/88.98) = **$7.58** | prorates the **payable**, not `base × percent` |
| 3 | **Two partials**, $30 then $20 | after: **$11.40**; then **$7.58** | cumulative fraction; second does not overwrite the first |
| 4 | **Full refund** | **$0.00** | full reversal |
| 5 | **Uncapped order**, partial refund | identical to today's value, to the cent | no regression for the 99% case |
| 6 | **Any refund, any sequence** | retained **≤ $17.29**, never ≤ $17.80 | *"refund commission can never exceed the originally payable commission"* |

Case 6 is asserted as a property over a fuzz of refund sequences, not a single example.

## D4. Rollback boundaries per milestone

| M | Changes | Live behaviour? | Rollback | Blast radius if wrong |
|---|---|:--|---|---|
| **M0** | Seed `sms_suppressions`; privacy-policy sentence; copy scrub | **Production data write.** No sends exist | Rows identifiable by `reason='pre_consent_migration'`. **Rolling back means un-suppressing — do not.** Forward-only by design | **None.** Additive and safe-by-default: the failure mode is a number staying suppressed, which is the correct default |
| **M1** | SMS tables; Twilio client; webhook; kill switches | **No.** No app code writes yet | Revert commits; drop empty tables | None — nothing reads them |
| **M2** | State machine, Verify, keywords, quiet hours, suppression enforcement | **No.** `sms_enabled` off | Revert; tables retain consent evidence (**never delete**) | None while the switch is off |
| **M3** | `marketing_send_claim` gains `person_key default null` | **No** — omitted ⇒ identical | Replace the function with the prior definition. One idempotent SQL file | **Highest of M1–M3.** A mistake here affects **every email send**. Invariants 9–10 are the gate; deploy alone, verify a real send, then continue |
| **M4** | Three bases introduced, all equal. `giftDisplacedRevenueCents` computed and recorded, **consumed by nothing** | **No** — proven no-op | Revert one commit | None if invariants 11–14 hold. **If a parity assertion needs editing, the refactor is wrong — stop** |
| **M5** | Widened floor snapshot; one contribution formula; alerting on cash contribution | **Reporting only.** No pricing, no payout | Revert; snapshot columns are additive | Noisier alerts at worst. Cannot affect a customer or a payout |
| **M6** | Credit eligibility gated on the gift-independent base | **YES — affects existing email win-back gifts** (CONFLICT 6) | Flag `benefits.gift_displaced_credit_eligibility` **off** — no deploy | A Pro/Elite/Black member redeeming credit on a gift order. Direction is *restorative* (they regain credit they were entitled to), so the risk is over-granting, bounded by the balance owed |
| **M7** | `commissionableBase` consumed; commission floor; B1 refund fix; audit fields | **YES — ambassador payouts** | Flag `benefits.gift_displaced_commission.sms` off ⇒ today's commission. **The B1 refund fix is not flagged** — it is a correctness fix that is a no-op on uncapped orders | Payouts. Gated on invariants 31–38 **and** D3 cases 1–6. Deploy alone; reconcile the next payout run by hand before the following one |
| **M8** | SMS marketing sends: caps, quiet hours, `sms_t4h`, back-in-stock, win-back | **YES — customers receive messages.** Needs marketing A2P | `sms_enabled` off ⇒ stops within one cron tick (≤15 min), no deploy | Customer-facing. Irreversible per message sent — a message cannot be unsent. Highest care |
| **M9** | D8: email win-back gift commission | **YES — payouts on an existing channel** | Flag `benefits.gift_displaced_commission.email` off | Payouts on email gift orders. **Never released with M7 or M8** |

### Rollback rules that hold across all milestones

1. **Consent evidence is never deleted.** Not on rollback, not on cleanup. `sms_subscribers`
   and `sms_consent_events` survive every revert.
2. **Flags before deploys.** Every behaviour change resolves through the control store, so
   the first response to a problem is a flag flip, not a release.
3. **One behaviour change per release.** M6, M7, M8 and M9 each ship alone. An unexpected
   payout or message total must have exactly one candidate cause.
4. **`sms_enabled = false` is the master stop** — halts all sending within one tick, and is
   the default from M1 until M8.
5. **M4 is the structural gate.** If it cannot land as a proven no-op, nothing after it is
   safe, and the design needs revisiting rather than forcing.

## D5. Status

**M0–M6 authorised** and the blueprint now reflects B1–B4. The only addition I made beyond
your decisions is **CONFLICT 6** — M6 needs its own flag because the existing email win-back
gift already absorbs units today, so the credit-eligibility fix is not inert. It is included
above and flagged separately.

**M7 remains gated**, per your instruction, on:
- invariants 31–38 green,
- D3 refund cases 1–6 green,
- and `computeContributionBeforeCommission` being the single authoritative implementation,
  proven by the SOT-08-style guard (invariant 20).

**Still external and not started:** transactional A2P approval, the Twilio privacy-policy
sentence, the storefront copy scrub, and counsel on §8.3 items 2/3/6 and D10. M8 cannot
begin without the first of those.
