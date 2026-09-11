# Lifecycle email audit — 2026-09-11

Companion to `2026-09-11-recovery-to-benchmark-design.md`. Every number is
from production (read-only), real customers only, since 2026-08-01 unless
stated. The standard this is written against: customers receive the email,
see it, click, return and pay. Opens are context, never a result.

## 1. The frame

| Fact | Value |
|---|---|
| Accounts created (Jul / Aug / Sep to date) | 8 / 26 / 106 |
| Consent for marketing | 70 of 85 preference rows; 76 checkout opt-ins; roughly half of accounts reachable |
| Paid product orders, all time | 9, $1,478, 9 distinct buyers, **0 repeat buyers** |
| Orders credited to any email flow | **0** (6 organic, 1 ad, 1 ambassador, 1 campaign click) |
| Automated marketing sends since 08-01 | 178 (cart 79, welcome 98, post-purchase 1) |
| Clicks on those | **1** |
| Incentives issued / redeemed | cart gifts 103 / 0, welcome 15% 36 / 0, recovery codes 346 / 0 |
| Open carts right now | 16, $3,241 |
| Complaints / unsubscribes from real customers | 0 / 1 |

Two consequences shape everything below. First, with nine buyers and no
repeats, every post-purchase, replenishment, win-back and VIP flow is
untestable today; they can be made correct but not evaluated. Second, the
whole pre-purchase programme (welcome, cart) has produced one click in 178
sends, so the first leak is reach, not offer design.

## 2. Integrity checks (what the mandate forbids)

