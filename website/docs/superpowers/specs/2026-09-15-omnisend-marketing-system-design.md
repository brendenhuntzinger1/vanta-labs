# Omnisend email + SMS marketing system — design

Date: 2026-09-15. Status: draft for owner review. Nothing here merges to
`main` or is switched on until the owner has been through it.

## 1. What this is

Omnisend becomes Vanta Labs' marketing channel of record for **email and SMS**:
sign-up forms, welcome, abandoned cart, abandoned checkout, browse abandonment,
post-purchase, cross-sell, replenishment, win-back, sunset, and one-off
campaigns, with SMS steps inside the flows wherever the contact has consented.

The store keeps sending its own **transactional** email through Resend
(order confirmation, shipping, delivery, refunds, password, account, ambassador
and wholesale mail). Those are receipts and account plumbing, not marketing,
and Omnisend has no equivalent that respects this store's rules.

Two halves, built together:

1. **In the repo** — a server-side sync that feeds Omnisend the contacts,
   consent, products and events it needs, plus the link and discount plumbing
   that lets an Omnisend email actually convert on an account-walled store.
2. **In the Omnisend account** — the brand template system, universal header
   and footer, every automation with its emails and texts, segments, the
   sign-up form and campaign drafts. Everything is created **disabled or in
   draft**; the owner enables flows one at a time after review.

## 2. Where things stand today (measured on production, 2026-09-15)

| Fact | Value |
| --- | --- |
| Public products | 34, in 9 categories (Blends, Cognitive Research, GLP Research, Growth Hormone, Longevity Research, Metabolic Research, Repair & Recovery Research, Solvents & Solutions, Specialty) |
| Email consent | 102 active guest subscribers + 96 account opt-ins (overlapping); 3 suppressions |
| SMS consent | 0 contacts, 0 phone numbers on file — the consent box exists in account settings, nobody has ticked it |
| Buyers | 12 distinct buyers, 16 paid product orders |
| Accounts | 178 |
| Omnisend account | connected as platform `other`, brand `6aa09072ca3afa5724d4d71a`, timezone America/Chicago, USD; JS snippet verified; **no** templates, automations, forms, segments, products or contacts yet |
| CAN-SPAM postal address | blank in production settings (`MARKETING_POSTAL_ADDRESS` and the admin email settings row) |
| In-house marketing engine | fully built: 4-stage cart recovery ladder, 7 automations (seeded off), campaigns, segments, 24h frequency guard, suppression, attribution |

## 3. Decisions

### 3.1 One owner of marketing sends, switched by a single setting

The in-house engine and Omnisend must never mail the same inbox on the same
day. The site's 24-hour frequency guard cannot see Omnisend sends, so the fix
is ownership, not coordination.

`OMNISEND_MARKETING_OWNER=true` (server env, default unset = false) hands
marketing to Omnisend. When it is set:

- the lifecycle cron skips `cartRecovery`, `emailAutomations`,
  `emailCampaigns` and browse abandonment with the logged reason
  `marketing owned by omnisend`, and the admin campaign send endpoint refuses
  with the same message;
- back-in-stock alerts and the coupon-announcement broadcast keep working
  (Omnisend cannot do back-in-stock for an API store, and the owner may still
  want the one-off broadcast); this is called out in the admin banner.

When it is unset nothing changes, which is how the branch can be merged before
the Omnisend flows are enabled and the two systems are swapped in one
deliberate step during the walkthrough.

### 3.2 Consent is copied exactly, never widened

Omnisend contact channel status is derived from the store's own record and
nothing else:

| Store fact | Omnisend email channel | Omnisend SMS channel |
| --- | --- | --- |
| In the consented audience (guest opt-in or account `marketing_emails`) and not suppressed | `subscribed` with `consent {source, createdAt}` | — |
| Suppressed (`email_suppressions`) or unsubscribed | `unsubscribed` with `statusChangedAt` | — |
| Known only from an order or account, no consent | `nonSubscribed` | — |
| `customer_preferences.sms_marketing = true` with a phone number | — | `subscribed`, consent `createdAt = sms_consent_at`, source `account-settings` |
| `sms_opted_out_at` set | — | `unsubscribed` |

