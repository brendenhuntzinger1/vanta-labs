# Vanta Texts — SMS lifecycle strategy

**Status:** research and strategy for review. **No implementation has started.**
**Date:** 2026-09-11 · **Author:** Claude (research pass)
**Decision owner:** Brenden

> This document is engineering and commercial analysis. It is **not legal advice.**
> Section 8 marks the items that need counsel rather than an engineer.

---

## 0. Bottom line up front

Build the SMS programme. **Do not ship the standing 15% as specified.**

The infrastructure half of your brief is right and the timing is good: A2P 10DLC is
still pending, nothing can send, and that is exactly the window in which to build the
consent, verification and orchestration spine — the part that is legally dangerous to
retrofit. I recommend building all of it.

The offer half is where the evidence goes against you, and it goes against you on
arithmetic from your own codebase rather than on marketing theory. Six findings, each
verified against source or production data:

| # | Finding | Where verified |
|---|---|---|
| 1 | A standing 15% costs **13.80% of every subtotal it touches** and needs a permanent **+24% to +38% order-frequency lift** to break even. The best published *randomised holdout* for SMS lift is **13%** — and that brand was not also giving 15% away. | `PROCESSING_FEE_DEFAULT_PERCENT = 8`, dose costs measured live |
| 2 | It **cannibalises all four paid membership tiers**. They grant 5 / 8 / 10 / 12% at $9.99–$89.99 per month. A free 15% beats Black. Both headline perks die — bulk savings too. | `membership-tiers-seed.sql` |
| 3 | **The commission leak is real.** Commission is paid on `subtotal − discount_amount` regardless of which discount won. When SMS wins, the store pays *more* and the ambassador earns *less*. | `payment-webhook.ts:1038`, verified |
| 4 | **Store credit and points stack on top of an SMS win.** They are refused only when `referralDiscountApplied` is true. An SMS win is not a referral win. | `store-credit-redemption.ts:61,87`, verified |
| 5 | **The profit guard cannot stop an unprofitable order.** It is report-only by explicit prior decision: *"PROFIT FLOOR — MEASURED, REPORTED, NEVER ENFORCED AGAINST THE CUSTOMER."* Your requirement that no combination create an unprofitable order is **not currently achievable** by the existing guard. | `quote-order.ts:1484`, verified |
| 6 | The phrase **"while you remain an active SMS subscriber" makes texting STOP cost the customer money.** That is a penalty for opting out, in front of an A2P vetter, on a peptide catalogue, next to an affiliate programme. | Twilio rejection taxonomy 30941 / 30951 / 30962 |

**What I recommend instead:** a **free gift on the first SMS-attributed order**, plus
early access and restock priority. Your own cart-recovery code already did this
arithmetic and reached this conclusion for the other channel:

> *"At this store's real dose costs a gift buys far more perceived value per dollar
> than a percentage does: GHK-Cu costs $3.65, shows $39.99 — 11.0x … a percentage 1.0x,
> and it scales with the cart. A percentage costs roughly 12-14% of contribution on any
> cart; a gift costs 3-8%."* — `cart-recovery-tiers.ts:17-30`

The store has already written down the right answer for one channel and is about to
adopt the wrong one for another.

**One number that should frame every decision below:** Vanta has **15 paid orders from
10 distinct customers, all time**, and is **already discounting 22.7% of subtotal**.

---

## 1. Research findings

Twenty-two research agents; ~1,400 tool calls; primary sources throughout. Full
per-topic output is in the session scratchpad. The findings that change decisions:

### 1.1 The incrementality problem is the whole ballgame

After searching hard, **no published controlled test shows what SMS adds to an already-good
email programme.** Every vendor case study (Klaviyo's Linksoul +82%, Laura Geller 3.9x,
Tata Harper +43%) reports *attributed* revenue with no control group. Attentive's
"multi-channel subscribers are 2.0–2.8x more valuable" is a correlation between engagement
and channel count, not a causal claim.

The mechanism that makes this dangerous is documented: Klaviyo attributes conversions
last-touch with a **5-day window for both email and SMS**, so a fast SMS systematically
steals credit from an email that would have converted anyway. *A brand can show large
"SMS revenue" with zero incremental lift.*

The one randomised holdout I could find — Urban Outfitters via Attentive — measured **13%
lift** (19% among email-active subscribers). That is below the break-even lift a standing
15% requires.

**This is why Section 9 makes holdout testing mandatory rather than optional.** Vanta
already has an unusually honest attribution system (`marketing_source_kind`, one primary
channel, `creditedElsewhere`, internal-address exclusion). It would be a shame to bolt a
self-congratulating channel onto it.

### 1.2 Benchmarks, and which of them are real

Postscript's 2026 report (17,000 Shopify stores, 2025 data) and Omnisend's 2026 report
(150,000 brands, 321M SMS) are the most solid last-touch figures available:

