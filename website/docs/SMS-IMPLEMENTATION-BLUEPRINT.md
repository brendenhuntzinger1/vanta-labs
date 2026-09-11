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
case.** The correct base is a new, explicitly-computed `commissionableBase` that adds back
both the winning discount *and* the retail value of absorbed gift units.

**This needs your decision (D1 in §13).**

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

## 13. Decisions I need from you

| # | Decision | Options | My recommendation |
|---|---|---|---|
| **D1** | **Commission base** (CONFLICT 1) | (a) keep today's post-discount base — ambassador silently cut by gift absorption; (b) add back discount + absorbed gift retail — costs more, matches your decision 4's intent | **(b)**, with a cap: never pay commission on more than the customer actually paid plus the incentive value. Model the cost before enabling |
| **D2** | **Double opt-in** | Full DOI for marketing, or single opt-in with DOI only for cart recovery | **Full DOI.** Carrier-forced for cart recovery anyway, and the inbound reply earns Known Sender status |
| **D3** | **SMS-only subscribers** | The gift is keyed on account email. Can someone subscribe by SMS with no account and hold a gift? | **No.** Require an account to *redeem*. Subscribe freely; gift attaches on account creation |
| **D4** | **Gift product** | GHK-Cu ($3.65 / $39.99, 11.0×) or Recon Water ($1.43 / $14.99, 10.5×) | **GHK-Cu** for the headline; Recon Water as the low-basket fallback |
| **D5** | **Store credit + points on a gift order** | Block (rule 2, §10) or allow | **Block.** Same gate as referral, same reason |
| **D6** | **Quiet-hours fallback** | Continental-safe 12:00–20:00 ET, or ask for timezone at signup | **Continental-safe.** Asking adds a field to a form that already has enough |

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