Omnisend automations are created with sending thresholds
`email: subscribed, sms: subscribed`, so a non-subscribed contact who buys
gets order events recorded (for segments and lifetime value) but receives no
marketing.

**Write-back.** Unsubscribes and complaints that happen inside Omnisend are
mirrored into the store nightly: the reconcile job pages contacts changed since
its watermark and writes `email_suppressions {reason: 'unsubscribed', source:
'omnisend'}` for email opt-outs and `customer_preferences.sms_opted_out_at` for
SMS opt-outs. Form sign-ups collected by Omnisend are mirrored into
`marketing_subscribers {source: 'omnisend-form'}` so the store's consent record
stays complete and the existing unsubscribe page keeps working for them.

### 3.3 The account wall: every email link carries a grant

Products, cart and checkout are behind sign-in, and sign-in is where the 21+
and research-use attestations are collected. The in-house emails solve this
with a per-recipient signed click link that mints a 7-day browse grant only
for recipients whose account is already attested (`link-grant.ts`,
`recipient-attestation.ts`). Omnisend emails get the same treatment:

- every contact carries a custom property `vl_link`, a signed token
  `omnisend_link:v1:<email>:<expiresAt>` valid 30 days, minted at every
  contact upsert and refreshed by the nightly reconcile;
- template links point at `/api/email/omnisend-link?t=[[contact.custom_properties.vl_link]]&to=<site path>&utm_...`;
- that route verifies the token, checks attestation, mints `vl_email_grant`,
  (amended 2026-09-16: sets no attribution cookie; the landing URL's utm
  parameters are what order_attribution reads) and redirects to the
  validated site path. An unattested account lands on `/attest` with the
  destination preserved; an invalid token lands on sign-in with `next=`.
- cart and checkout URLs inside events (`abandonedCheckoutURL`, line-item
  `productURL`) are built per contact and already carry the token.

Known limit, accepted: product cards in the *recommender* sections link to the
plain catalogue URL, so a signed-out recipient lands on sign-in with the
product as `next=`. A signed-in recipient goes straight through. 45 of 47
subscribers had attested accounts when this was last measured.

### 3.4 Discount codes are minted by the store, one per contact

Omnisend only generates unique codes for Shopify, WooCommerce and BigCommerce.
For this store the site mints the code, binds it to the address and hands it to
Omnisend as a contact property. The existing cart-recovery code minter
(`coupons` with `assigned_email`, `max_redemptions 1`, `is_private`) is the
pattern; `validateCoupon` already refuses a code used by any other address.

| Property | Minted when | Default offer (owner to confirm) |
| --- | --- | --- |
| `vl_welcome_code` / `vl_welcome_ends` | first time a contact becomes email-subscribed | 10% off first order, 14 days |
| `vl_winback_code` / `vl_winback_ends` | nightly, for buyers with no paid order in 60 days and no live code | 15% off, 14 days |
| `vl_recovery_code` / `vl_recovery_ends` | when `started checkout` fires and the contact has not bought in 30 days and has no live recovery code | 10% off, 72 hours |

Emails show the code with a `text` block using the personalisation tag, never a
hard-coded code. If the property is empty the surrounding section is hidden by
an Omnisend content filter, so nobody sees a blank.

### 3.5 What Omnisend learns, and from where

- **Page views** stay browser-side from the existing snippet, exactly as
  today. The snippet still never receives an email address.
- **Product views** are sent **server-side** for identified visitors (signed
  in or holding an email grant), from the same place the store already records
  its own product views, at most once per address, product and hour. This is
  what browse abandonment triggers on.
- **Cart, checkout and order events** are server-side only, from the hooks the
  ad platforms already use, so a page that never opens (half of paid orders
  never load the confirmation page) still reports.
