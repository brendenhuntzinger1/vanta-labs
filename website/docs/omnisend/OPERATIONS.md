# Omnisend operations: deliverability, attribution, metrics, launch and rollback

Companion to `AUDIT.md` (what sends today and who owns each message),
`MIGRATION.md` (contacts) and `CHECKLIST.md` (state of the work). This file is
the operator's manual once Omnisend owns marketing. Everything here was
verified against live DNS, the Resend account, the Omnisend account and the
codebase on 2026-09-16 unless marked *owner to confirm*.

## 1. Deliverability

### What exists today (do not change without reading this)

| Record | Value | Used by |
|---|---|---|
| `vantalabsresearch.com` TXT | `v=spf1 include:_spf.google.com ~all` | Google Workspace mail from the root domain |
| `_dmarc.vantalabsresearch.com` | `v=DMARC1; p=none;` | Monitoring only, no enforcement |
| `vantalabsresearch.com` MX | Google | Inbound mail |
| `send.vantalabsresearch.com` TXT | `v=spf1 include:amazonses.com ~all` | Resend's return-path subdomain |
| `send.vantalabsresearch.com` MX | SES feedback | Resend bounce handling |
| `resend._domainkey` | DKIM public key | Resend signing |
| `google._domainkey` | DKIM public key | Google Workspace signing |

Resend reports both `vantalabsresearch.com` and `mail.vantalabsresearch.com` as
verified. Transactional mail keeps flowing through them untouched. None of the
records above are removed or edited by this work.

### What Omnisend needs (owner action, no API for it)

Omnisend signs with its own DKIM selector on a sender domain you register in
**Store settings → Sender domains**. On 2026-09-16 no Omnisend DKIM record was
present on any common selector, so Omnisend mail would go out under a shared
Omnisend domain with the brand address only as the visible From. Before the
first send:

1. Register the sending address in Omnisend (recommendation: a dedicated
   subdomain such as `news.vantalabsresearch.com`, so a marketing reputation
   problem can never touch transactional delivery on `send.` or the root; this
   is the same separation the in-house engine documents in
   `src/lib/email/reputation-separation.test.ts`).
2. Add the CNAME/TXT records Omnisend displays. Do not remove any row in the
   table above. Add a subdomain SPF record only if Omnisend asks for one; the
   root SPF stays Google-only.
3. Wait for Omnisend to show the domain as authenticated, then send a seed
   test to an owner mailbox and check the `Authentication-Results` header shows
   `dkim=pass` for the Omnisend selector and `dmarc=pass` (alignment on the
   organisational domain).
4. Move DMARC from `p=none` to `p=quarantine; pct=10` only after two weeks of
   clean reports from both Resend and Omnisend, and add an `rua=` mailbox
   first so you can see what would be quarantined. This is optional and
   outside the migration, but `p=none` gives no protection today.

Reply handling: set the reply-to in Omnisend to the monitored support address
(the monitored support mailbox configured as `SUPPORT_EMAIL` in
`scripts/omnisend/lib.mjs`, the same one the in-house engine uses). The
footer layout already carries it as text.

Placement is not promised. Gmail Primary tab placement and spam avoidance
depend on recipient behaviour; the controls above are the ones that are ours.

### Unsubscribe and list-hygiene

* Every Omnisend email carries `[[unsubscribe_link]]` in the footer layout.
  Whether Omnisend adds `List-Unsubscribe` / `List-Unsubscribe-Post` headers
  is *owner to confirm* on the first seed test (open the message headers);
  Gmail and Yahoo require them for bulk senders.
* An Omnisend unsubscribe reaches the store on the next nightly reconcile as an
  `email_suppressions` row with `source: omnisend`; an SMS STOP becomes the
  account's `sms_opted_out_at`. The store never re-subscribes anyone on the
  strength of an Omnisend status (`reconcile-plan.ts`).
* A store unsubscribe reaches Omnisend on the next contact push as
  `status: unsubscribed` with the store's own timestamp.
* Bounces and complaints inside Omnisend are handled by Omnisend and kept
  there; the store's suppression list is the union of what Resend reported
  through the webhook and what customers did. The two Resend bounces recorded
  before the webhook existed are not in the store list, but neither address is
  in the consented audience, so neither is pushed as subscribed.

