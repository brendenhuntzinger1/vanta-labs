# Email lifecycle audit and upgrade — verification report

Date: 2026-09-04. Branch: `claude/vanta-email-marketing-audit-8vtad1`.
Design and benchmarks: `docs/superpowers/specs/2026-09-04-email-lifecycle-engine-design.md`.
Deliverability state and the DNS/provider items only the owner can change:
`docs/EMAIL-DELIVERABILITY-RUNBOOK.md`.

Everything below was either read from source, read from the production
database and Resend (read-only), or exercised in the local harness by
`scripts/qa-lifecycle-email.mjs`. Nothing was sent to a real customer and
nothing in production was modified.

## BEFORE

What existed was a real, carefully built sending stack: a queued campaign
sender with claim-based batching, send-once indexes for receipts and
automations, one-click unsubscribe headers, a CAN-SPAM footer applied at the
wrapper, a bounce/complaint webhook, click and open tracking with signed links,
and order attribution stamped once at order creation. That part was sound and
is untouched.

What was weak or missing, in priority order:

| Priority | Finding | Evidence |
|---|---|---|
| P0 | Cart recovery fired every stage whose delay had passed, in one sweep | cart `c1bb28a8`: t24h and t12h sent in the same minute; cart `e7a0adde`: a t12h 39 days after its t72h |
| P0 | An emptied cart stayed `active` and kept mailing | `trackCart` refused empty snapshots |
| P0 | No cross-flow frequency control | a shopper could get a cart code, a welcome offer and a win-back offer the same day |
| P0 | Recovery discount unconditional | one shopper: 4 carts, 4 codes in 9 days, then 5 full-price orders |
| P1 | Welcome flow dead | 0 of 5 accounts had `marketing_emails = true`; signup had no opt-in box |
| P1 | Guest checkouts never tracked | the majority of carts could not be recovered |
| P1 | Post-purchase was one generic email at day 14; no replenishment | |
| P1 | Win-back 1 at 30 days offered 15 % + free shipping inside the reorder window | |
| P1 | Abandonment clock ran from first sight, not last activity | a shopper still editing at minute 40 was "abandoned" at minute 60 |
| P2 | Webhook URL carries a guessable secret | `?secret=ohiostatebuckeyes88` in Resend |
| P2 | DMARC `p=none`, no `rua` | nobody receives reports |
| P2 | Provider message id kept only for automation sends | campaign and recovery delivered/bounce rates unjoinable |
| P2 | Two real bounced addresses live only in Resend's suppression list | bounced 23/27 Aug, before the webhook existed |
| P5 | Copy: "You left something behind", "YOU'RE MISSING OUT", "SHOP NOW" | |
| — | Guest with a recovery code saw "not valid" in the cart preview | `/api/coupons/validate` compared the assignment against no email |

Data that shaped the timing: 10 paid product orders, 6 buyers, 1 repeat
buyer, 4 reorder intervals. That is not enough to derive reorder windows, so
delays sit on the product cycle (a vial lasts roughly 4–8 weeks of research
use) and every delay is operator-editable.

## CHANGES

Code (all on this branch, all unit-tested, 7,099 tests green):

- `src/lib/cart-recovery.ts` — stage windows (`selectDueStage`), last-activity
  clock, `clearAbandonedCart`, late-recovery mark from a paid order, one
  sequence per address per 7 days, discount on the final stage only with a
  30-day per-address cooldown and no discount for a buyer in the last 30 days,
  the cart's own live code re-offered regardless. 12-hour stage off by default.
- `src/app/api/cart/track/route.ts`, `src/components/cart-context.tsx` — guests
  tracked from the checkout email field, rate-limited per IP and per address;
  an empty cart retires the row.
- `src/lib/email/automations.ts`, `automation-catalog.ts`, `frequency.ts` —
  `welcome_intro` and `replenishment` flows; welcome timed from a guest's
  opt-in as well as account creation; post-purchase is the first order only;
  replenishment stops once the customer reorders; event-keyed flows never
  backfill past delay + 14 days; 24-hour quiet period across every marketing
  send; automations run in priority order.