- **Identity** reaches Omnisend in the clear (email, phone, name, address),
  because Omnisend is the processor that sends the message. This is a change
  from the current policy wording and section 9 rewrites it.

### 3.6 SMS

- Starts from zero consent. The sign-up form's second step collects a number
  with the store's existing TCPA wording; the account-settings box remains the
  other opt-in path, and both flow into Omnisend as `sms: subscribed`.
- Every automated text is prefixed `Vanta Labs:`, keeps Omnisend's STOP/HELP
  compliance text on, contains no emoji or exclamation mark, and never
  contradicts research-use-only.
- SMS steps only exist in flows where a text plausibly earns its interruption:
  abandoned checkout (one text), abandoned cart (one text, later), win-back
  (one text), and campaign texts the owner writes. Welcome sends one text on
  SMS subscribe with the code.
- Quiet hours and per-state rules are Omnisend account settings; the owner
  checklist includes turning them on.

### 3.7 Look and voice

Templates use the **site palette**: charcoal `#0a0a0a` canvas, `#141414`
card, `#ffffff` text, `#a3a3a3` muted, champagne gold `#c7ae5e` rationed to
hairlines, eyebrows and one accent per email — never a solid gold block.
Buttons are the site's glass button: `#141414` fill, 1px `rgba(199,174,94,0.55)`
border, `#f6f4ef` uppercase label, 14px radius. Display type Fraunces with
Georgia fallback; body Manrope with Helvetica/Arial fallback; batch and lot
numbers in Geist Mono with Menlo fallback.

Copy follows `references/brand.md` and `references/compliance.md`: short
declarative sentences, describe what a thing is and never what it does, no
emoji, no exclamation marks, no dosing or human-use framing, no fabricated
proof, no unverified purity or lab claims, no manufactured scarcity. The
canonical trust sentences from `trust-claims.ts` are used verbatim. Every
email footer carries `RESEARCH_USE_SENTENCE`, the support address, the postal
address and the unsubscribe link.

## 4. Repo architecture

New directory `src/lib/marketing/omnisend/` (all `server-only` except the two
pure modules noted):

| Module | Responsibility |
| --- | --- |
| `client.ts` | Transport. Environment gate (`serverAdsReportingAllowed`) **before** reading `OMNISEND_API_KEY`; `Omnisend-Version: 2026-03-15`; 10s timeout; never throws; returns `{ok, status, error}`. |
| `config.ts` | `omnisendEnabled()` (key present + gate), `omnisendOwnsMarketing()` (the cutover flag). Pure, no I/O. |
| `contacts.ts` | `buildContactPayload()` (pure, tested) and `upsertContact()`; consent mapping from §3.2; custom properties and tags. |
| `link-token.ts` | Sign/verify `vl_link` (Web Crypto, edge-safe, namespaced like the other grants). Pure. |
| `codes.ts` | Mint welcome / win-back / recovery codes into `coupons` with `assigned_email`, one live code per kind per address. |
| `events.ts` | Pure builders for every event payload (§5.2) with exact Omnisend field names, plus `sendEvent()`. |
| `ledger.ts` | `omnisend_events_sent` claim / record / release triad (fail-open on ledger error, exactly like the ad ledger). |
| `catalog-sync.ts` | Products and categories → Omnisend via batches (PUT), every 30 minutes and on demand. |
| `hooks.ts` | The thin functions the store calls: `onMarketingConsentChanged`, `onSmsConsentChanged`, `onCartTracked`, `onCheckoutStarted`, `onOrderPaid`, `onOrderFulfilled`, `onOrderCancelled`, `onOrderRefunded`, `onProductViewed`. Each is `after()`-safe and never throws. |
| `sweeps.ts` | Cron jobs: `omnisendOrderBackstop` (unsent paid orders, 7-day lookback, mirrors `sweepUnsentMetaPurchases`), `omnisendContactsReconcile` (nightly full pass + write-back + token refresh + win-back codes), `omnisendCatalogSync`. |
| `ownership.ts` | `marketingSendBlockedByOmnisend()` used by the lifecycle cron and the campaign send route. |