## 2. Attribution and UTM scheme

Every link in every Omnisend email or SMS goes through
`/api/email/omnisend-link` (`src/app/api/email/omnisend-link/route.ts`), which
verifies the per-contact token, passes the account wall, and redirects to the
destination with:

| Parameter | Value |
|---|---|
| `utm_source` | `omnisend` |
| `utm_medium` | `email` or `sms` |
| `utm_campaign` | the flow or campaign key as the generator and hooks emit it: `welcome`, `abandoned-cart`, `abandoned-checkout`, `browse-abandonment`, `post-purchase`, `replenishment`, `win-back`, `sunset`, `campaign-new-product`, `campaign-promotion`, `campaign-final-day`, `header`, `footer` (layout links), `order` (links inside order events) |
| `utm_content` | the slot in the message: `primary`, `secondary`, `code` |

The storefront's attribution client (`src/lib/attribution-client.ts`) stores
the first and last touch in the browser, and checkout writes them to
`order_attribution` (`src/lib/order-attribution.ts`) because a `utm_source` is
campaign evidence there (`hasCampaignEvidence`). So an Omnisend-driven order is
visible in the store's own records as `last_utm_source = omnisend` with the
flow in `last_utm_campaign`, and in the admin attribution views alongside ads.

The click route sets no cookie of its own (only the browse grant when the
recipient is attested). A campaign cookie set on a click regardless of the
cookie banner would contradict the Cookie Policy, and nothing read one; the
landing URL's parameters are the attribution record.

### Windows, and why two systems will disagree

* **Store**: 30-day window (`ATTRIBUTION_WINDOW_DAYS`), first and last touch
  recorded separately, one row per order, no row when there is no evidence.
* **Omnisend**: its own attribution on `attributedOrders` / `attributedRevenue`
  from the `paid for order` events the store sends, using Omnisend's default
  window and its own click/open logic. It will claim orders the store credits
  to an ad (the shopper clicked a TikTok ad on Monday and an Omnisend email on
  Thursday) and orders the store leaves unattributed.
* **Ad platforms** each claim independently again.

Treat Omnisend's revenue numbers as *engagement-weighted*, the store's
`order_attribution` as the arbiter for "which last touch preceded the order",
and neither as proof of incremental lift. The only way to measure lift is a
holdout, and the small list (about a hundred consented addresses) is not
large enough for one yet; revisit when the consented audience passes roughly
two thousand.

## 3. Metrics and where each one comes from

Omnisend's Reports API (`post_analytics_reports`, read via the Omnisend MCP or
`omnisendRequest`) exposes, per campaign or automation and per channel:
`sent`, delivery and failure counts and rates, `openRate`, `clickRate`,
`unsubscribeRate`, `markedAsSpamRate`, `attributedOrders`, `attributedRevenue`,
`attributedOrderRate`, and `sentCost` (SMS only). The Statistics API adds
audience growth (`subscribedSms`, `unsubscribedSms` and the email equivalents).

| Metric | Source | Caveat |
|---|---|---|
| Delivered / bounced / failed | Omnisend reports (per channel) | Email only for bounce classes; SMS has carrier failure counts |
| Complaints, opt-outs | Omnisend reports + store `email_suppressions` (`source: omnisend`) | Store count lags by one reconcile |
| Email opens | Omnisend `openRate` | Apple Mail Privacy Protection inflates opens; use for trend, never for decisions |
| SMS opens | not measurable | SMS has no open signal; do not report one |
| Clicks | Omnisend `clickRate` + store session visits with `utm_source=omnisend` | |
| Orders and revenue | store `order_attribution` (arbiter) and Omnisend `attributedOrders` | see section 2 |
| Cart recovery by cohort | store: `abandoned_carts` joined to `orders` and `order_attribution` where `last_utm_campaign in ('abandoned-cart','abandoned-checkout')` | Omnisend-owned carts only, from the cutover timestamp in `omnisend_sync_state.migration` |
| Revenue per recipient | Omnisend `attributedRevenue / sent` per flow | |
| Discount and gift cost | store: `coupons` where `assigned_email` and source `omnisend_*`, `customer_offers` with the recovery key, joined to orders | contribution = subtotal minus cost of goods, gifts at cost, discount, shipping and processing |
| SMS segments and cost | Omnisend `sentCost` (SMS) | multipart messages count more than once; keep texts under 160 characters |
| Integration lag | store: `omnisend_events_sent.first_sent_at` minus the source row's timestamp | |
| Failed events, retries | store: `omnisend_events_sent` with `delivered = false`, `attempts`, `last_error` | the backstop sweep retries paid orders; carts are not retried |
| Duplicate prevention | store: primary key on `(entity_id, event_name)` in `omnisend_events_sent` | one row per event per entity by construction |