- `src/components/account-auth-form.tsx`, `src/app/api/auth/signup/route.ts` —
  signup marketing opt-in, written to `customer_preferences` and
  `marketing_subscribers`.
- `src/lib/email/templates.ts` — the three recovery messages rewritten.
- `src/lib/email/marketing.ts`, `src/app/api/unsubscribe/route.ts` — provider
  message id on every marketing send; unsubscribe records the prompting message.
- `src/lib/admin-email.ts`, `admin-email-client.tsx`,
  `api/admin/email/campaigns/preview`, `api/admin/email/campaigns/[id]` GET —
  delivered / bounced / complained / unsubscribed per campaign, composer
  preview at desktop and phone width, Duplicate copies the whole campaign,
  automation labels and the frequency rule explained on the page.
- `src/lib/email/audience.ts` — segments `first_time`, `repeat`, `high_value`
  ($300 net).
- `src/lib/admin-cart-recovery.ts`, `admin-cart-recovery-client.tsx` —
  per-stage funnel; admin resend no longer mints on the 24-hour stage.
- `src/app/api/coupons/validate/route.ts` — a guest's typed address is used to
  preview an assigned-email code.
- `scripts/qa-lifecycle-email.mjs` — the end-to-end proof; `scripts/smtp-sink.mjs`
  decodes captured mail as UTF-8; harness setup applies the new migration.

Database, for the owner to apply (`src/lib/sql/email-lifecycle-2026-09-04.sql`,
idempotent): two new automation rows seeded disabled, recommended copy for the
four existing rows (delays, offers and enabled flags untouched),
`email_suppressions.source`, an index for the cart sweep. Until it is applied
the code degrades: unsubscribes still land (without a source), the two new
flows simply do not appear.

## FLOW MAP

Delays are the shipped defaults; each is editable in Admin → Email.

| Flow | Trigger → delay | Audience | Offer | Exclusions / exit |
|---|---|---|---|---|
| Account confirmation | signup → 0 | signer-up | — | transactional |
| Welcome · introduction | consent → 1 d | consented, no paid order | none | paid order; quiet period; consent older than 15 d never triggers |
| Welcome · first-order offer | consent → 3 d | same | operator's one-time gift (15 % today) | same |
| Recovery 1 h | last cart change → 1 h (window closes 12 h) | signed-in or guest with typed email | none | paid order (webhook or sweep), cart emptied, unsubscribed, another sequence < 7 d |
| Recovery 24 h | → 24 h (closes 72 h) | same | none: testing, shipping, support | same |
| Recovery 72 h | → 72 h (closes 96 h) | same | configured % (5) if no recovery code in 30 d and no order in 30 d | same; last message about the cart |
| Order confirmed / shipped / delivered | events → 0 | buyer | — | transactional |
| First-order follow-up | first paid order → 5 d recommended (14 today) | consented buyers | none | quiet period; order older than delay + 14 d |
| Reorder reminder | paid order → 30 d | consented buyers | none | a later paid order; quiet period; grace as above |
| Win-back 1 | last paid → 45 d recommended (30 today) | consented buyers | owner's choice (15 % + shipping today; free shipping only recommended) | new order restarts the episode; quiet period |
| Win-back 2 | last paid → 75 d recommended (60 today) | same | free GHK-Cu | same |
| Campaign | operator | segment ∩ consented − suppressed | operator | consent, suppression; automations yield 24 h |

Priority inside a sweep: transactional → cart recovery → first-order follow-up
→ reorder reminder → welcome → win-back → campaigns.

## EMAIL COPY

Automated marketing mail, final subject / preview / primary CTA. Automation
preview text is the headline (there is no separate field; see next steps).