Routes:

- `GET /api/email/omnisend-link` — the click/grant route from §3.3.
- `POST /api/admin/omnisend/sync` — admin-gated "run the reconcile / catalogue
  sync now" with a dry-run report, so the owner can see what would be pushed.

Tables (new SQL files under `src/lib/sql/`, RLS on, zero policies):

- `omnisend_events_sent (entity_id text, event_name text, event_id text,
  delivered bool, attempts int, first_sent_at, last_error text, primary key
  (entity_id, event_name))`.
- `omnisend_sync_state (key text primary key, value jsonb, updated_at)` — the
  reconcile watermark and last catalogue push.

Hook points (from the lifecycle map):

| Moment | Where | Event(s) |
| --- | --- | --- |
| Email consent recorded | `recordMarketingOptIn`, `recordSignupMarketingConsent`, account preferences route, OAuth portal | contact upsert (+ welcome code on first subscribe) |
| SMS consent / phone saved | account preferences route | contact upsert |
| Cart changed (email known) | `trackCart` in `cart-recovery.ts` | `added product to cart` |
| Checkout reached | `markCheckoutStarted` via `/api/cart/track` | `started checkout` (+ recovery code) |
| Order paid | the `paid_side_effects_at` claim block in `payment-webhook.ts` and the manual lane in `finalizeManualPayment` | contact upsert, `placed order` (paymentStatus paid) and `paid for order`; tag `customer` |
| Shipped / delivered | `notifyCustomer` in `shippo/service.ts`, gated on `notificationFor` | `order fulfilled` (once per parcel) |
| Cancelled | admin cancel action + webhook cancel branch | `order canceled` |
| Refunded | admin refund action + webhook refund branch | `order refunded` |
| Product viewed (identified) | beside `recordProductView` on the product page | `viewed product` |

Replacement and membership orders are never reported as purchases
(`isProductPurchaseOrder`).

## 5. Data contracts

### 5.1 Contact

```
identifiers: [ {type:"email", id, channels:{email:{status, statusChangedAt}}, consent:{source, createdAt, ip?}},
               {type:"phone", id:E.164, channels:{sms:{status, statusChangedAt}}, consent:{...}} ]
firstName, lastName (split from customer_name), countryCode (from the last order, default US), state, city, postalCode
tags: ["source: website", "customer" (has paid order), "attested" (account attested)]
customProperties:
  vl_link, vl_link_ends
  vl_attested (bool), vl_orders (int), vl_total_spent (number), vl_first_order_at, vl_last_order_at (date)
  vl_referral_code (the customer's own code, if any)
  vl_welcome_code / vl_welcome_ends, vl_winback_code / vl_winback_ends, vl_recovery_code / vl_recovery_ends
```

Email identifiers are case-sensitive in Omnisend; the store lowercases before
sending, always.

### 5.2 Events (origin `api`)

| Event | eventVersion | Key properties |
| --- | --- | --- |
| `viewed product` | `v4` | `product {id: slug, title, price, currency, url, imageUrl, status, categories:[{id, title}]}` |
| `added product to cart` | `""` | `cartID`, `abandonedCheckoutURL`, `currency`, `value`, `lineItems[]`, `addedItem` |
| `started checkout` | `""` | same as cart |
| `placed order` | `v2` | `orderID`, `orderNumber`, `createdAt`, `currency`, `subTotalPrice`, `totalPrice`, `totalDiscount`, `totalTax`, `shippingPrice`, `paymentStatus: "paid"`, `fulfillmentStatus`, `discounts[{code}]`, `lineItems[]`, `billingAddress`, `shippingAddress`, `orderStatusURL` |
| `paid for order` | `v2` | same order shape |
| `order fulfilled` | `v2` | order shape + `tracking {courierTitle, courierURL}` |
| `order canceled` / `order refunded` | `v2` | order shape (+ `refundedLineItems` for refunds) |

