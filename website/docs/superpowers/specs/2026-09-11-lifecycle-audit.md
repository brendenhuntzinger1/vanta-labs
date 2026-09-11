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
