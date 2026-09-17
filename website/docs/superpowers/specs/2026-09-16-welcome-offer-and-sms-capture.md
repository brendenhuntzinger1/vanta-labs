# Welcome offer and SMS capture: design addendum

Addendum to `2026-09-15-omnisend-marketing-system-design.md`, written
2026-09-16 after the owner decided the sign-up reward and asked for SMS
consent to be collected wherever a number is typed. Everything here is on the
branch and in the Omnisend account (all disabled or draft); nothing is
enabled, nothing has been sent, and no contact has been pushed.

## 1. The decision

Two decisions in one evening, and the second one stands. First the owner
weighed the GHK-Cu vial (a couple of dollars to the store by their figure)
against a percentage and asked for "either free GHK-Cu or 15 percent off";
the branch built both halves. Then: **"let's keep it 15 percent off their
order for now."** So the welcome offer as shipped is the **15% code alone**,
and the vial is built, tested and dormant:

| Half | What it is | Store record | State |
|---|---|---|---|
| The code | **15%** off a first order | `coupons` row, source `omnisend_welcome`, prefix `VLWELCOME`, bound to the address, one use, 14 days, retired by the first paid order (`retireContactCode`) | **live** (minted at sign-up) |
| The vial | a free GHK-Cu on a first order of $60 or more | `customer_offers` row, key `welcome_free_ghkcu` (`OFFER_CATALOG`), claimed through the click link that sets the `vl_offer` cookie, 14 days, closed by the first paid order | **dormant**: `WELCOME_GIFT_ENABLED = false` in `lib/offers/welcome-offer-terms.ts`; nothing mints it |

Flipping the flag re-arms everything below without another change: the
minter, the five contact properties, the welcome-offer flow's gift split and
the vial template, and the checkout rule that a welcome code typed over the
vial withdraws the vial (`quoteOrder`, `offerWithdrawnBy: "welcome_code"`,
the banner says so). The rule is pinned by `welcome-offer-exclusive.test.ts`
through the real `quoteOrder` whether or not the vial is offered.

The owner's second idea, an SMS-conditioned discount ("an additional 10
percent on top of any other coupon or promotion as long as they sign up with
SMS", or "save an additional 10 percent to opt in to SMS during checkout"),
is not built. The recommendation and the options are in the walkthrough
reply of 2026-09-16; a stacked, open-ended percentage cuts across the
store's single-winner discount rule and prices every future promotion ten
points deeper for the SMS list, so the shape wants deciding before code.

## 2. Where the offer is minted