Line items: `productID` (slug), `productVariantID` (dose id), `productTitle`,
`productVariantTitle`, `productPrice`, `productQuantity`, `productSKU`,
`productImageURL`, `productURL` (with the contact's link token),
`productCategories [{id, title}]`. Prices are always taken from the catalogue
or the order row, never from the browser.

`eventID` is deterministic: `${entity}:${eventName}` for orders, the cart
session id plus a content hash for carts, `${email}:${slug}:${hour}` for views.

### 5.3 Catalogue

Product `id` = slug; `url` = `${siteUrl}/products/${slug}`; `status` from
`stock_status`; `currency` USD; `title` = name; `description` = short
description trimmed to 1000 chars; `defaultImageUrl` and `images` absolute and
passed through `resolveProductImage`; `categoryIDs` = slugified category
titles, created first as product categories; `variants` = doses (`id`
`${slug}#${doseId}`, price from sale price or price, `strikeThroughPrice` from
compare-at, per-dose status), or a single default variant when a product has no
doses. Unpublished or archived products are pushed once as `notAvailable` so
Omnisend stops recommending them.

## 6. Flows (Omnisend automations)

All created **disabled**. Every flow: sending thresholds subscribed/subscribed;
frequency limiter as noted; exit on `placed order` where a purchase ends the
conversation; UTM `source=omnisend`, `medium=email|sms`,
`campaign=<flow key>`.

| Key | Trigger | Steps | Notes |
| --- | --- | --- | --- |
| `welcome` | `subscribed to marketing` | E1 immediately "Welcome to Vanta Labs" (what the store is, COA library, code) → 2d → E2 "Every batch has a published report" → 3d → E3 "How ordering works" (dispatch cutoff, destinations, tracking, code reminder) | once per lifetime. SMS: one text on SMS subscribe with the code (separate `welcome-sms` flow triggered by SMS consent). |
| `abandoned-cart` | 1h inactivity after `added product to cart` | E1 "Your cart is saved" (cart section) → 23h → E2 "Still here when you are" (cart + COA angle) → 48h → split on segment *Bought in last 30 days*: no → E3 with `vl_recovery_code`; yes → E3 without code. SMS text at +26h for SMS subscribers. | exits on `placed order`, `started checkout`; once per 7 days |
| `abandoned-checkout` | 1h inactivity after `started checkout` | E1 "Finish when you are ready" (checkout link) → SMS at +3h → 21h → E2 → 48h → E3 with/without code (same split) | exits on `placed order`; once per 7 days |
| `browse-abandonment` | 4h inactivity after `viewed product` | E1 "You were looking at this" (viewed products section) | exits on `added product to cart`, `placed order`; once per 7 days |
| `post-purchase` | `paid for order` | 1d → E1 "Your batch report" (how to find the COA for what they bought, support, what happens next) → 9d → E2 cross-sell with `product_recommender` (popular, excluding purchased 30d) | once per 30 days |
| `replenishment` | `paid for order` | 45d → split *Bought in last 30 days*: no → E1 "When you need to reorder" (recommender: personalized, fallback popular) | once per 60 days |
| `win-back` | `paid for order` | 60d → split *Bought in last 30 days* no → E1 "It has been a while" with `vl_winback_code` → SMS +1d → 30d → E2 "Last note from us" | once per 180 days; exits on `placed order` |
| `sunset` | `entered segment` *Unengaged 120 days* | E1 "Do you want to keep hearing from us?" → 7d → split on clicked E1: no → remove tag `engaged`, add tag `sunset` | the *Campaign audience* segment excludes `sunset`, so cold addresses stop dragging deliverability |

## 7. Segments

`Subscribers (email)`, `SMS subscribers`, `Customers` (paid ≥1),
`Repeat customers` (paid ≥2), `VIP` (total spent > 500 or champions/loyalists),
`Bought in last 30 days`, `Lapsed 60`, `Lapsed 90`, `Engaged 90 days`
(opened or clicked in 90d), `Unengaged 120 days` (subscribed, no open or click
in 120d, added > 120d ago), `Subscribers who never bought`,
`Browsed, no order (30d)`, `Attested account holders` (`vl_attested`),
`Campaign audience` (email subscribed, not `sunset`, not unengaged).

## 8. Sign-up form

One popup, built from Omnisend's email-and-SMS two-step template and restyled
to the palette: step 1 email ("Batch reports, restocks and subscriber offers.
No noise."), step 2 optional phone with the store's TCPA consent sentence,
success step naming the welcome code arriving by email. Targeting: after 12
seconds or exit intent, once per 7 days, desktop and mobile, never to visitors
arriving from Omnisend messages, US and Canada. Tags `form_subscriber`,
`source: omnisend-form`. Created disabled; A/B setup left for later.

## 9. Policy and copy changes in the repo

- Privacy policy: the Omnisend paragraph now says the store sends Omnisend the
  email address, phone number (only with SMS consent), name and postal address
  from orders, order and cart contents, and product views for identified
  customers, because Omnisend sends the store's marketing on its behalf; the
  "this site never hands it your email address" sentence is removed and the
  SMS section says texts are delivered through Omnisend.
- Cookie policy: same correction in the Omnisend bullet.
- `omnisend-source.test.ts`: the no-email-from-client-code invariant stays;
  the policy assertions move to the new wording; a new suite pins the server
  sync (gate before key, ledger fail-open, consent mapping, field names).

## 10. Testing

- Pure modules (`config`, `link-token`, `events` builders, `contacts` payload,
  consent mapping, `ordersNeedingOmnisendEvents`) get behavioural tests with
  exact field names pinned, in the style of `meta-conversions.test.ts`.
- The transport gets the `ads-environment-enforcement` treatment: every refusal
  reason → zero fetch calls; production → fetch reached with the right headers.
- Source-invariant tests pin: the gate runs before the key is read; the ledger
  claim is an insert with fail-open; `OMNISEND_MARKETING_OWNER` is honoured by
  the lifecycle cron and the campaign send route; policies name what is shared.
- Harness: the link route redirects an invalid token to sign-in and a valid
  attested token to the destination with the grant cookie set.

## 11. Rollout, in order

1. Merge the branch with `OMNISEND_MARKETING_OWNER` unset and
   `OMNISEND_API_KEY` set in Vercel. Nothing changes for customers; contacts,
   consent, catalogue and events start flowing into Omnisend.
2. Owner checks Omnisend: contacts match, products render, events arrive.
3. Set `OMNISEND_MARKETING_OWNER=true` FIRST (amended 2026-09-16: the
   in-house engine must stand down before any Omnisend flow is live, or both
   mail the same inbox), then enable flows one at a time in Omnisend, starting
   with abandoned checkout, each after 48 hours of clean results on the last.
   The exact order is docs/omnisend/OPERATIONS.md §4.
4. Enable the form. Send the first campaign from the drafts.

Rollback is the reverse, in this order: disable the Omnisend flows first,
then unset the owner flag (in-house flows resume on the next lifecycle tick).
Consent is never widened by any step, so there is nothing to restore.

## 12. What only the owner can do

- Create an Omnisend API key and set `OMNISEND_API_KEY` in Vercel (production
  only).
- Verify `vantalabsresearch.com` as a sending domain in Omnisend (DNS records).
- Set up the SMS sender (toll-free number and verification) and quiet hours.
- Supply the postal address for the footer.
- Confirm the three default offers in §3.4 or change them.
- Enable each flow and the form after reviewing the test sends.

## 13. Out of scope for this round

Back-in-stock through Omnisend (not available for API stores), push
notifications, Omnisend product reviews, replacing transactional email, and a
second sign-up form or landing page. Each can be added later without changing
anything here.