| Check | Result |
|---|---|
| Cart emails sent after the customer paid | **0** |
| Open carts holding a product slug the catalogue does not have | **0** |
| Duplicate sends of one stage to one cart | 2 carts; both were operator resends from the admin panel, one before the "refuse a second press" fix |
| Same address, three cart stages inside 13 hours | **3 real customers** (e.g. 00:20, 01:30, 13:30). Cause: stages are exempt from the 24-hour quiet period against each other and no minimum gap exists, so a cart first processed at 11 hours old gets stage 1, then stage 2 an hour later |
| Recovery link in production | answers, redirects to the restore page; guest grant verified on the harness 09-08 |
| Authentication | SPF, DKIM, DMARC all pass and align (Google's own header, seed 6) |
| DMARC policy | `p=none`; subdomain publishes none of its own |
| Provider open tracking | on for the marketing domain, so every marketing message carries two pixels |

## 3. Every flow, on the seven axes

| Flow | Who | When | Why | Job of the message | Suppressed when | After click | Measured today | Verdict |
|---|---|---|---|---|---|---|---|---|
| Welcome · intro | consented account, no order | day 1 after consent | orientation | COA library, how ordering works | any order; quiet 24h; unsub | `/products` via tracked link + browse grant | sends/opens/clicks; attributed orders (0) | correct; 62 sends, 0 clicks |
| Welcome · first-order offer | same, still no order | day 3 | convert | 15% first order | same | same | same; 36 offers, 0 redeemed | in Promotions; headline shouts; carries the blanket "every batch is third-party tested" claim |
| Cart, stage 1 | cart with address, 1–12h since last change | 1h | recall | cart back in front of them | paid; emptied cart; 7-day sequence cooldown; unsub | restore → `/cart` with grant | sent/opened/clicked/restored/attributed | correct; placement borderline |
| Cart, stage 2 | 12–24h | 12h | objection | COA library | same | same | same | the one message Gmail keeps in Primary |
| Cart, stage 3 | 24–72h | 24h | add value | gift | same + gift rules | same, gift token in cookie | same | Promotions; 0 of 103 gifts redeemed |
| Cart, stage 4 | 72–96h | 72h | last note | gift + code | same + code rules | same | same | Promotions; 0 of 346 codes redeemed |
| Checkout started, no payment | cart row is stamped, nothing else | — | — | none: they get the generic cart sequence | — | — | `checkout_started_at` only | **missing segment**; 2 of 2 such carts recovered on their own |
| Payment failed (card) | 16 orders, $3,995 subtotal, 7 expired at payment, 3 declined, 6 failed | — | — | **no email exists** (memberships only) | — | order status page | none | **missing flow**; 12 of 16 came back on their own, three of them 48–61 h later |
| Post-purchase | first paid order, consented | day 14 | education | COA, storage, support | quiet; unsub | `/products` | sends (1) | correct; unproven |
| Replenishment | each paid order, still latest | day 30 | reorder | reorder reminder | ordered since; quiet | `/products` | none yet | unproven; 30 days is a guess with no repeat data |
| Win-back 1 / 2 | lapsed buyers | day 40 / 50 | reactivate | light offer / gift | new order; ladder gate | `/products` | none yet | unproven |
| Browse abandonment | — | — | — | **does not exist** | — | — | — | every viewer is signed in, so this is cheap (design §6) |
| VIP | — | — | — | does not exist | — | — | — | 9 buyers, no repeats: premature |
| Back-in-stock | subscribers to a product | on restock | high intent | notify | — | product page | none | wired; volume unknown |
| Birthday | members | birthday | — | bonus points | — | — | — | membership only |

## 4. The leaks, ranked by expected revenue impact

| # | Leak | Evidence | Expected impact | Confidence | Effort |
|---|---|---|---|---|---|
| 1 | Offer-bearing messages are filed as promotions, and wording alone did not fix it | seed rounds one to three; 1 click in 178 sends | Everything downstream depends on it | cause: high; specific fix: pending the layout and opening probes | medium |
| 2 | No follow-up for a failed or expired payment | 16 orders, $3,995 subtotal; 3 recoveries took 2–3 days; 4 never returned | Highest intent per email in the system; transactional in nature, so placement is not the obstacle | high | medium |
| 3 | Three cart stages inside 13 hours | 3 real customers | Complaint and unsubscribe risk on the only channel that reaches anyone; a direct violation of the frequency rule | high | small |
| 4 | Nothing reports delivered → human → restored → checkout → paid → profit per flow | funnel today stops at click; opens unfiltered | Cannot tell a working flow from a broken one; prerequisite for judging 1, 2, 5, 6 | high | medium |
| 5 | Welcome offer: shouting headline, blanket testing claim, 36 offers unredeemed | copy in `email_automations`; seed W0 in Promotions | Second-largest audience after cart; compliance exposure on the claim | high | small (copy is an admin row) |
| 6 | Browse abandonment absent | 106 accounts in September, 9 buyers; every viewer known | One of the three flows that carry most automated revenue elsewhere | medium | medium |
| 7 | Checkout-started abandoners get the same message as a cart-only abandoner | 2 of 2 recovered alone; segment tiny so far | Right message to the hottest segment; low volume today | medium | small once 2 exists |
| 8 | DMARC `p=none`, no Postmaster telemetry, double open pixel | DNS; provider settings | Hygiene; deferred so reputation variables stay controlled during the experiment | high | small, owner-side |
| 9 | Replenishment at 30 days, win-back at 40/50: guesses | 0 repeat buyers | Nothing to tune yet | — | none now |

## 5. Layers, in order, each verified before the next

**Layer 1 — stop the harm and see clearly.**
(a) Minimum gap between cart stages, enforced in the pure stage selector and
therefore in the admin resend too. (b) Measurement per the design §3, extended
to the mandate's funnel: eligible → attempted → delivered → bounced → human
open → click → restored → checkout → paid → revenue → gross profit, per flow
and per stage, with benchmark-style figures beside strict ones. (c) The
welcome offer copy, proposed to the owner as a replacement row.

**Layer 2 — reach the highest-intent shoppers.** Payment-failure and
checkout-expired follow-up: one message, within the hour, about that order,
with the retry path; suppressed the moment the order or any later order is
paid. Then the checkout-started split of the cart sequence.

**Layer 3 — placement.** Ship the restrained shape for stages 3 and 4 in
whichever form the probes support (text-forward or COA-led opening); keep
seeding one message at a time; judge on strict conversions.

**Layer 4 — browse abandonment** per design §6.

**Layer 5 — after data exists:** replenishment timing from real reorder
gaps, VIP rule, DMARC to quarantine, Postmaster.

Every layer ends with: unit tests green, the harness suites green, and a
browser run of the customer journey after the click at desktop and 390×844.

## 6. The eight questions, answered as of today

1. Reaching customers: delivered, yes (100% accepted, 0 real complaints). Seen: the offer stages and the welcome offer are in Promotions on Gmail.
2. Engaging: no. 1 click in 178 automated sends.
3. Links and offers: the restore path is verified and no open cart holds a dead line; no incentive has ever been redeemed because none was reached.
4. Right person, right time: cart timing is sound; three stages inside 13 hours is not; failed payments get nothing.
5. Competing automations: the quiet period prevents cross-flow collisions; the one gap is inside the cart family.
6. Which emails generate orders: none, measurably.
7. Where customers drop out: between delivered and click.
8. Test next: the two probes in flight (layout vs opening), then stage 3 in the winning shape against strict conversions.

## 7. What shipped against the ranked leaks (2026-09-11)

| # | Leak | Fix | Commit |
|---|---|---|---|
| 1 | Offer stages in Promotions | Stages 3 and 4 rewritten as notes: no badge, no offer box, no code box, the offer in one sentence, the terms in one muted line, "Complete my order". Subject arms: product vs what was added (stage 3); no percentage in the stage-4 subject. | bba3597 |
| 2 | No payment-failure follow-up | Stage 1 sends a payment-aware message when the record shows a decline or an expired checkout after the cart was seen: what happened, the order number, "nothing was charged" only where true. Same slot, claim, guard and measurement. | fbfdf84 |
| 3 | Three stages inside 13 hours | 8-hour minimum gap between any two stages, in the sweep and in the admin resend (which says when it will be allowed). | d843ea0 |
| 4 | No funnel | Engagement events with user agents; human/any split; lifecycle funnel per flow and stage with strict and benchmark-style paid columns; readable-threshold flag. | 0c44b51 |
| 5 | Welcome offer copy | Production row rewritten to the plain shape ("Before your first order"); old copy kept in the diagnosis log as W0. | data change |
| 6 | Browse abandonment missing | Shipped, disabled: product views, the automation, its template, the click landing on the viewed product. | 2cf5719 |
| 7 | Checkout-started segment | Not done. The cart flow already treats a cart that reached checkout as its own; a separate segment needs the funnel's restored → checkout → paid columns to show where those carts actually drop before a message is written for them. |
| 8 | DMARC p=none, no Postmaster, double open pixel | Owner items (DNS and Google Postmaster enrolment). The double pixel is now harmless to the reading: provider opens and our own pixel are both recorded as events and classified the same way. |
| 9 | Replenishment timing | Deferred until real reorder gaps exist to read. |

### How to read it from here

Admin → Email → "Lifecycle funnel (28 days)". Each row is a flow and stage.
Until a row shows 150 delivered it is flagged and its rates are directional.
The columns to decide on are, in order: delivered, human clicks, restored,
paid (strict), recovered revenue, gross profit. Opens are shown but are not
a decision input.

The first decision the funnel should settle: whether the restrained stages 3
and 4 produce human clicks and paid orders at all. If after 150 delivered per
stage they do not, the next variable is the layout (P1's text-on-white shape),
and the P1/P2 tab readings from the owner's inbox say which probe to promote.

### The eight questions, revisited

1. Reach: delivered yes; placement of the offer stages in Gmail was the leak; the shape that placed the messages there is gone.
2. Engagement: unknown until the new shape has ~150 delivered per stage; the funnel now measures human clicks, not opens.
3. Links, offers, restore: verified in the harness end to end after this change set (see the verification notes in this session's commits).
4. Right person, right time: stages are 8 hours apart at minimum; a failed payment gets the message it needs; browse views get one note, later, when enabled.
5. Competing automations: the quiet period covers every flow; the cart family now has its own gap; browse yields to every other automation and to any open cart.
6. Which emails make orders: the funnel answers per flow and stage, strict and benchmark-style side by side.
7. Drop-off: read the funnel's delivered → human click column first; that was the whole loss.
8. Test next: the stage-3 subject arms (product vs added) under the restrained shape; then layout (P1) if clicks stay low; then the sender name.

## 8. Verification record (2026-09-11, end of session)

What was run, against what, and what it showed. Production was not touched by
any of it except the two additive migrations noted in §7.

| Check | Result |
|---|---|
| `npm run lint` | 0 errors (62 pre-existing warnings, all unused test placeholders) |
| `tsc --noEmit` | clean |
| `vitest run` | 668 files, 10,380 tests passed, 245 skipped |
| `NODE_ENV=test next build` | clean |
| `scripts/qa-guest-recovery.mjs` on the local harness | 34 passed, 0 failed: click → grant → restore → cart → checkout reachable; every gated surface stays shut; tampering refused |
| Lifecycle cron (`/api/cron/lifecycle`) on the harness with seeded carts | 2h cart: generic stage 1. 2h cart with a declined card after it: "Your payment did not go through", order number, "nothing was charged". 25h cart with stages 1–2 gone a day ago: "Your BPC-157 10mg is still saved", gift in one sentence, terms once, "Complete my order". 73h cart: "One last note about your Ipamorelin 5mg", gift sentence, 10% code in words, no code box. 13h cart whose stage 1 went 2h ago: held, nothing sent (the 8-hour gap). Every new row carries `experiment = subject-2026-09-plain`. |
| Browse follow-up on the harness (row enabled for the test, then disabled again) | A consented, attested account holder with a 6h-old view of GHK-Cu and no cart or order received "Still looking at GHK-Cu 50mg?"; the button's click was recorded (`email_automation_clicks`, an engagement event, `clicked_at`) and landed a signed-out browser on `/products/ghk-cu` with the buy panel, at 390×844. |
| Customer journey at 390×844 (Chromium, Playwright MCP) | Stage-3 email button → tracked click → cart restored with both lines and both gift lines at $0.00 → "Continue to checkout" → checkout with the address prefilled and the summary total. |
| Admin → Email, desktop | The lifecycle funnel renders per stage with the floor/target line, the "too few" flag, and a human click counted after a phone-user-agent click on a counted send. Harness `.test` addresses are excluded as designed, so only the harness's real-shaped addresses appear. |

### Harness drift found on the way (pre-existing, not fixed here)

- `scripts/qa-lifecycle-email.mjs`, `qa-retention-system.mjs` and
  `qa-cart-recovery-override.mjs` still call `/api/cron/sweep`, but cart
  recovery and the automations moved to `/api/cron/lifecycle` when the cron
  was split (main, 2026-09-08). All three now report "expected one email, got
  none" for every send-dependent step. Their signup payload also predates the
  21+/research-use attestation fields the signup API now requires, and their
  guest browsing steps predate the account-only storefront. The override suite
  additionally assumes the HTTPS proxy stack (`https://127.0.0.1:3443`).
  Updating the three suites is a separate piece of work; the checks above
  cover the same ground by hand for the flows this change set touches.
- `scripts/setup-local-harness.sh` did not apply
  `abandoned-cart-checkout-started.sql`, so the harness lacked
  `abandoned_carts.checkout_started_at` and the funnel reported itself
  unavailable until it was added to the apply list (fixed in this change set).

### Left for the owner

- Consumer-Gmail tab readings for the P1-plain and P2-doc probes.
- Google Postmaster enrolment; DMARC to `p=quarantine` when ready; Outlook,
  Yahoo and iCloud seed addresses for the next placement round.
- `RESEND_WEBHOOK_SIGNING_SECRET` is still unset in production, so delivery
  events are refused (503) and the funnel's "delivered" column reads
  "unknown" until it is set. This was already true before this work.
- Enable the browse follow-up in Admin → Email when the cart stages have
  enough sends to read on their own.

