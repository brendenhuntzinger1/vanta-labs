# Omnisend email design: the premium and conversion review

Written 2026-09-16 after the owner asked whether the emails look premium,
whether they will convert, and how they compare with high-value ecommerce
brands on Omnisend. Every number below is Omnisend's or Klaviyo's published
figure with its source; none is a promise about Vanta Labs. The store's own
results will come from `order_attribution` and Omnisend's reports once the
flows run, and nothing here should be read as a forecast.

## 1. What the platform's own data says matters

Omnisend's 2025 data across 27,000 brands and 470 million automated sends
(https://www.omnisend.com/blog/email-marketing-benchmarks/):

| Flow | Open | Click | Conversion | Revenue per email |
|---|---|---|---|---|
| Welcome | 35.5% | 3.9% | 2.1% | $6.16 |
| Abandoned cart | 37.1% | 4.1% | 1.7% | $3.59 |
| Back in stock | 58.8% | 21.3% | 6.7% | $9.14 |
| Order follow-up | 47.7% | 4.1% | 0.9% | $1.75 |
| Cross-sell | 42.1% | 3.0% | 0.9% | $0.95 |
| Win-back | 33.1% | 2.0% | 0.5% | $0.51 |

Automations earn $3.41 per email against $0.155 for campaigns (same
source). Abandoned cart plus welcome produce 76% of all automation orders
(https://www.omnisend.com/resources/reports/2026-ecommerce-marketing-report/).
Klaviyo's 2024 flow report puts abandoned cart at 3.3% placed-order and the
top decile at $28.89 per recipient
(https://www.klaviyo.com/blog/abandoned-cart-benchmarks). The launch order in
`OPERATIONS.md` §4 already leads with checkout, cart and welcome for this
reason.

Why carts are abandoned, from Baymard's running study of 70% abandonment
(https://baymard.com/lists/cart-abandonment-rate): unexpected extra costs
40%, slow delivery 20%, distrust of the card form 19%, unclear returns 13%.
Those are answered by facts, not by discounts.

## 2. What premium brands on Omnisend actually do

Structure only, from Omnisend's published customer stories; no brand's copy,
layout or assets are borrowed.

* A Norwegian outdoor-apparel brand runs an abandoned-cart email with one
  hero image, two or three lines of copy, no product grid and no discount;
  57% of the people who click go on to buy
  (https://www.omnisend.com/resources/customers/amundsen/).
* A luxury single-origin chocolate brand that refuses to discount runs a
  story-led welcome series and a no-discount cart series that converts 44%
  of its recipients (https://www.omnisend.com/resources/customers/toak/).
* A raw-denim brand's three-email cart series converts 38%, with the third
  email doing most of the work
  (https://www.omnisend.com/resources/customers/naked-and-famous/).
* A British luxury childrenswear brand leads its welcome on heritage and
  craft and includes a best-sellers grid
  (https://www.omnisend.com/resources/customers/rachel-riley/).
* A boutique olive-oil brand's third welcome email is its popular products,
  and its cart flow branches on cart contents
  (https://www.omnisend.com/resources/customers/island-olive-oil/).

The pattern: one hero, a short headline, one action, real products with
prices where they help, facts about delivery and payment, and the offer, if
any, only once and late. Nothing about countdowns or scarcity, which the UK
regulator has ruled misleading where deadlines are not real
(https://www.lewissilkin.com/en/insights/2025/10/13/times-up-asa-rules-on-countdown-timers-and-pricing-claims-102lp6g)
and which `compliance.md` forbids here anyway.

## 3. Omnisend's own design guidance, and where the set stands

| Guidance (source) | Vanta Labs set |
|---|---|
| One primary call to action, front and centre (https://www.omnisend.com/blog/email-cta/, https://www.litmus.com/blog/the-fold-in-email) | One primary button per email, pinned by `assets.test.mjs`. Since 2026-09-16 it is the site's own ivory primary, so it is the visual focal point; product tiles use the outlined secondary |
| 60:40 text to image, body 14 to 16 px, single column (https://www.omnisend.com/blog/email-design-best-practices/) | Body 16 px Manrope, headings 26 px Fraunces, single column, text-led |
| Each image under 100 KB, under 2000 px, and the whole email under 100 KB (https://support.omnisend.com/en/articles/6247929-optimize-email-load-time) | Hero 37 KB (960 px), logo 51 KB, product photographs about 23 KB each from the store's own catalogue |
| Abandoned-products block, one recovery button, product image and price shown (https://support.omnisend.com/en/articles/6092208-new-email-builder-abandoned-products-content-block) | Every cart, checkout and browse email carries it; the primary button returns to the cart or checkout |
| No discount in the first cart email, brand story before discount for high-consideration goods (https://www.omnisend.com/blog/abandoned-cart-emails-best-practices/) | Emails one and two carry no offer; the banded code or gift appears only in the third, once, minted by the store |
| Shipping cost, delivery time and payment security in every cart email (Baymard; https://www.klaviyo.com/blog/reduce-cart-abdonment) | Since 2026-09-16 a "good to know" card under the products in cart and checkout emails one and two, and in the welcome: dispatch cutoff, destinations, tracking, encrypted checkout, each the site's canonical sentence. No free-shipping figure, because that threshold is an admin setting |
| Product Recommender in welcome, post-purchase and win-back (https://support.omnisend.com/en/articles/6154813-add-configure-product-recommender-item) | Welcome 1 (since 2026-09-16), post-purchase 2, replenishment and win-back 1 carry a three-product grid of real photographs and prices from the synced catalogue |
| Dark-mode proofing: preview Gmail iOS and Outlook, avoid pure black and pure white (https://support.omnisend.com/en/articles/10118006-preview-optimize-emails-for-dark-mode) | Background is #0a0a0a, not pure black; the owner runs Omnisend's dark-mode preview before the first send (CHECKLIST §7) |

## 4. The hero image

The welcome email is the only template with a photograph. It is the store's
own product vial (the GHK-Cu poster used on the home page, a real Vanta Labs
product on the brand's dark field), at the owner's instruction. A generated
generic vial was tried on 2026-09-16 and rejected: an email for a brand whose
whole argument is documentation should not open on a product that does not
exist. Product photographs elsewhere are the catalogue's own listing images,
pulled by Omnisend at send time.

## 5. What is honest to say about conversion

Nothing here is a conversion promise. The set now matches the structure the
platform's data rewards and the structure premium brands on the platform use.
Whether it converts for Vanta Labs is measured, not assumed: `OPERATIONS.md`
§2 and §3 define the attribution and the metrics, and §3.1 states every
timing as a hypothesis with the first experiments worth running. The first
readable numbers need roughly 150 delivered emails per row before any change
is made on their account.

## 6. Still the owner's

* Seed every template to an owner mailbox once the sender domain is
  authenticated, and open them on a phone in Gmail with dark mode on.
* Replace the footer placeholder with the postal address.
* Decided 2026-09-16: the welcome offer is 15 percent off a first order,
  alone for now; a free GHK-Cu half is built and dormant
  (`docs/superpowers/specs/2026-09-16-welcome-offer-and-sms-capture.md`).
  Still to decide: an SMS incentive's shape, the win-back percentage (15)
  and the recovery bands, before enabling the flows that carry them.