| Email | Subject | Preview | CTA |
|---|---|---|---|
| Recovery 1 h | We kept your cart | Everything you selected is still here, at the price you saw. | Return to my cart |
| Recovery 12 h (off) | Your cart is still saved | A quick note: your selection is held and ready whenever you are. | Return to my cart |
| Recovery 24 h | Before you order: testing, shipping, support | The three things most people want to know before their first order. | Finish checking out |
| Recovery 72 h (code) | One last note on your cart, with 5% off | Code SAVE-… takes 5% off if you finish this order. | Finish my order |
| Recovery 72 h (no code) | One last note on your cart | Your selection is still saved if you want it. | Finish my order |
| Welcome · introduction | What Vanta Labs is, in one email | Welcome to Vanta Labs | Browse the catalog |
| Welcome · offer | A gift toward your first Vanta Labs order | Whenever you are ready | See the catalog |
| First-order follow-up | Your order, and how to get the most from it | Thanks for your first order | View my order |
| Reorder reminder | Time to restock? | Running low? | Reorder from my account |
| Win-back 1 | Back in stock, and a note from us | It has been a while | See what is new |
| Win-back 2 | A free GHK-Cu with your next order | On us, when you are ready | Claim the gift |

Compliance: every message states research use only in the footer, none gives
handling beyond "keep vials sealed, dry and away from light", and none makes a
health, dosing or outcome claim. Every subject passes the trigger-phrase and
shouting checks in `deliverability-check.ts` (enforced by
`template-standards.test.ts`).

## TESTING

`scripts/qa-lifecycle-email.mjs` against the local harness (real Postgres with
the production schema, real SMTP capture, Chromium): 30 checks, all passing on
the final run.

- Signup form shows the opt-in ticked; signup writes both consent stores;
  confirmation sent without marketing headers.
- Welcome introduction after 1 day, once; second sweep sends nothing.
- Welcome offer held by the 24-hour quiet period, then sent; tracked CTA
  redirects on-site, sets the gift and attribution cookies, mints the offer,
  records the click.
- A subscriber who buys gets no welcome mail.
- Guest types an email at checkout → cart tracked (browser-driven).
- Nothing inside the hour; 1-hour reminder once; restore link → `/cart/restore`
  → items returned; click stamped.
- Cart first seen 25 h ago gets the details message, not stage one; no repeat.
- 72 h: last note with a live `SAVE-` code bound to the shopper; sequence ends.
- Paid order → sweep marks the cart recovered, no mail (webhook mark missed on purpose).
- Second cart inside 7 days → held; emptied cart → `cleared`, never mailed;
  sink address refused; per-address rate limit trips.
- First-order follow-up, reorder reminder (and its stop when they reorder),
  win-back 1 once per lapse.
- Footer unsubscribe → suppressed with `source = cart_recovery_t72h`; a new
  cart produces nothing. One-click POST → suppressed with
  `source = automation:welcome_intro`, account preference mirrored off.
- Resend-shaped permanent bounce → suppressed as bounced, event logged, no
  send; wrong webhook secret → 401.
- Campaign: create, preview, test (delivered, not logged as a send), audience
  estimate, send now, second send → 409, every recipient once, no suppressed
  address reached, every email carries a tracked CTA, click sets `vl_campaign`
  and stamps the recipient; scheduled campaign stopped → nothing sent.
- Admin → Email and Admin → Cart recovery render with the new labels, columns
  and funnel, at desktop and 390 px.
- Every marketing email rendered at 390×844 and 1280×900 with no horizontal
  overflow; screenshots under `/tmp/vanta-qa/lifecycle-shots/` in the session.

Also run: the full unit suite (444 files), `tsc --noEmit`, `eslint` (0 errors),
and `npm run qa:purchase`, which confirms a guest checkout still creates an
order and exactly one order confirmation is captured per paid order (its two
"failures" read the no-op provider's log line, which this harness does not
write because real SMTP capture is on; the receipts are in the capture file).

Not tested here, by nature of the environment: Gmail, Apple Mail and Outlook
rendering; real Resend delivery; DNS.

## DELIVERABILITY

Verified from the repository and provider (read-only):