| Flow | CTR (25th–75th) | Conversion | Revenue per message |
|---|---|---|---|
| Campaigns | 2.87–8.01% | 0.12–0.54% | $0.11–$0.55 |
| Abandoned cart | 9.53–17.28% | 3.97–7.84% | $3.52–$10.95 |
| **Back in stock** | **36.71–58.70%** | **7.18–13.80%** | **$5.92–$13.34** |
| Welcome / popup | 11.34–22.27% | 9.55–25.56% | $8.28–$23.78 |

All last-touch. Note the shape: **triggered messages earn 10–100x what campaigns earn.**
Back-in-stock is the standout, and Vanta already has a back-in-stock capture (email-only).

**Health & Wellness runs materially worse than all-industry** — $0.12–$0.51 EPM on
campaigns, unsubscribe 0.34–1.12% vs 0.33–0.88%, and SMS subscribers acquired at roughly
**57% of the all-industry rate.**

Message cost is a rounding error: **~$0.0125 per segment** all-in on Twilio direct
($0.0083 + ~$0.0042 blended carrier fee). Last-touch break-even is ~$0.018/message;
incrementality-adjusted, ~$0.14. **The messages are not the cost. The discount is.**

### 1.3 Deliverability: a brand-new 813 number is the worst case

Attentive's Jan 2026 release states filtered-inbox messages see **30–40% lower clickthrough
and conversion**. iOS 26 routes "Unknown Senders" to a separate inbox with no notifications.
A brand-new 10DLC number with zero inbound history is precisely that profile.

Attentive's patented **"two-tap"** exists to solve this, and it is a mechanism, not a
flourish: the unit collects **email first**, then opens the device's native SMS composer
with a pre-filled body so **the subscriber sends the first message**. User-initiated
threads are classified as Known Sender. 56% of Attentive's surveyed marketers now use it;
43% send a contact card in the welcome flow for the same reason.

**This is reproducible on plain Twilio with an `sms:` deep link. It needs no vendor, and it
belongs in v1, not v2.** Otherwise the programme will look broken — low CTR — for reasons
invisible in Twilio's delivery receipts, which will report the message as delivered.

### 1.4 Carrier rules constrain the design more than the law does

From Twilio's own published rules, these are design constraints, not preferences:

- **Abandoned-cart SMS is limited to ONE reminder per cart event within 48 hours**, and
  requires a text-based double opt-in. **Vanta's 4-stage cart sequence cannot be mirrored
  on SMS.**
- **SMS consent must be "independent and separate" from email consent.** One checkbox
  cannot buy both.
- **Twilio's STOP handling is per-number and does not generalise.** Vanta must own
  suppression state centrally.
- **No platform ships a cross-channel frequency cap.** Klaviyo states plainly that email
  (16h) and SMS (24h) Smart Sending "are managed independently and do not affect each
  other." **A global cap is something Vanta must build, not buy** — and Vanta already has
  the right primitive for it (§7).

### 1.5 Category risk is real, and it is about the website, not the message

Peptides appear on no SHAFT list and in no carrier prohibited-category list. **That is the
wrong place to look.** A2P 10DLC vetting reviews the **brand's website**, and Twilio's
rejection taxonomy contains two codes that could catch Vanta, both marked *not eligible for
resubmission*:

- **30941** — prescription drug / controlled substance content
- **30951** — third-party lead generation / MLM ← **your ambassador programme**
- (and **30962** deceptive marketing, which names "false health claims, exaggerated product
  benefits" and "fabricated urgency or scarcity")

Error 30883 states the decisive point: *"Some prohibited categories are disallowed based on
the business type itself, not only the message text."*

The FDA's **April 2026 warning-letter wave against seven peptide sites** made this sharper:
FDA held that an RUO disclaimer **is not a shield**, because intended use is inferred from
the whole storefront — benefit copy, testimonials, before/after imagery, bundled
bacteriostatic water. *"You cannot disclaim the shopping cart."* **The evidence FDA reads is
the same evidence a 10DLC vetting crawler reads**, so one copy discipline satisfies both.

Also: **Klaviyo's AUP flatly prohibits "prescription medications, pharmaceutical products or
services, medical therapies" as a business category** — which would endanger *email* as well
as SMS. A dated Aug 2026 Trustpilot review records Klaviyo terminating a research-peptide
seller purely on industry classification. **Twilio's own AUP is conduct-based with no
category list.** Your instinct to go direct to Twilio is architecturally correct, not just
cheaper.

### 1.6 The legal picture, corrected

Two things the conventional advice gets wrong as of today:

- **The FCC's one-to-one consent rule is dead.** The Eleventh Circuit vacated it in
  *Insurance Marketing Coalition v. FCC* (24 Jan 2025); the mandate issued 30 Apr 2025; the
  FCC deleted the language from 47 CFR 64.1200(f)(9) effective 29 Aug 2025 (90 FR 42137).
  **The pre-2023 prior-express-written-consent standard governs.**
- **The 2024 revocation rules are live in the parts that matter** — revocation by any
  reasonable means, the seven per se opt-out keywords, a 10-business-day ceiling — but the
  cross-topic "revoke-all" provision at 64.1200(a)(10) is **deferred to 31 January 2027**
  (FCC DA-26-12, 6 Jan 2026).
- **Quiet hours are genuinely unsettled.** The 8am–9pm rule sits in 64.1200(c)(1) and
  applies to "telephone solicitation" to a "residential telephone subscriber"; courts are
  actively split on whether it reaches consented texts to cell phones at all. **Treat as a
  lawyer question.** Engineering answer: implement the strictest reading and move on.

### 1.7 Incentive structure — the evidence against depth

Postscript's census of its **50 highest-converting popups**: **64% offer just 10% off**,
only 12% offer more than 20%, and the **single best phone-capture rate (16%) came from a
plain 10% off.** Depth is not what drives opt-in.

And: Twilio lists **"incentivized opt-in with prizes" as a non-remediable rejection
(30945)**, which removes sweepstakes and giveaways from the option set entirely.

---

## 2. Competitor and e-commerce examples

| Source | What they actually do | What Vanta should take |
|---|---|---|
| **Attentive** | Email-first two-tap; 8 display rules, one per unit; **explicitly recommends blocking `/cart` and `/checkout`**; separate SMS-only unit for exit intent; marketing checkboxes **unchecked by default**; default quiet hours 8pm–12pm plus per-state rules live since 13 Nov 2025 | The two-tap mechanic; the cart/checkout block rule; the two-unit architecture |
| **Postscript** | Ships default delays per automation; 64% of top popups offer 10% off; publishes restricted-industry list | The default delays as a starting point; the evidence that depth ≠ opt-in |
| **Klaviyo** | Models SMS consent **separately** from email; Smart Sending per-channel and explicitly non-interacting; 5-day last-touch window for both channels | The separate-consent model. **Not** the attribution model — it over-credits SMS |
| **Twilio** | Conduct-based AUP, no category list; Verify API for OTP; Messaging Services with Advanced Opt-Out | Direct integration, as you proposed. Correct call |
| **DTC brands generally** | Overwhelmingly a **one-time welcome code**, not a standing discount | The one-time structure — and the fact that almost nobody runs standing |
| **Peptide/RUO sellers** | Largely email-only; those running SMS keep copy scrubbed of indication and dosing | Copy discipline; two-campaign split |

**On standing discounts specifically:** I looked for brands running an always-on
subscriber discount and found the pattern is rare in DTC and concentrated in low-margin
grocery/commodity retail, where it functions as a loyalty-card price tier with a
membership fee attached. **Vanta already has that product — it is the membership tier
programme**, and a free 15% destroys it.

---

## 3. Recommended Vanta SMS strategy

**Position SMS as the store's low-volume, high-signal channel: the one that only speaks
when something is genuinely time-sensitive.** Restocks, drops, order state, and one cart
nudge. That is also, conveniently, the profile that survives carrier review and keeps a
brand-new 813 number out of the filtered inbox.

### 3.1 The offer — recommended

> **JOIN VANTA TEXTS**
> **Restock alerts · new drops · member-only releases**
> *Plus a free GHK-Cu on your first order as a Vanta Texts member.*

- **Free gift on first SMS-attributed order.** Costs $3.65, shows $39.99 (11.0x). Uses the
  `customer_offers` mechanism that already exists and is already hardened — hashed bearer
  token, one live per email, atomic reserve, `min_subtotal_cents` re-judged after every other
  discount.
- **Early access / restock priority.** Costs nothing. This is the *real* reason to give a
  peptide retailer your phone number: stock is intermittent and the good doses sell out.
  Back-in-stock is also the single highest-converting SMS flow in the benchmark data
  (36–59% CTR).
- **No standing percentage.** Nothing to cannibalise the membership tiers, nothing to leak
  into commission, nothing that makes STOP expensive.

This is a **one-time incentive with an ongoing non-price benefit** — the structure the
evidence supports, and the structure that does not put a discount in front of an A2P vetter.

### 3.2 If you want to keep a standing discount anyway

You reaffirmed the 15% idea in your brief, so here is the safe version rather than a refusal.
If you run a standing percentage, these five constraints are what make it survivable. They
are not optional — items 2 and 3 are the difference between a discount and an unbounded
liability:

1. **Rate: 15% is actually a good choice.** I checked every competing rate — bundle
   5/8/12/20, membership 5/8/10/12, referral 10, bulk 5/12, ambassador personal 20. **15%
   collides with none of them.** That matters because both contests pick with a strict `>`
   and array position decides ties; a colliding rate produces same-amount/different-winner
   splits, which previously caused every such checkout to be refused as an altered total.
2. **Cap it per order** (e.g. max $20 off) or **to the first N orders.** Uncapped, it scales
   with the cart and does nothing on the large ones anyway — the bundle ladder already
   absorbs it (see §5.2).
3. **Block store credit and points on an SMS win**, exactly as they are blocked on a
   referral win. One line in `store-credit-redemption.ts`. Without it, the worst legal order
   the engine will complete is **−$54.68 cash contribution with `belowFloor` reported false.**
4. **Decide the commission rule explicitly** (see §5.3). Doing nothing means the store pays
   more and the ambassador earns less.
5. **Never say "while you remain subscribed" in customer-facing copy.** Say the benefit is
   for members; let it lapse silently on opt-out. Same mechanic, no penalty framing.

**My recommendation remains the gift.** The capped-15% variant models at **−$35,380** against
the gift's **+$2,057** on the same assumptions (§5.6).

---

## 4. Proposed customer journeys

### 4.1 Collection points, ranked by expected value

**Important correction to the brief's premise:** Vanta's catalogue sits **behind an account
wall** (`access-policy.ts` is default-closed; `requiresAccount()` in `middleware.ts:979`).
Almost everyone who can see a product is already signed in. The classic anonymous-visitor
popup is therefore the *wrong* primary unit here — the high-value surface is the
**signed-in account context**, where identity is already server-established.

| # | Collection point | Why | Effort |
|---|---|---|---|
| 1 | **Back-in-stock → "text me instead"** | Highest-intent moment in the store. Highest-converting SMS flow in the data. `back-in-stock.ts` already exists, email-only — this is an *extension*, not a build | Low |
| 2 | **Account → Notifications** | Identity already established; no interstitial; the natural home for a standing preference. `account-settings-client.tsx:358` already has the email equivalent | Low |
| 3 | **Post-purchase, on order confirmation** | "Get shipping updates by text" — genuine value, and the compliance line is clean *if* marketing consent is a separate second box | Medium |
| 4 | **Checkout opt-in** | A **separate, unchecked** marketing box, distinct from the delivery phone already collected at `checkout/page.tsx:1146` | Medium |
| 5 | **Product-page unit, two-tap** | Email-first, after delay or 25% scroll, **hard-blocked on `/cart` and `/checkout`** | Medium |
| 6 | **Exit-intent, SMS-only** | Separate lean unit, second page view and beyond | Low |

**Explicitly not doing:** a popup after login. You asked for this and the research agrees —
it is the worst available moment. The account wall means every session starts with a login,
so a post-login popup would fire on essentially every visit.

### 4.2 The join journey

```
Signed-in customer taps "Text me when this restocks"
   → phone field, normalised to E.164
   → disclosure block shown and its VERSION recorded
   → Twilio Verify sends a 6-digit code          [rate-limited, Fraud Guard on]
   → customer enters code
   → sms_consent row: status=verified, marketing=false
   → confirmation SMS: "You're in. Reply STOP to opt out, HELP for help.
      Msg&data rates may apply. ~4 msgs/month."
   → SEPARATE marketing box, unchecked, own disclosure
   → marketing=true only when that box is ticked and verification is complete
   → welcome SMS #1 (contact card, ask them to save the number)
   → gift offer issued via issueCustomerOffer()
```

Marketing eligibility is **never** activated by verification alone. Verification proves the
number; the second box is the consent.

### 4.3 Intent tiers and channel assignment

| Intent | Email | SMS | Why |
|---|---|---|---|
| Product viewer | browse follow-up (exists, off) | **no** | Too weak for a paid channel |
| Cart abandoner | 4 stages (exists) | **one nudge, ~1h, only if no email click** | Carrier cap is one per 48h |
| Checkout abandoner | exists | **one nudge** | Highest intent below purchase |
| Payment failure | exists | **yes — transactional** | Genuinely urgent; not marketing |
| First-time buyer | post_purchase | order + shipping only | Don't sell to someone who just bought |
| Repeat buyer | replenishment | restock alerts | |
| VIP / high-LTV | campaigns | drops, early access | The real SMS audience |
| Lapsed | winback_30/60 | **one win-back, after email fails** | |
| Back-in-stock | exists | **yes — the flagship** | Highest CTR in the data |

---

## 5. The 15% question — economics and rules

### 5.1 What it actually costs

A standing 15% costs **13.80% of every subtotal it touches** — the 15% less the 8%
processing fee that scales down with it (`PROCESSING_FEE_DEFAULT_PERCENT`).

At the store's measured dose-level cost ratio it **destroys 19–26% of per-order
contribution** and needs a **permanent +24% order-frequency lift** to break even; at the
pessimistic cost basis, **+38%**.

The messaging it protects costs **$0.96–$3.61 per subscriber per year.** The give-away is
**21–80x the carry cost.** "Messages are cheap" is true and irrelevant.

**Which margin is real.** Three figures live in the repo and disagree. I measured it:

| Source | Figure |
|---|---|
| `cart-recovery-tiers.ts` docblock | 83.7% (COGS 0.163) |
| `PRICING_STRATEGY.md` (Jul 2026, EVO sheet) | 58.5% |
| **Measured live, 2026-09-11** | **81.2%** (COGS 0.1883, 39 of 46 default doses costed) |

They reconcile: `products.product_cost_cents` holds inherited EvoLabs figures that
`quote-order.ts` measures at **1.4–6.8x the true landed cost and refuses to price from.**
Dose-level costs are the corrected ones. **81% is real at list price; 62% is the pessimistic
bound.** Both are modelled below.

### 5.2 The bundle ladder already absorbs most of it

`compete(raw) = max(0, raw − quantityBundleSavings)` means the SMS 15% is only worth what it
**beats Bundle & Save by**:

| Units | Bundle | SMS effective extra |
|---|---|---|
| 1 | 0% | **15%** |
| 2 | 5% | 10% |
| 3–4 | 8% | 7% |
| 5–9 | 12% | 3% |
| 10+ | 20% | **0%** |

**The discount bites hardest on single-vial orders** — which already carry the full fixed
$7.93 postage — **and does nothing on the large carts** you actually want to encourage. It is
exactly backwards.

### 5.3 The stacking analysis

The good news first: **"one discount, greatest savings wins" holds.** A 15% SMS candidate
*competes*, it does not pile on top of Buy-3-Get-1 or the bundle tiers. The naive fear does
not happen.

The damage is in the five things that sit **outside** the contest and therefore stack
unconditionally:

| Interaction | Current engine behaviour | Verdict |
|---|---|---|
| **Ambassador commission** | `commissionableSubtotal = max(0, subtotal − discount_amount)`, paid regardless of winner. `DEFAULT_MINIMUM_QUALIFYING_ORDER = 0` | **Leak.** On a $324.97 basket at 20% tier: store gives away **$103.99 (32.0% of list)**, contribution falls $242.56 → $142.47. The ambassador's own commission drops $58.49 → $55.24. **Store pays $11.70 more; partner earns $3.25 less** |
| **Store credit** | Refused only when `referralDiscountApplied`. SMS win ≠ referral win | **Stacks** |
| **Loyalty points** | Same gate | **Stacks** |
| **Free shipping** | Outside the race (`isShippingWaived`) | Stacks by design |
| **Cart-recovery gift** | Separate mechanism | Stacks |

**The worst order the engine will complete today** if `sms_member` is added naively: 4 units
of a no-stored-cost SKU at $74.99, 8% bundle, a stacking promotion plus a 10% recovery gift
package, free shipping sitewide, a $30.15 gift, a 20% commission tier, $75 credit, $50
points — **gross profit −$27.77, cash contribution −$152.77.** It prices, it charges, it
ships, and `belowFloor` reports **false**, because `buildProfitFloorSnapshot` has no field
for store credit or points.

### 5.4 Membership cannibalisation

| Tier | Price/mo | Discount | Net to member, 1 order/mo @ $325, after a free 15% |
|---|---|---|---|
| Essential | $9.99 | 5% | **−$1.74** |
| Pro | $24.99 | 8% | **−$3.49** |
| Elite | $39.99 | 10% | **−$0.24** |
| Black | $89.99 | 12% | **−$1.99** |

**Every tier goes under water.** Essential and Pro become strictly irrational purchases.
Bulk savings (Elite/Black: 5% at $500, 12% at $1,000) is beaten by 15% at every basket size,
so the second headline perk dies with the first. Black's $250 store-credit minimum is above
a typical AOV, so a Black member who cancels costs close to the full $899.90/year.

### 5.5 The guard cannot save you

Your brief says *"Never allow an unintended combination to create an unprofitable order"* and
*"use the existing promotion/profit guard."* **Those two instructions are in conflict**, and
it is worth knowing why before choosing:

> *"This block used to end in `throw new Error("Promotion unavailable on this order.")` …
> On this store's own catalogue that refused 8 of 24 ordinary baskets — a single $39.99 vial
> among them … The owner's rule is now: never reject an otherwise valid order for margin;
> complete it and tell me."* — `quote-order.ts:1484`

That was a deliberate decision and I would not reverse it. **So the bound has to move
upstream**: constrain what the SMS benefit can combine with *at price time*, rather than
trying to catch a bad total afterwards. That is §3.2 items 2–4.

### 5.6 Programme P&L — 1,000 subscribers, year one

Assumes 3 orders/yr at $185 AOV, tier mix 45/30/20/5. Counterfactual $396,345.
**These lift figures are assumptions — Vanta measures none of them today.**

| Structure | Assumed lift | Year-one P&L |
|---|---|---|
| 15% standing | 0% | **−$80,395** |
| 15% standing | 10% + 2% member switch | −$75,521 |
| 15% standing | 25% + 5% switch | −$52,223 |
| 15% standing | 40% + 5% switch | −$15,451 *(still negative)* |
| 10% standing | 15% | −$41,226 |
| 15% capped at $20/order | 20% | −$35,380 |
| 20% off first order only | 10% | −$25,954 |
| **Free GHK-Cu on first order** | **8%** | **+$2,057** |
| **Early access, no discount** | **5%** | **+$159** |

Only the gift and the no-discount options clear the bar at plausible lifts. Note that even a
**40% permanent lift** — three times the best measured holdout — leaves standing-15% negative.

### 5.7 If you ship it anyway — the rules

- Attach to a **server-established `customerUserId`**, never a body-supplied phone.
- **Guests may opt in at checkout but the benefit starts on their next signed-in order.**
  A body-supplied identifier that grants a discount is exactly what `create-session/route.ts`
  already refuses twice (for `offerToken` and for currency).
- **Price-time entitlement, not a reserved token** — so opt-out mid-checkout is handled for
  free by the existing re-price-and-refuse-underpayment path.
- Revoked the instant `marketing_consent` goes false; restored on genuine re-subscribe.
- **Re-subscribe cooldown** (e.g. 30 days) so opt-out/opt-in cannot be farmed.
- Never rendered as a code, never in a URL, never exposed by an endpoint that takes an
  arbitrary phone number.
- **The customer must never be shown a worse price for being a member** — the engine already
  guarantees this by picking the max, and the copy must match.

---

## 6. Database and infrastructure changes

All additive. No existing table altered except two nullable columns. Conventions follow
`src/lib/sql/*.sql`: hand-written idempotent SQL, RLS enabled with no policies
(deny-by-default, service-role only), receipt recorded in `migrations-applied/`.

```
sms_subscribers          one row per E.164 number
  phone_e164 (PK) · user_id · status (pending|verified|opted_out)
  verified_at · last_verify_at · verify_attempts
  marketing_consent (bool, default FALSE) · marketing_consent_at
  consent_source · consent_disclosure_version · consent_ip · consent_user_agent
  opted_out_at · opt_out_keyword · resubscribed_at · resubscribe_count
  carrier · line_type          -- from Twilio Lookup; block VOIP at signup

sms_consent_events       append-only. THE legal evidence. Never updated, never deleted.
  id · phone_e164 · event (shown|granted|revoked|resubscribed|verified)
  disclosure_version · exact_copy_shown · ip · user_agent · source_url
  twilio_message_sid · created_at

sms_suppressions         phone_e164 (PK) · reason · created_at
                         SEEDED AT MIGRATION TIME with every phone already in the
                         database (orders.phone, ambassadors.phone, partners.phone,
                         customer_preferences.phone) — see §8.1

sms_send_log             mirrors email_send_log exactly, so §7's shared cap works
  id · phone_e164 · campaign_type · reference_id · template_key
  sent_at · status · twilio_message_sid · segments · price_cents
  delivered_at · failed_at · error_code · clicked_at

sms_delivery_events      Twilio status callbacks, idempotent on MessageSid
sms_link_clicks          first-party short links (NEVER a public shortener — 30963)

orders  + sms_attributed_send_id (nullable)   -- attribution, write-once
        + sms_benefit_applied_cents (nullable)
```

**Infrastructure:**
- **No Twilio SDK.** Match the repo's hand-written-fetch pattern (Shippo, Resend): one
  module owns the HTTP call, nothing throws, every failure returns a typed result carrying
  `safeToRetry`, every `fetch` carries `AbortSignal.timeout(...)` — there is a source-text
  test enforcing that last one.
- **Credentials** via the two-tier pattern: env var documented in `.env.example`, layered
  under an operator-editable control-store key, sealed with AES-256-GCM (add to
  `SECRET_CONTROL_KEYS`), redacted on read.
- **Webhook** (`/api/webhooks/twilio`) copies the existing pattern exactly: fail closed on
  unconfigured secret (503), validate `X-Twilio-Signature` constant-time, read the event id
  from the signed body, claim in a unique-indexed ledger before any work.
- **Kill switch**: `sms_enabled` in the control store, defaulting **off**. Precedent already
  exists — `PHONE_LOGIN_ENABLED = false` in `account-auth-form.tsx:31` gates a *complete,
  dormant Supabase phone-OTP lane* on Twilio Trust Hub approval. Its placeholder is
  `+1 813 555 0000`. That is the exact pattern, already written.
- **Cron**: extend `/api/cron/lifecycle` (already 15-minutely, already runs six jobs through
  one runner with a watchdog). **No new cron.**

---

## 7. Email + SMS orchestration

**The key insight: Vanta already has the cross-channel choke point. It just needs to stop
being email-shaped.**

`marketing_send_claim` (`marketing-frequency-guard.sql`) takes
`pg_advisory_xact_lock(hashtext('marketing_send:' || email))`, looks for any send inside the
quiet window, and either **inserts the row itself** (claimed) or answers *deferred*. **The
claim is the record, not a lookup** — two cron jobs starting in the same instant serialise on
the lock.

**Recommendation: generalise the lock key from the email address to a PERSON.**

```
'marketing_send:person:' || coalesce(user_id::text, lower(email), phone_e164)
```

One claim, one quiet period, both channels. This gives Vanta the global cross-channel
frequency cap that **no commercial platform ships** — because the primitive is already there
and already correct. It is a small change to one SQL function plus a shared send-log view.

**Cart recovery, concretely.** The carrier cap allows **one** SMS per cart per 48h, so SMS
cannot mirror the four stages. Proposed:

```
T+1h    email stage 1 (t30m window)      [unchanged]
T+4h    SMS nudge — ONLY IF: consented AND verified AND no human click
        on stage 1 AND cart still open AND inside quiet hours
T+12h   email stage 2                     [unchanged]
T+24h   email stage 3 (gift)              [unchanged]
T+72h   email stage 4 (gift + percent)    [unchanged]
```

SMS gets **one** slot, placed where email has already failed to land. Everything else is
untouched — the existing sequence, windows, `MIN_STAGE_GAP_MS`, tier bands and offer
cooldowns all stay exactly as they are.

**Purchase suppression — no race.** `markAbandonedCartsRecovered` is already called
**synchronously from the payment webhook's paid transition**, with the sweep's own paid-order
check as a second line. The SMS stage claims its slot through the **same
`reserveAndSendStage` ordering** that fixed incident C-06 — frequency guard → claim the
unique `(abandoned_cart_id, stage)` slot → mint → send. Because the SMS stage is *a stage*,
a recovered cart stops it by exactly the mechanism that already stops the email stages.
**Nothing new to get wrong.**

---

## 8. Compliance requirements

### 8.1 The immediate hazard — before any code

There are **~35 distinct phone numbers already in the database**: 16 distinct from
`orders.phone` (39 rows), 21 from `ambassadors.phone`. **Every one was collected for
shipping or contact. None carries marketing consent.**

**Texting them is the single most likely way this programme generates liability.** TCPA
statutory damages are $500–$1,500 **per message**.

**Therefore: the very first migration seeds `sms_suppressions` with every phone number
already in the database.** Not a warning in a document — an enforced row. Numbers leave
suppression only by completing verification *and* ticking a marketing box. This also makes
the "we have a head start on our list" temptation structurally unavailable.

### 8.2 Engineering requirements

- **Marketing consent separate from transactional consent**, separate from email consent,
  separate from the delivery phone. Four different things.
- **Unchecked by default.** Always.
- **Consent record** must capture: timestamp, source URL, disclosure version, **the exact
  copy shown**, IP, user agent, and the verification event. *(Today's email consent records
  only a `source` string and `opted_in_at` — this is a genuine upgrade, and worth
  backporting to email later.)*
- **Disclosure block**, every collection point: identity, message frequency
  ("~4 msgs/month"), "Msg & data rates may apply", STOP/HELP, links to Terms and Privacy,
  and **"Consent is not a condition of purchase."**
- **Keywords**: STOP, END, QUIT, CANCEL, UNSUBSCRIBE, REVOKE, OPT OUT (the seven per se
  keywords) plus free-text review. HELP returns identity + contact + opt-out instructions.
- **Opt-out honoured immediately** in Vanta's own state — do not rely on Twilio's per-number
  handling, which does not generalise.
- **Quiet hours** 8am–9pm **in the recipient's local time**, derived from the number, with
  stricter state windows (FL, OK, WA, MD, TX, OR, CT). Transactional exempt.
- **Frequency cap** via the shared person-level claim (§7).
- **Privacy policy** needs the specific mobile-number non-sharing sentence Twilio requires.
  **Vanta's current policy does not contain it.** This is a registration blocker.
- **Two A2P campaigns, two numbers**: transactional (Customer Care) and marketing,
  separately opted in. **Register transactional first.**
- **Block VOIP line types at signup** via Twilio Lookup; rate-limit verification per
  phone / per IP / per account; Fraud Guard on — SMS pumping fraud is a real cost.

### 8.3 Needs counsel, not an engineer

1. Whether quiet hours reach consented texts to cell phones — courts are split.
2. Whether the ambassador programme trips **30951** (third-party lead gen), and what the
   privacy policy must say about affiliate data sharing to avoid it.
3. Whether the peptide catalogue reads as **30941** (prescription drug) to a vetter, in
   light of the FDA's April 2026 position that an RUO disclaimer is not a shield.
4. State mini-TCPA exposure (FL FTSA as amended, OK, WA, MD).
5. Consent-record retention period.
6. **Whether "15% while you remain subscribed" is a penalty for revoking consent.** If you
   keep the standing discount, get this one answered first.

---

## 9. Measurement plan

Vanta's existing attribution is unusually honest — one primary `marketing_source_kind` per
order, `creditedElsewhere` so a recovered cart is not also campaign revenue, internal-address
exclusion (which was stripping 25% of carts and 60% of reported recoveries), human-vs-scanner
click classification, and `readable: false` under 150 delivered. **SMS must join that system,
not sit beside it.**

**Per subscriber:** source, verification completed, consent date + disclosure version,
messages sent, delivered, failed (by error code), clicks, orders, revenue, **cost**, opt-out
state.

**Per flow/campaign:** sent → delivered → clicked → restored → checkout → order → net revenue
→ **SMS cost → gift cost → contribution profit**, plus revenue per recipient and per message.

**Admin customer view** — the record you asked for:
`SMS MEMBER — ACTIVE · verified +1 813 ••• 4417 · consent: back_in_stock, 2026-09-14 ·
last SMS 3d ago · 11 sent · 4 clicks · 2 orders · $287 attributed · opt-out: none`

### False attribution — the part that matters

Three guards, all of which this codebase has already learned the hard way:

1. **One primary channel per order.** Reuse `marketing_source_kind` / `finalizeMarketingSource`
   and its `offer_redeemed > click > recovery_coupon > referral_code > ad_touch > organic`
   ranking. An SMS click that loses is an **assist**, reported separately, never summed.
2. **A short window.** Email uses 7 days. **SMS should use 24–48 hours**, because SMS is read
   in minutes and a long window is precisely how SMS steals credit from email.
3. **A holdout, from day one.** Hold back 10% of eligible subscribers from each SMS flow and
   report **incremental** revenue beside attributed revenue. Given §1.1, a programme that
   cannot show incremental lift is not working, however good its attributed number looks.

---

## 10. Implementation plan

**Nothing sends until A2P registration completes.** Every phase below is safe to build and
merge with `sms_enabled` off.

| Phase | Work | Gate |
|---|---|---|
| **0. Now** | Seed `sms_suppressions` from existing phones. Add the Twilio privacy sentence. Scrub storefront copy of indication/dosing language **before** submitting for vetting. Register **transactional** campaign first | — |
| **1. Spine** | Schema + migrations. `sms_subscribers`, consent events, suppression, send log. E.164 normalisation + Lookup. Twilio client (hand-written fetch). Webhook with signature validation. Kill switch off | Unit + SQL tests |
| **2. Consent** | Twilio Verify flow. Disclosure blocks + versioning. STOP/HELP/keyword handling. Quiet hours. Person-level frequency claim (§7) | Consent, STOP, duplicate-number, quiet-hour, cap tests |
| **3. Collection** | Back-in-stock SMS → account notifications → post-purchase → checkout → product-page two-tap. In that order, measuring each | Mobile 390×844 via the local harness |
| **4. Transactional** | Order confirmation, shipping, payment failure. **These are the messages that earn Known Sender status** | Live once transactional A2P clears |
| **5. Benefit** | Whichever §3 offer you choose. `sms_member` candidate in *both* resolvers, same array index, plus `DISCOUNT_TYPES` in `ambassador-financial-invariants.test.ts` — **one commit, or the cart previews a total the card doesn't charge** | Parity + stacking + profit tests |
| **6. Lifecycle** | Cart-recovery SMS stage. Win-back. Restock. Drops | Suppression + orchestration tests |
| **7. Measure** | Admin SMS section, attribution, holdout | Nav + permission-matrix tests |

**Testing** follows the repo: vitest, DB-backed suites gating on `VANTA_TEST_DATABASE_URL`,
SQL suites applying the shipped migration unmodified, and browser verification against the
**local pgrst-shim harness** — not `npm run dev` — per `BROWSER-TESTING-RUNBOOK.md`.
Full Playwright journey (Google sign-in → catalog → SMS signup → verification → membership
active → cart → checkout → best promotion chosen → purchase → recovery suppressed) and the
opt-out journey (STOP → inactive → marketing stops → benefit unavailable → **order history
unaffected**) come at the end of phases 5 and 6.

---

## Decisions I need from you

1. **The offer.** Gift (recommended) · capped 15% · standing 15% as briefed. Everything in
   §5 is the case for the first.
2. **Commission rule** when a non-referral discount wins — pay on pre-discount subtotal, on
   post-discount (today's behaviour), or make SMS and referral mutually exclusive.
3. **Membership tiers.** If a standing discount ships, the tiers need repricing or
   repositioning in the same release.
4. **Counsel** on §8.3 — particularly items 2, 3 and 6.

---

## Appendix — what I verified vs assumed

**Verified against source or live data:** all cost ratios, tier prices and discounts, bundle
and bulk tiers, processing rate, postage, commission base (`payment-webhook.ts:1038`), store
credit and points gating (`store-credit-redemption.ts:61,87`), profit-floor behaviour
(`quote-order.ts:1484`), gift costs and retails, order and subscriber counts, discount rate,
existing phone-column inventory, all Twilio fees and rejection codes, the current state of
the one-to-one consent rule and the 2024 revocation rules.

**Assumed and labelled:** $185 AOV, 3 orders/customer/year, tier mix, hostage share, and
every incremental-lift figure in §5.6. **Nothing in the repo measures opt-in rate,
incrementality, list composition or real AOV — and those are the numbers that decide this.**

**Corrected during research:** one agent reported that ambassadors are *zeroed* when another
discount wins. That is wrong — they are paid on the reduced base. The verified behaviour is
in §5.3, and the distinction matters: the problem is a quiet 5.6% cut to partners plus a
larger bill for the store, not a broken commission.
