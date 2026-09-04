# Email lifecycle engine — audit and design

Date: 2026-09-04
Status: implemented on `claude/vanta-email-marketing-audit-8vtad1`; owner
decisions and external items listed at the end.

Scope: every automated and one-off customer email — welcome, cart and checkout
recovery, post-purchase, replenishment, win-back, campaigns — plus the
deliverability, consent, frequency and attribution machinery they share.
Transactional mail (receipts, shipping, auth) is audited for copy and
classification only.

## 1. What exists today (BEFORE)

Mapped from source, the production database (read-only) and Resend.

### Flow map, as found

| Flow | Trigger | Audience | Delay | Email | CTA → destination | Conversion event | Exit |
|---|---|---|---|---|---|---|---|
| Account confirmation | signup | the signer-up | 0 | branded, transactional | Confirm → `/auth/confirm` | confirmed | n/a |
| Order confirmation | payment paid | buyer | 0 | transactional, send-once | View order → `/account/orders/…` | — | n/a |
| Shipping update / delivered | Shippo tracking | buyer | 0 | transactional | Track package / Explore Vanta | — | n/a |
| Cart recovery t30m | signed-in cart snapshot | signed-in shoppers only | 30 min after **first_seen** | reminder | Restore my cart → `/cart/restore` | order by same email (webhook) | paid order |
| Cart recovery t12h | same | same | 12 h | reminder | Resume checkout | same | same |
| Cart recovery t24h | same | same | 24 h | **5 % coupon** | Resume checkout | same | same |
| Cart recovery t72h | same | same | 72 h | same coupon or a fresh one | Resume checkout | same | same |
| welcome_no_purchase | account created | **accounts with `marketing_emails = true`** | 3 d | 15 % one-time offer | Shop now → `/products` | attributed order (7-day cookie) | any paid order |
| post_purchase | paid order | consented buyers | 14 d | generic thank-you | Reorder → `/products` | attributed order | none |
| winback_30 | last paid order | consented buyers | 30 d | **15 % + free shipping** | Shop now | attributed order | new order (episode key) |
| winback_60 | last paid order | consented buyers | 60 d | free GHK-Cu | Claim now | attributed order | same |
| Campaign | operator | segment ∩ consented − suppressed | operator | composed | tracked click | attributed order | — |
| Birthday, back-in-stock, membership | various | various | — | — | — | — | — |

### What the data says

| Fact | Value | Consequence |
|---|---|---|
| Paid product orders / distinct buyers / repeat buyers | 10 / 6 / 1 | Reorder-window analysis is not statistically possible; timing is set from product cycle (a vial lasts roughly 4–8 weeks of research use) and revisited when data exists |
| Accounts with `marketing_emails = true` | **0 of 5** rows (38 auth users) | The welcome automation has never had an eligible recipient. Signup has no opt-in checkbox and the default is `false` |
| Checkout opt-ins (`marketing_subscribers`) | 7 | The only working consent path is the checkout checkbox |
| Cart-recovery stage sends | 12 / 11 / 10 / 8 | 4 emails in 72 h to every abandoner |
| One shopper, 21–29 July | 4 carts, 4 sequences, **4 discount codes in 9 days**, then 5 paid orders | Recovery trained a repeat buyer to wait for a code |
| Cart `c1bb28a8` | t24h and t12h sent in the **same minute** | Catch-up bug: every stage older than its delay fires in one sweep |
| Cart `e7a0adde` | t12h sent 39 days after t72h | A stage has no expiry window |
| Coupons with `source = cart_recovery` | 339 | The old re-mint loop (already fixed) left them behind |
| Resend last 30 days | 141 sent, 96.5 % delivered, 1 complaint (simulator address), 0 opens/clicks tracked by Resend (tracking off — ours is used) | Deliverability is healthy |
| Resend bounce suppressions | 2 real addresses bounced **before** our webhook existed (23/27 Aug) | Not in `email_suppressions`; Resend blocks them, we still count them as audience |
| Campaigns ever sent | 0 (one draft) | Campaign system unexercised in production |
| `attributed_campaign_id` / `attributed_automation_key` orders | 0 / 0 | Attribution pipeline untested by real traffic |

### Weak or missing

P0 — integrity / compliance
1. Multiple recovery stages fire in one sweep for a cart older than a stage's delay; a stage never expires, so re-enabling one mails months-old carts.
2. An emptied cart stays `active` and keeps mailing: the tracker refuses empty snapshots.
3. No cross-flow frequency control: a shopper can receive a cart email, a welcome offer and a win-back offer on the same day, with three different discounts.
4. Recovery discounts are unconditional: every cart, every time, including repeat buyers days after a purchase.