- Resend: both domains verified (`vantalabsresearch.com`, `mail.vantalabsresearch.com`);
  marketing goes out from the subdomain with Reply-To on the root; webhook
  subscribed to delivered, bounced, complained, delayed, failed.
- Last 30 days: 141 sent, 96.5 % delivered, 3 permanent bounces, 1 complaint
  (Resend's own simulator address).
- Code: List-Unsubscribe + List-Unsubscribe-Post on every marketing send and
  on nothing transactional (checked on captured messages); CAN-SPAM address in
  every marketing footer; suppression enforced per send and subtracted from
  every audience; three consecutive soft bounces suppress; sink domains
  refused everywhere including the new guest path.
- SPF, DKIM and DMARC alignment: as recorded in the runbook on 2026-09-02.

NEEDS EXTERNAL VERIFICATION / ACTION:

1. Rotate `EMAIL_WEBHOOK_SECRET` in Vercel and the Resend webhook URL. The
   current value is guessable and sits in a URL.
2. DMARC: add `rua` (a free reporting service), wait two weeks, then
   `p=quarantine`.
3. Import Resend's two bounce suppressions (`schlossash@yahoo.com`,
   `zainmeringmx@gmail.com`) into `email_suppressions` as `bounced`.
4. Seed-test Gmail, Outlook and Yahoo after applying the migration; confirm
   SPF/DKIM/DMARC PASS on a real message; enrol in Google Postmaster Tools.
5. Confirm `orders@vantalabsresearch.com` is read by a person (opt-out mailto).

## ANALYTICS

Per campaign: sent, delivered, bounced, complained, unsubscribed, opened,
clicked (unique), orders, revenue (net of refunds). Per automation: sends,
delivered, opened, clicks, unique clicks, orders, revenue. Cart recovery:
recovery rate, revenue kept, open/click rate, coupon redemption, and now a
per-stage funnel.

Attribution rules, explicit: a campaign click sets a 7-day cookie; the order
is stamped once at creation with that campaign; automations use a separate
cookie and column, so an order can carry one of each but never two campaigns;
cart recovery revenue is the net revenue of the order that closed the cart, a
P&L figure labelled as such, not a click attribution. Delivered/bounce counts
only exist for sends that recorded a provider message id — every marketing
send from this deploy onward on Resend; nothing on SMTP.

## REMAINING RISKS

- The migration and the recommended flow settings are applied in production
  (see next steps, item 1). The two new flows go live the moment this branch
  deploys; until then the current deploy ignores their rows.
- The four existing automations are live with the owner's delays and offers.
  This branch changes their exclusion logic (quiet period, grace, first-order
  rule) the moment it deploys, which is intended; the recommended delay
  changes (45/75 days for win-backs, 5 days for the follow-up) are not made
  automatically.
- Guest tracking accepts a typed address. Rate limits and the 7-day sequence
  cap bound abuse to three branded emails a week to a stranger, and the
  stranger's unsubscribe ends it. This is the same trade every Shopify store
  makes; it is stated here so it is a decision.
- Open counts are directional only (Apple Mail privacy pre-fetch).
- Volume is tiny, so every rate on the dashboard will swing on one person for
  months. Judge flows by orders and revenue, not rates, until the list grows.

## RECOMMENDED NEXT STEPS

1. DONE 2026-09-04, on the owner's instruction: `email-lifecycle-2026-09-04.sql`
   applied to production (migration `email_lifecycle_2026_09_04`); welcome
   introduction and reorder reminder enabled; win-back 1 at 45 days with free
   shipping only; win-back 2 at 75 days. The first-order follow-up stays at
   its existing 14-day delay (5 recommended) — change it in Admin → Email.
2. Rotate the webhook secret and finish the DMARC items (deliverability is
   the ceiling on everything else).
3. Seed-test across Gmail / Outlook / Yahoo with the new templates.
4. Add a separate preview-text field to automations (headline doubles as the
   preheader today).
5. Browse abandonment for signed-in shoppers, once product views are recorded.
6. Subject-line A/B on the welcome offer once the consented list passes ~2,000.