### Baseline (in-house engine, 30 days to 2026-09-16)

Recovery stages sent: 40 first reminders, 33 second (the 12-hour stage was on
for part of the window), 30 details messages, 20 final messages with the
offer; 18 carts recovered against 23 expired since the programme began; 14
paid product orders in the window. Consented email audience about 106
addresses; SMS audience zero. These are the numbers the first Omnisend month
is compared against, cohort for cohort, not the number a vendor dashboard
shows.

### Experiments worth running first (hypotheses, not settings)

1. Final recovery message at 72 hours versus 48 hours (one variable: delay).
2. Welcome code at 10 percent versus no code with the COA library as the hook
   (this brand's documentation posture may convert as well without margin).
3. SMS after the second recovery email versus no SMS, once SMS is approved
   and the SMS audience exceeds a hundred consents.

Declare nothing from fewer than roughly 200 recipients per arm, and read
conversion on its own denominator (orders, not clicks).

### 3.1 Flow timings and rationale (hypotheses, not settings)

Every flow is defined in `scripts/omnisend/automations.mjs` and created
disabled. Every send block carries `sendingThresholds` email `subscribed` and
SMS `subscribed`, so consent is re-checked per channel at each step and an SMS
step is simply skipped for a contact without SMS consent. Delays are wall
clock from the trigger; Omnisend's automation API exposes no recipient-time-zone
option on a delay (only weekday and fixed-time modes), so none is set, and SMS
quiet hours are the account setting the owner turns on before SMS is enabled.
Conversion for every flow is the store's `paid for order` event, attributed by
Omnisend on its side and by `order_attribution` on ours (§2).

| Flow | Trigger and entry | Steps | Exit | Re-entry cap | Offer | Why these numbers |
|---|---|---|---|---|---|---|
| Welcome | `subscribed to marketing` | E1 at once (no code: it may not exist yet) → SMS (SMS-consented only, no code) → 2 d → split on `vl-welcome-ready`: E2 with the code, else E2 plain → 3 d → split again: E3 with the code, else E3 without | none | once per contact | welcome code 10 percent on a first order, 14 days, minted by the store at a site sign-up; never for a checkout opt-in (those contacts get the plain variants); a form sign-up gets it by the next nightly reconcile, so the form promises the offer by email within two days | E1 while the sign-up is fresh; E2 at day 2 is the documentation story (COA library) and the first place the code can appear; E3 at day 5 closes inside the 14-day code. Mirrors the in-house welcome pair with one extra touch |
| Abandoned cart | `added product to cart` then 1 h inactivity | E1 → 23 h → E2 → 3 h → SMS → 45 h → final (four variants by gift/code readiness) | `placed order`, `started checkout` | 7 days | band code and gift minted by the store 36 to 96 h after last activity, so they exist before the final step | Same shape as the in-house ladder (1 h, 24 h, 72 h) which recovered 18 carts; the SMS at 27 h adds a channel after the second email rather than repeating it; the incentive only at the end, once per address per 30 days, on the in-house cooldown rules |
| Abandoned checkout | `started checkout` then 1 h inactivity | as above with the checkout templates | `placed order` | 7 days | as above | Checkout starters are the warmest audience; the cart flow exits when checkout starts so nobody is in both |
| Browse abandonment | `viewed product` (signed-in only) then 4 h inactivity | one email | `added product to cart`, `started checkout`, `placed order` | 7 days | none | The in-house rule (4 to 24 h, one note, no offer, once a week) kept as is; it was switched off in-house and starts off here too |
| Post-purchase | `paid for order` | 1 d → E1 (thanks, COA, support) → 9 d → E2 (reorder, support) → 3 d → split on `vl-repeat-customers` (2+ paid orders): repeat thank-you → 7 d → split on `vl-vip` (spent over 500): milestone | none | 30 days | none | Day 1 lands with the shipping window; day 10 is after delivery for most orders; the repeat thank-you at day 13 goes only to a second-time buyer; the VIP milestone a week later so two thank-yous never land together; neither is a discount |
| Replenishment | `paid for order` | 45 d → skip if bought in the last 30 d, else one email | none | 60 days | none | 45 days is the in-house replenishment delay; the segment check stops a customer inside a reorder cycle being nudged |
| Win-back | entered segment `vl-lapsed-60` (a customer whose last order is not in the last 60 days) | E1 (no code) → 1 d → SMS → 30 d → split on `vl-winback-ready`: E2 with the win-back code, else a plain note | `paid for order` | 32 days (one run plus a day) | win-back code 15 percent, 14 days, minted by the nightly reconcile for a subscribed buyer 50+ days from the last order and re-minted while still lapsed | Two in-house win-backs (30 and 60 days) collapse to one flow that starts at 60 and offers money only at about day 91: the 30-day one paid people inside their own cycle. Entering on the segment rather than on the order matters: a `paid for order` trigger with a 60-day wait and a 180-day limiter locked a repeat buyer out for 180 days from the first order, however lapsed they later became; the segment already encodes the 60 days, so the limiter only has to outlast one run and a buyer who lapses again is won back again |
| Sunset | entered segment `vl-unengaged-120` | one email → 7 d → clicked: tag `engaged` (drop `sunset`); not clicked: tag `sunset` | none | 180 days | none | List hygiene for deliverability; the tag lets campaigns exclude the sunset group without deleting anyone |

Cross-flow frequency: Omnisend limits re-entry per flow, not sends per day
across flows. A contact can receive a welcome email and a cart email on the
same day. The in-house engine's one-marketing-email-per-day rule does not
carry over (AUDIT.md F-09); if Omnisend's account settings offer a global
cap on the chosen plan, set it to one marketing email per day.

## 4. Launch order (controlled transition)

Nothing below happens until the owner authorises it explicitly, step by step.

0. **Prerequisites** (owner): `OMNISEND_API_KEY` set in Vercel production;
   `src/lib/sql/omnisend-sync.sql` applied to the production database;
   sender domain authenticated (section 1); postal address added to the
   footer layout; SMS sender verified in Omnisend if SMS is to be used; plan
   tier chosen (Pro includes SMS credits).
1. **Snapshot**: admin → Omnisend sync → `snapshot` with label
   `pre-migration-YYYY-MM-DD`. Records what the store says about every
   address before anything is pushed.
2. **Catalogue**: `catalog` sync. Verify a product in Omnisend shows the right
   price, image and URL.
3. **Contacts dry run**: `contacts` with `dryRun: true`. Read the report:
   the store totals must match the audit counts, `unresolved` must be empty.
4. **Contacts live**: `contacts`. Then read the report again the next day
   (batch polling folds Omnisend-side errors into `unresolved`). Verify in
   Omnisend that a known account holder shows `subscribed` with the store's
   original timestamp, and that a suppressed address shows `unsubscribed`.
5. **Verify flows on seed contacts** (owner's own addresses, tagged in
   Omnisend so they can be excluded): enable one flow at a time, trigger it
   from the harness or a real test on the owner's own account, confirm the
   email renders and every link passes the account wall.
6. **Cutover**: set `OMNISEND_MARKETING_OWNER=true` in Vercel. From the next
   lifecycle tick the in-house automations and campaigns stand down, cart
   recovery runs in legacy-only mode (finishing the carts it already started),
   and new carts, checkouts, views and orders flow to Omnisend.
7. **Enable flows in this order**, each after 48 hours of clean results on the
   previous: abandoned checkout → abandoned cart → welcome and welcome offer
   together (the offer flow enters on the readiness segment the welcome
   flow's splits use, so the two are one programme) → post-purchase →
   browse abandonment → replenishment → win-back → sunset. SMS steps stay off
   until SMS is approved and the quiet-hours setting is confirmed in Omnisend.
   Before the welcome pair: confirm in the dashboard that no legacy contact
   sits in `VL · Welcome code ready` (the store only sets the flag for a
   never-bought address at the moment it subscribes, and entering the segment
   is the trigger, so the import must precede enabling).
8. **Cohort and spend limits**: the audience is about 106 consented addresses,
   so "limited cohort" means enabling flows (event-driven, a handful of
   contacts a day) before any campaign. First campaign: the `vl-engaged-90`
   segment only, then `vl-campaign-audience`. SMS: cap the monthly credit in
   Omnisend's SMS settings to the plan allowance; do not buy top-ups until a
   flow has a measured return.
9. **Expand** only when: bounce rate under 2 percent, complaint rate under
   0.1 percent, no `unresolved` in the reconcile report for a week, and
   recovery orders attributed in `order_attribution` for Omnisend-owned carts.

## 5. Rollback

* **Stop marketing sends from Omnisend**: disable the automations in Omnisend
  (each flow has a switch) and pause any scheduled campaign. Contacts and
  events keep flowing; nothing is lost.
* **Return marketing to the in-house engine**: unset `OMNISEND_MARKETING_OWNER`
  (or set it to `false`). The next lifecycle tick resumes cart recovery,
  automations and campaigns. Carts Omnisend was mailing will be picked up by
  the in-house ladder only if they are inside its windows and have no claimed
  stage; a cart Omnisend already mailed cannot be told apart from one it did
  not, so expect the in-house ladder to start those at stage one — disable
  the Omnisend flows first and wait 96 hours before flipping the switch back
  if that matters.
* **Stop all Omnisend traffic**: remove `OMNISEND_API_KEY`. Every hook returns
  before any read (`omnisendActive()`), the ledger stops filling, and the
  cron jobs report `skipped`.
* **Consent** was never widened by any step, so there is nothing to restore.
  To prove it: compare a fresh `snapshot` against the pre-migration label
  (`MIGRATION.md` has the statement). Suppressions written by the reconcile
  carry `source: omnisend` and stay in force after rollback, which is the
  correct direction.
* **Do not** delete the Omnisend contacts, the in-house engine, the Resend
  domains or the webhook as part of any rollback.

## 6. Operating cost

* Omnisend plan: chosen by the owner (Pro planned, which includes SMS credits;
  price by contact count is on Omnisend's pricing page and is not recorded
  here because it changes). SMS in the US is billed per segment; a 160-character
  GSM text is one segment, and every text in `scripts/omnisend/sms.mjs` is
  written to fit one.
* Store side: the cron jobs add four sweeps (orders backstop, catalogue every
  6 hours, contacts nightly, cart offers hourly), each bounded and skipped in
  seconds when there is nothing to do. No new Vercel function.
* Incentives: welcome 10 percent on a first order (14 days), recovery per the
  cart-value band (`cart-recovery-tiers.ts`), win-back 15 percent (14 days).
  Each is a per-address coupon or gift token enforced by the checkout, so the
  cost is bounded by redemptions, not sends.

## 7. Monitoring

Daily: the lifecycle and sweep cron responses (`omnisend_*` jobs) for
`skipped` reasons; `omnisend_events_sent where delivered = false` count;
the reconcile report's `unresolved`. Weekly: Omnisend reports per flow
(delivered, complaints, unsubscribes, attributed orders) against the store's
`order_attribution`; suppression growth. Alert: any `omnisend_*` job that
throws (cron-runner isolates it and reports), complaint rate above 0.1 percent
in Omnisend, or a reconcile that holds its watermark three nights running.

## 8. Launching a promotion safely

1. Create the coupon in the store admin first (percent, minimum, dates, per
   customer limit, stacking rules). The checkout enforces it; the email only
   describes it.
2. Duplicate the `VL general promotion` template in Omnisend, replace the code
   and the dates, keep the research-use footer and the one primary action.
   Never write a countdown, "limited stock" or a testimonial.
3. Send to `vl-engaged-90` first, at 10:00 in America/Chicago on a weekday;
   send to `vl-campaign-audience` the next day only if complaints are zero.
4. On the real last day, send `VL final day` once; the "ends today" line is
   true only on that day.
5. After the window closes, deactivate the coupon in the store admin. The
   email cannot apply a code the store has switched off.
6. SMS for a promotion goes only to `vl-sms-subscribers`, once, inside the
   quiet-hours window Omnisend enforces, with the STOP line.