P1 — revenue
5. Welcome flow is dead: no signup opt-in, so no account ever consents.
6. Guest checkouts (the majority) are never tracked, so checkout abandonment for guests is unrecoverable.
7. Post-purchase is one generic email at day 14 with a "REORDER" button to the catalogue; no education, no replenishment reminder keyed to the order.
8. Win-back 1 at day 30 gives 15 % + free shipping to customers who are inside a normal reorder window.
9. Abandonment clock starts at `first_seen_at`, so a shopper still editing their cart at minute 40 gets "you left something behind" at minute 60.

P2 — deliverability
10. Webhook URL carries a guessable secret (`?secret=ohiostatebuckeyes88`). Anyone who guesses it can suppress arbitrary addresses.
11. DMARC `p=none` with no `rua`; no reports reach anyone.
12. Provider message id is stored only for automation sends, so campaign and recovery delivered/bounce rates cannot be joined.
13. Two bounced addresses live only in Resend's suppression list.

P3 — lifecycle coverage: no welcome intro, no replenishment, no education email.
P4 — segmentation: no first-time / repeat / high-value segments; no engagement segment.
P5 — copy: "You left something behind", "Your cart is still waiting for you", "YOU'RE MISSING OUT", "SHOP NOW" throughout; shipping update says "your order status changed: shipped".
P6 — no A/B testing (see §8 for why not now).

## 2. Benchmarks used