`hooks.ts onMarketingOptIn` mints the code for a never-bought address on any
source except the checkout (a first-order discount handed to someone in the
middle of their first order), and then, only while `WELCOME_GIFT_ENABLED`,
the vial: only if the code succeeded and only if the vial can ship
(`unshippableGiftSlugsFor`, the cart-recovery ladder's own test). The push
that follows carries `vl_welcome_code`, `vl_welcome_ends`, `vl_welcome_ready`
and the five `vl_welcome_gift*` properties (text, claim link, minimum, date,
ready flag) with the recovery gift's three-way meaning: an object writes,
null clears, undefined leaves alone. The claim link is a bearer token that
exists only on that push; a later push that did not mint leaves it alone.

Pop-up sign-ups reach the store only through the reconcile's write-back. Two
changes make that a welcome rather than a day-late note:

* the write-back now runs on **every sweep tick (half-hourly)**, incremental
  by watermark; the full contacts push keeps its daily cadence
  (`reconcileOmnisendContacts({ push: false })`, `sweeps.ts`);
* a mirrored form subscriber is handed to the same `onMarketingOptIn` with
  source `omnisend-form`, once, so the offer is minted and pushed within the
  half hour.

The first paid order clears the gift properties (`order-hooks.ts onOrderPaid`
pushes `welcomeGift: null` beside the retired code); the reconcile clears them
when the row is spent or expired and leaves them while it is live
(`welcome-gift.ts liveWelcomeGift`).

## 3. How it reaches the inbox and the phone

A new automation, **VL · Welcome offer** (`6aab20de8c9071b61a081004`,
disabled), triggers on *entered segment* `VL · Welcome code ready`
(`vl_welcome_ready = yes`), so it fires the moment the store marks the offer
real: at once for a site sign-up, within the half hour for a pop-up sign-up,
never for a checkout opt-in or a prior buyer. It splits on
`VL · Welcome gift ready` (`6aab1fc6b9539893816902de`):

* vial minted: `welcome-offer` (`6aab2004072042c2a4193a25`): the store's own
  vial photograph, "A free GHK-Cu with your first order.", the terms from the
  properties, one primary button **Claim the free GHK-Cu** (the claim link),
  then "Or take 15% off instead" with the code, then the trust card; 20
  minutes later the text `welcome-offer-gift`;
* no vial: `welcome-offer-code` (`6aab2032072042c2a4193a3e`): the code alone;
  20 minutes later the text `welcome-offer-code`.

Both texts name the code, which every other text in the catalogue may not:
they sit inside a split the store's own flag guarantees, so the property is
never blank there. Both stay under 160 characters with the code and the
shortened link counted.

**VL · Welcome** keeps welcome-1 at once, and now waits an hour before a
split that texts the generic welcome only to a contact **without** the
offer (a contact with it is texted by the offer flow); the documentation and
ordering emails follow at the same day-2 and day-5 marks as before, with the
code card where the code exists. Their code card names the vial as the
alternative.

The pop-up leads with the offer ("15% off your first order."), states the
14 days, and carries the purity sentence
in its checkable form: "Every batch report we publish shows above 99%
purity." That sentence is true of the 38 published reports on 2026-09-16 and
must be re-read whenever a report is published; `compliance.md` forbids a
figure with no report behind it, and 19 active products have no published
report, so the sentence is about the published set and never "all our
products". It appears after 4 seconds (was 12), still once per 7 days, still
never to visitors arriving from an Omnisend message.

## 4. SMS consent, wherever a number is typed

Three surfaces collect it on the site (the account settings page already
did), all showing the same sentence from `lib/sms-consent-text.ts`, none ever
pre-ticked, each handing the tick to `lib/sms-consent.ts`:

| Surface | What is added | Recorded as |
|---|---|---|
| Sign-up page | an optional mobile number and the consent box under the email box; a tick without a textable number is refused with a message | `recordSmsConsent(source: "signup", userId)` before the email opt-in, so one push carries both channels |
| Checkout | the consent box under the delivery phone; the number is the delivery number, the box is the consent | `recordSmsConsent(source: "checkout", userId or null)` before the email opt-in |
| Account settings | unchanged box; an untick now also stops the address's own row | `recordSmsOptOut` |
| Omnisend pop-up | unchanged TCPA step | Omnisend's record; the reconcile mirrors STOP |

`sms_subscribers` (`src/lib/sql/sms-subscribers.sql`, in the harness list; to
be applied to production beside `omnisend-sync.sql`) is one row per lowercase
address: number, source, the sentence ticked, consented_at, opted_out_at. An
account holder's tick is mirrored into `customer_preferences` so the settings
page shows what the checkout collected. `contacts.ts` reads the account row
first and the address row second, so the Omnisend contact carries the phone
identifier with `sms: subscribed` and the consent source and time for a guest
who ticked at the checkout. A STOP reported by Omnisend stamps both rows
(`reconcile.ts applySmsOptOut`). A number typed with the box unticked is kept
nowhere as consent.

## 5. Tests

* `welcome-offer-exclusive.test.ts`: vial alone; welcome code withdraws it and
  names the reason; the synthetic code counts; another code stacks; the floor
  is a floor, not a choice; a win-back vial is untouched.
* `contact-payload.test.ts`: the five welcome-gift properties, their three
  meanings, independence from the recovery gift.
* `hooks-source.test.ts`, `order-wiring-source.test.ts`,
  `reconcile-source.test.ts`, `sweeps-source.test.ts`: minting order, the
  paid clear, the form-subscriber hook, the write-back-only tick.
* `coupon-validation.test.ts`: `source` on the result.
* `sms-consent.test.ts`, `sms-consent-wiring-source.test.ts`,
  `contacts.test.ts`: what a tick writes and never writes; one sentence
  everywhere; never pre-ticked; guest consent read by the sync.
* `assets.test.mjs` (46): the two templates, the segment, the two texts, the
  two automations, the pop-up copy.

## 6. Still the owner's

* Apply `sms-subscribers.sql` with `omnisend-sync.sql`.
* Confirm the GHK-Cu unit cost in the catalogue (see the walkthrough) before
  flipping `WELCOME_GIFT_ENABLED`.
* Decide the SMS incentive's shape (see §1) before any code for it.
* Enable `VL · Welcome offer` together with `VL · Welcome`, after the contact
  import and the seed sends (OPERATIONS.md §4).

---

# Addendum, 2026-09-17: the offer moves to texts and goes across the store

## 7. Why it moved off email

The owner's brief was "make the 15% first-order email signup offer easy to
find throughout the store". Halfway through building it he changed the
channel: *"i dont need that for email this should be for sms. most people are
already optin into my emails from the age gate."*

Checked against production before rewiring, read-only:

| Accounts | On the email list | `marketing_emails` true | `sms_marketing` true | Addresses that have paid |
| --- | --- | --- | --- | --- |
| 193 | 114 | 107 | 0 | 12 |

So the email list was already 59% of the account base and the SMS list was
empty. Fifteen per cent paid for an address the store already held; the same
fifteen per cent buys a channel that does not exist yet. (The premise was not
exactly right — the sign-up box is unticked by default and it is the checkout
box that defaults on for a US destination — but the conclusion holds on the
numbers either way.)

The email boxes on the sign-up page and at the checkout are **unchanged**:
same wording, same defaults, no discount attached. Nothing about email consent
was touched, because nothing needed to be.

## 8. The five placements

One sentence everywhere, from `src/lib/offers/welcome-offer-copy.ts`:

> Subscribe to texts for 15% off your first order. Valid for 14 days. Cannot
> be combined with other offers.

| Where | Shape | Notes |
| --- | --- | --- |
| Sign-up page | a line beside the SMS box | between the email box and the SMS box, so the offer and the consent are read together |
| Catalogue | a slim bar above the filters | `WelcomeOfferSignup variant="bar"` |
| Product page | one discreet link under Add to Cart | opens the form in place |
| Cart | a card above the order summary | `variant="card"` |
| Checkout | a panel under the SMS box | claims and applies the code in place |
| Home page | **nothing** | deliberately |

No dialogs anywhere. The controls are disclosures that push the page down and
close again; the only overlay on the catalogue remains the Omnisend pop-up,
now restricted to `/products` so it cannot appear on the home page or over a
checkout.

## 9. One eligibility, one code

`src/lib/offers/welcome-offer.ts` is the only thing that decides:

* `readWelcomeOffer(email)` → `eligible` | `claimed` (with the live code) |
  `ineligible`. Reads only: a page render never mints, so nobody's fourteen
  days start because they looked.
* `claimWelcomeOffer({email, phone, source, userId})` → records the consent
  first, then `ensureContactCode("welcome", …)`, which hands back a live code
  rather than minting a second. Verified on the harness: three claims for one
  address returned the same code and the same end date, and left one row.
* `grantWelcomeOfferForConsent(email)` is the half the sign-up route, the
  account preferences route and the Omnisend write-back call after they
  record consent their own way.
* Eligibility is one question: has this address ever paid for a product
  order? A refused read answers "yes", the safe direction.

Minting moved off the email path entirely: `onMarketingOptIn` no longer calls
`ensureContactCode`, it only reads a live code for the (dormant) gift. That is
what makes the sentence above true rather than decorative.

`GET|POST /api/offers/welcome` is the one endpoint. The session's address
always wins; only a guest may name one, because guest checkout is real here.
A guest is told "here is your code" or "not available" and never which of the
refusals it was. Ten claims per IP per hour.

## 10. Cannot be combined, enforced

Coupon stacking is a store-wide admin toggle and a promotion can licence its
own stack. With either on, a welcome code would have ridden on top of another
discount and contradicted its own printed terms. `quote-order.ts` now pins
`allowCouponStacking` and `promotionStacksCoupon` to false whenever the typed
coupon's source is a welcome source. Every other code keeps whatever the admin
and the promotion allow.

`welcome-code-never-stacks.test.ts` drives the real `quoteOrder` with stacking
switched ON and shows an ordinary code still stacking while a welcome code
does not, and a losing welcome code leaving the price exactly as it was.

At the checkout the shopper is told which of the two happened:
"Your 15% welcome discount is applied", or that a larger discount is already
on the order and offers cannot be combined. `couponOutcome.controlsPrice` —
the quote's own answer — decides, so the message can never outrun the money. A
code the shopper typed themselves is never overwritten to make room.

## 11. The minifier bug this caught

The sentence was first written as two template literals added together. Vitest
passed, the dev server rendered it correctly, and the **production bundle
shipped "Subscribe to texts for 15Valid for 14 days."** The minifier folded
the pair and dropped the first template's trailing quasi — which happened to
be "% off your first order. ", the entire offer.

It only bites when every substitution is a compile-time constant, which is
exactly what a copy module is made of; the two other places in the repo with
the same shape interpolate runtime values and are unaffected (checked in the
built chunks). Each half is now a standalone template and the sentence is
joined from the two identifiers.

Two guards in `welcome-offer-placements.test.ts`: the source may not contain
the template-pair shape, and the built client bundle must carry both halves
whole. This is the case for reading the rendered page rather than the source.

## 12. Verified on the harness (2026-09-17)

Local harness, production build, 390x844 and 1280x900.

| Check | Result |
| --- | --- |
| Checkout offer copy | the full sentence, after the minifier fix |
| Tick SMS with a number | code minted, applied, "Your 15% welcome discount is applied" |
| Totals | promo line −$10.35 on a $69.00 subtotal (15%), order total recalculated |
| No reload | email, phone and the ticked box all survive; nothing renavigates |
| Repeat claims | same code, same end date, one coupon row |
| Past buyer | refused, no code minted, nothing disclosed |
| Consent row | `sms_subscribers` source "checkout", consent sentence stored |
| Cart card | renders above the order summary, no horizontal overflow |

**Not browser-verified:** the catalogue bar and the product-page link. Both
pages require an account and the harness has no GoTrue (runbook §"GoTrue
auth"), so they cannot be rendered signed-in here. They are the same component
as the cart card with a different wrapper, and their mounting is pinned by
test. Worth a look on the Vercel preview before enabling.

## 13. Still the owner's

* Apply `sms-subscribers.sql` with `omnisend-sync.sql`.
* A2P 10DLC approval before any text is sent. The on-site claim does not wait
  on it: the code is issued and applied on the page, and the code email is
  sent by the welcome-offer flow.
* Re-check the catalogue bar and product link on a preview deployment.
* The pop-up now names the offer on its SMS step; re-read it in Omnisend
  before enabling.