- Klaviyo, abandoned cart flow: 2–3 messages, first at 1–4 h, purchasers filtered out of later messages, segment by cart value / first vs returning. [help.klaviyo.com/hc/en-us/articles/115002779411](https://help.klaviyo.com/hc/en-us/articles/115002779411), [klaviyo.com/blog/abandoned-cart-email](https://www.klaviyo.com/blog/abandoned-cart-email)
- Klaviyo, welcome series: 3 emails is the modal best performer; first immediately, ≥1 day between the rest. [help.klaviyo.com/hc/en-us/articles/115002775172](https://help.klaviyo.com/hc/en-us/articles/115002775172)
- Klaviyo, post-purchase: 217 % higher open rate and 90 % higher revenue per recipient than campaigns; educate, then cross-sell. [help.klaviyo.com/hc/en-us/articles/360028872611](https://help.klaviyo.com/hc/en-us/articles/360028872611)
- Klaviyo, win-back: start at ~1.5× the average reorder interval, not the 180-day default; stop after three unanswered messages. [help.klaviyo.com/hc/en-us/articles/115002775192](https://help.klaviyo.com/hc/en-us/articles/115002775192), [academy.klaviyo.com/…/anatomy-of-a-flow-winback](https://academy.klaviyo.com/en-us/quick-guides/anatomy-of-a-flow-winback)
- Klaviyo, lifecycle guide: top brands run 10+ flows; segment offers by first-time / repeat / VIP / lapsed rather than blanket discounts. [klaviyo.com/composer/lifecycle-email-marketing-guide](https://www.klaviyo.com/composer/lifecycle-email-marketing-guide)
- Shopify, abandoned checkout: default 1 h, then 24 h and 72 h; replenishment timed from purchase date and consumption window. [shopify.com/blog/abandoned-cart-emails](https://www.shopify.com/blog/abandoned-cart-emails), [help.shopify.com/…/abandoned-checkouts](https://help.shopify.com/en/manual/promoting-marketing/create-marketing/abandoned-checkouts)
- Gmail/Yahoo bulk-sender requirements (one-click unsubscribe, <0.3 % complaint rate) and CAN-SPAM (postal address + opt-out on every commercial message) — already satisfied in code, verified in `docs/EMAIL-DELIVERABILITY-RUNBOOK.md`.

## 3. Target lifecycle

Timing rationale: a research vial is typically consumed over 4–8 weeks. With 4
observed reorder intervals there is no basis for a data-derived number, so the
defaults below sit on the product cycle and every delay stays operator-editable.
Revisit once there are ~50 repeat intervals.

| Flow | Trigger → delay | Audience | Offer | Exit / exclusions |
|---|---|---|---|---|
| Confirmation (transactional) | signup → 0 | signer-up | none | — |
| **welcome_intro** (new) | consent → 1 d | consented, no paid order | none | paid order; quiet period |
| welcome_no_purchase | consent → 3 d | same | operator's one-time 15 % (unchanged) | paid order; quiet period |
| Recovery stage 1 | last cart activity → 1 h | signed-in or guest-with-email abandoners | none | paid order, cart cleared, unsubscribed, sequence in last 7 d |
| Recovery stage 2 | → 24 h | same | none (answers objections: COA, shipping, support) | same |
| Recovery stage 3 | → 72 h | same | configured discount **only if** no recovery code in 30 d and no paid order in 30 d | same; window closes at 96 h |
| Order confirmation / shipped / delivered (transactional) | events | buyer | none | — |
| post_purchase | paid → 5 d | consented buyers | none (COA, storage, support) | quiet period |
| **replenishment** (new) | paid → 30 d | consented buyers | none | a later paid order; quiet period |
| winback_30 ("Win-back 1") | last paid → 45 d | consented buyers | operator's choice; recommended free shipping only | new order restarts episode; quiet period |
| winback_60 ("Win-back 2") | last paid → 75 d | same | free GHK-Cu (unchanged) | same |
| Campaigns | operator | segment | operator | consent, suppression |

A stage that was missed (cart first seen at hour 30) is skipped, not caught up:
each recovery stage has a window and only the stage whose window contains
"now" is eligible. At most one recovery email per cart per sweep follows
directly.

## 4. Frequency and priority

Priority, highest first: transactional → cart recovery → post-purchase →
replenishment → welcome → win-back → campaigns.

Rules, implemented in `src/lib/email/frequency.ts`:
- Transactional mail is never gated by anything here.
- Cart recovery is never deferred by other marketing (highest commercial
  intent), but a new sequence does not start for an address that started one
  in the last 7 days.
- Lifecycle automations skip a recipient for this sweep when any marketing
  message (recovery, automation, campaign) reached them in the last 24 h.
  Skipped, not consumed: eligibility is recomputed next sweep.
- Automations run in priority order inside a sweep, and the send log is written
  before each send, so a lower-priority automation sees the higher one's send.
- Campaigns are a deliberate operator action and are not deferred; automations
  yield to them for 24 h afterwards.

## 5. Consent

- Signup gains a marketing checkbox ("Email me product news, restocks and
  offers"), pre-checked to match the checkout box for US shoppers, with the same
  "optional, unsubscribe anytime" wording. Ticking it writes
  `customer_preferences.marketing_emails = true` and a `marketing_subscribers`
  row (source `signup`), so welcome flows have a subscribed-at time for guests
  and accounts alike.
- Cart recovery for signed-in shoppers keeps its existing basis (existing
  customer relationship, opt-out honoured). Guest capture is added only from
  the checkout email field, rate-limited per IP and per address, and one
  sequence per address per 7 days bounds any abuse.
- Unsubscribe records which message prompted it (`email_suppressions.source`),
  so unsubscribes can be reported per campaign and per flow.

## 6. Attribution rules (explicit)

- Campaign click → `vl_campaign` cookie (7 days) → order stamped at creation
  with `attributed_campaign_id`. Automation click → `vl_automation` cookie →
  `attributed_automation_key`. Both are written once and never recomputed; an
  order can carry both (different channels), but a campaign never displaces
  another campaign (last click wins at cookie-set time, which is the click).
- Cart recovery revenue = net revenue of the order that closed a recovered
  cart (`abandoned_carts.recovered_order_id`). This is a P&L figure, not a
  click attribution, and is labelled as such in the admin.
- Revenue is net of refunds, sale orders only, revenue statuses only.
- No email is credited for an order placed more than 7 days after the click.

## 7. Analytics

Per campaign and per automation: sent, delivered, bounced, complained,
opened, clicked (unique), unsubscribed, orders, revenue. Delivered/bounced/
complained come from `email_delivery_events` joined by `provider_message_id`,
which is now recorded for every marketing send. Cart recovery reports the same
per stage.

## 8. Testing / experimentation

Not built. With 7 subscribers and 6 buyers no split reaches significance, and a
variant column would be complexity nobody reads. The measurement needed to run a
test later (per-send cohort, per-flow orders and revenue) is in place; the
recommended first test when the list passes ~2,000 is subject line on the
welcome offer.

## 9. Owner decisions and external items

- Automation copy lives in `email_automations` in production. This branch ships
  the recommended copy and the two new rows as
  `src/lib/sql/email-lifecycle-2026-09-04.sql`, applied by the owner (the
  repo's migration convention). Nothing in production is modified by this work.
- NEEDS EXTERNAL: rotate `EMAIL_WEBHOOK_SECRET` (Vercel) and the Resend webhook
  URL; DMARC `rua` then `p=quarantine`; import the two Resend bounce
  suppressions; Gmail/Outlook/Yahoo seed test; Google Postmaster Tools.
