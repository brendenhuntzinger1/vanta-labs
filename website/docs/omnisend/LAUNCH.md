> **This file is the build log. `TRANSITION.md` is the current state of the
> transition and the GO/NO-GO — read that first; where the two disagree,
> `TRANSITION.md` was written later and against live data.**

# Omnisend transition: launch summary

Everything below is staged. **Nothing is enabled in Omnisend, nothing has been
sent to a customer, and nothing has merged to `main`.** This is the document to
read before authorising any step in `OPERATIONS.md` §4.

What HAS changed, on 2026-09-17: the account now holds data. 121 contacts,
9 categories, 34 products and 17 order events were pushed directly through the
API so the segments populate and the flows have something to render before
cutover rather than after it — see §4. Every automation stayed disabled
throughout, which is what made the push safe and is the reason the order below
puts data first and flows last.

## 1. What was implemented

* **Store integration** (`website/src/lib/marketing/omnisend/`): gated
  transport with one bounded retry, event ledger (exactly once per entity and
  event), per-contact sealed link token and click route, contact facts and
  payload (consent copied exactly), store-minted per-contact codes, event
  builders, order loader, catalogue sync, consent/cart/checkout/product-view
  hooks, order hooks (paid, fulfilled, cancelled, refunded) wired into the
  payment webhook (both paid lanes and processor reversals), Shippo and the
  admin order actions, the cart-offer sweep (banded code and gift for
  Omnisend-owned carts), the order backstop with a floor, catalogue and
  contacts cadence jobs, the nightly reconcile with write-back, batch polling
  and a counts-only report, the consent snapshot, the migration state, and
  the marketing ownership switch.
* **Cart handoff**: one owner per cart. Carts with an in-house stage finish
  in-house (legacy-only sweep); carts with none are Omnisend's once
  `OMNISEND_MARKETING_OWNER=true`. Automations stand down, campaigns run
  affiliate-only, the birthday email stands down (points still granted), the
  admin resend refuses Omnisend-owned carts.
* **Privacy**: no email address travels in any URL. The Omnisend link token
  (v2) and the attestation handoff (v2) both seal it.
* **Omnisend account**: 2 universal layouts, 34 templates, SMS catalogue
  (9 texts), 19 segments, 9 automations (disabled), 1 sign-up form (draft),
  3 campaign drafts. All generated from `website/scripts/omnisend/` and
  re-creatable.
* **Welcome offer (2026-09-16)**: 15% off a first order, minted by the store
  at sign-up (site at once, pop-up within the half hour) and sent by the
  `welcome-offer` flow the moment it exists. A free GHK-Cu half is built and
  dormant (`WELCOME_GIFT_ENABLED = false`). SMS consent is collected on the
  sign-up page and at the checkout as well as in account settings and the
  pop-up. Design: `docs/superpowers/specs/2026-09-16-welcome-offer-and-sms-capture.md`.
* **Policies**: privacy, cookie and terms text name Omnisend, what it
  receives, and the SMS program terms; pinned by tests.
* **Documents**: `AUDIT.md` (what sends today, ownership table, findings),
  `MIGRATION.md` (field map, operator sequence, report, rollback),
  `OPERATIONS.md` (deliverability, attribution, metrics, launch order,
  rollback, cost, monitoring, promotions), `DESIGN.md` (the premium and
  conversion review against Omnisend's benchmarks and premium brands on the
  platform), `VERIFICATION.md` (evidence), `CHECKLIST.md` (state of the
  work).

## 2. Ownership table

See `AUDIT.md` §2 for the full table. In one line each: Resend keeps every
transactional and operational message (auth, receipts, payment status,
shipping, refunds, membership, affiliate, ambassador); the in-house
marketing engine keeps only the legacy cart sequences already started and
affiliate broadcasts; Omnisend owns marketing email and SMS, segmentation and
marketing automations once the switch is set.

## 3. Omnisend object registry

Layouts: header `6aa985ecfa261ac55e04bae3`, footer `6aa985f7c29076c61d3838b1`.

| Template | Omnisend id |
|---|---|
| welcome-1 | `6aa98802072042c2a4166153` |
| welcome-2 | `6aa98867072042c2a4166279` |
| welcome-2-code | `6aaae3a55322cd96de57bc97` |
| welcome-3 | `6aa988a450c3f856bc4fb830` |
| welcome-3-nocode | `6aaae36b5322cd96de57bc76` |
| welcome-offer | `6aab2004072042c2a4193a25` |
| welcome-offer-code | `6aab2032072042c2a4193a3e` |
| cart-1 | `6aaaa7eb7aea37873281b0d0` |
| cart-2 | `6aaaa85150c3f856bc51eca1` |
| cart-3-gift-code | `6aaaa89e50c3f856bc51edae` |
| cart-3-gift | `6aaaa8f3072042c2a418aea7` |
| cart-3-code | `6aaaa9387aea37873281b1cd` |
| cart-3-plain | `6aaaa97c072042c2a418afd4` |
| checkout-1 | `6aaaa9b87aea37873281b230` |
| checkout-2 | `6aaaaa027aea37873281b246` |
| checkout-3-gift-code | `6aaaaa5150c3f856bc51f12e` |
| checkout-3-gift | `6aaaaa9f50c3f856bc51f1ba` |
| checkout-3-code | `6aaaaae450c3f856bc51f24f` |
| checkout-3-plain | `6aaaab2a50c3f856bc51f2e0` |
| browse-1 | `6aaaab6550c3f856bc51f36e` |
| post-purchase-1 | `6aa9895b50c3f856bc4fba9e` |
| post-purchase-2 | `6aaaabb27aea37873281b375` |
| replenishment | `6aaaabf0072042c2a418b47f` |
| winback-1 | `6aaaac39fe9daa7b181e2243` |
| winback-2 | `6aa9897e50c3f856bc4fbafc` |
| winback-2-nocode | `6aaaac50fe9daa7b181e225b` |
| sunset | `6aa9899550c3f856bc4fbb1a` |
| new-product | `6aaaac9d86e7ed7624668db2` |
| promotion | `6aaaacbefe9daa7b181e22b9` |
| promotion-final-day | `6aaaace4fe9daa7b181e22ce` |
| vip-milestone | `6aaaad0e50c3f856bc51f611` |
| repeat-customer | `6aaaad2f86e7ed7624668e38` |
| campaign-batch-report | `6aaaad6e90101032569bf3c7` |
| campaign-restock | `6aaaadc250c3f856bc51f65e` |

| Segment | Omnisend id |
|---|---|
| vl-subscribers | `6aa9890aeba844d1e0e9539d` |
| vl-sms-subscribers | `6aa9890b37e7762ce4afac26` |
| vl-customers | `6aa9890eeba844d1e0e9539e` |
| vl-attested | `6aa98910eba844d1e0e9539f` |
| vl-never-bought | `6aa9891037e7762ce4afac28` |
| vl-bought-30d | `6aa9891237e7762ce4afac29` |
| vl-lapsed-60 | `6aa9891356e90f08f163f5ac` |
| vl-lapsed-90 | `6aa9891537e7762ce4afac2a` |
| vl-vip | `6aa9891737e7762ce4afac2b` |
| vl-campaign-audience | `6aa9891856e90f08f163f5ad` |
| vl-engaged-90 | `6aa9894deba844d1e0e953a0` |
| vl-unengaged-120 | `6aaae34d9ca7eb31e5d9e654` |
| vl-repeat-customers | `6aa9895a56e90f08f163f5af` |
| vl-browsed-no-order-30d | `6aa9895c56e90f08f163f5b0` |
| vl-recovery-gift-ready | `6aaaae67f658a847e55713a6` |
| vl-recovery-code-ready | `6aaaae68f658a847e55713a7` |
| vl-winback-ready | `6aaaaefc171138e617aa7178` |
| vl-welcome-ready | `6aaac3f27cbd2da70ddb4dc7` |
| vl-welcome-gift-ready | `6aab1fc6b9539893816902de` |

| Automation (all disabled) | Omnisend id |
|---|---|
| welcome | `6aaaafe4db06f9edc9ed232e` |
| welcome-offer | `6aab20de8c9071b61a081004` |
| abandoned-cart | `6aaaaff3db06f9edc9ed2337` |
| abandoned-checkout | `6aaab003db06f9edc9ed233f` |
| browse-abandonment | `6aaab005cb1ca6f74dc35ee6` |
| post-purchase | `6aaab00cdb06f9edc9ed2347` |
| replenishment | `6aaab010db06f9edc9ed234d` |
| win-back | `6aaab019cb1ca6f74dc35ee9` |
| sunset | `6aaab01fdb06f9edc9ed2353` |

| Form (draft) | Omnisend id |
|---|---|
| signup | `6aaab173090e83c9759fd50d` |

| Campaign draft | Omnisend id |
|---|---|
| VL new product announcement | `6aaab0391446172ca4503db7` |
| VL general promotion | `6aaab03b1446172ca4503db9` |
| VL final day | `6aaab03c1446172ca4503dba` |

The stray draft form `6aaa9bef27f565e8b3f4b22f` ("Email & SMS branded
Multi-step welcome discount") was created from Omnisend's stock template on
2026-09-16 and not by this work; it is left untouched for the owner to delete
or keep.

Each automation holds its own copies of the templates it sends; the live copy
ids are in `scripts/omnisend/assets/automation-content.json`. Replacing an
automation's block tree (done on 2026-09-16 for the welcome split, the
win-back re-entry and the post-purchase spacing, and again that evening for
the design pass in `DESIGN.md`) copies the templates again, so the copies
from the earlier builds are now orphaned inside Omnisend. They are
unreferenced, send nothing and cost nothing; the owner may delete them in the
Omnisend editor or leave them. The first `vl-unengaged-120` segment
(`6aa9895956e90f08f163f5ae`) was superseded the same day because its
`dateAdded` filter carried a literal placeholder rather than a date; the
sunset flow now points at the replacement and the old segment is still in the
account, unreferenced.

Welcome design: the first email and the SMS never carry a code, because the
code may not exist yet. The store mints it at a site sign-up, on the next
nightly reconcile for a form sign-up, and never for a checkout opt-in; the
second and third emails split on `vl-welcome-ready` so a contact without a
code sees the plain variant rather than a blank card.

## 4. Contact reconciliation

The app's own reconcile has still not run — it cannot, because the branch is
not deployed and `omnisendRequest` refuses outside production by design
(`lib/ads/ads-environment.ts`, no override). When it does run, the first run is
the owner's call, in this order: `snapshot` → `contacts` with `dryRun: true` →
read the report → `contacts`. Store totals on 2026-09-16 that the dry run
should reproduce: 106 consented addresses, 0 SMS consents, 3 suppressions,
12 buyers, 183 accounts. The report's `unresolved` list must be empty before
flows are enabled.

### The seed of 2026-09-17

121 contacts were pushed directly through the Omnisend API, in three batches,
so the account has its audience and its segments populate before cutover:

| | |
|---|---|
| subscribed | 118 |
| unsubscribed | 1 |
| nonSubscribed (buyers, no consent on record) | 2 |

Built from the store with the SAME precedence `collectContactFacts` applies —
suppression first, then either consent store, then a guest opt-out, then
unknown — so no address went in more permissive than the store holds. Two
things were filtered out that the naive union contains:

* `bounced@resend.dev` and `complained@resend.dev`, per `isNonMailableAddress`.
  They are provider sinks: mail to them manufactures a bounce and a spam
  complaint against this domain, on purpose, every time.
* 18 addresses that are neither consented nor buyers. The reconcile would
  never maintain them, so seeding them would have left 18 rows nobody owns.

Two order names were dropped rather than guessed: one is an address fragment
("apartment abry") and one a privacy marker ("Private"). Both would have
rendered as `Hi apartment` in a personalised send. `splitName` does not catch
either, so the nightly push will reintroduce them — worth a look before any
campaign uses `firstName`.

What the seed does NOT carry, because only the deployed app can mint it:
`vl_link` and the welcome/win-back/recovery codes. Every automation and SMS
body interpolates `[[contact.custom_properties.vl_link]]`, so those links are
BLANK until the branch ships and the nightly reconcile fills them in. That is
safe only because the automations are disabled; it is the reason the ordering
below is not negotiable.

**Contacts must be imported BEFORE automations are enabled, never after.**
Omnisend automations fire on events that occur while they are enabled and do
not backfill. `VL · Welcome` triggers on `subscribed to marketing`, and
`VL · Welcome offer` on entering a segment — so enabling those first and then
importing would enrol all 118 subscribed contacts into the welcome series at
once, with a blank link in every message.

### The catalogue and the order history, same day

Pushed directly through the API, so the account holds what the flows need
before cutover rather than after it:

| | |
|---|---|
| categories | 9 |
| products | 34, carrying 46 dose variants |
| `paid for order` events | 17, covering every paid product order since 2026-08-02 |

The catalogue matters because abandoned cart, abandoned checkout and browse
abandonment all render product blocks, and a product Omnisend does not hold
renders nothing. The order events matter because `VL · Repeat customers` —
which `VL · Post-purchase` branches on — is defined on `paid for order` and
was empty. It now resolves to the one buyer with more than one paid order.

NOT pushed, and why: cart and product-view history. `added product to cart`
is the abandoned-cart trigger, so replaying stale carts would be wrong; live
carts are handed over by the cart-offer sweep at cutover (§5). Views are not
stored anywhere to replay. `VL · Browsed, no order (30 days)` therefore stays
empty until the branch is live — that is expected, not a fault.

### Three defects the pushes found

Every one of them was invisible from inside the code, because a per-item 4xx
inside a background batch is a number on a batch record and nothing else, and
in each case the suite asserted the builder's output rather than the rule the
API enforces — so the tests agreed with the bug.

1. **Contacts.** The payload omitted the email channel block for a
   `nonSubscribed` contact; Omnisend refuses an email identifier without one.
   One in forty-one refused — the single buyer with no consent on record, which
   is exactly the population that block exists to carry.
2. **Catalogue.** Variant ids were `slug#doseId`. Omnisend allows only letters,
   numbers, underscores and dashes, so all 34 products were refused, every run.
3. **Events.** `eventID` was a descriptive string; Omnisend requires a UUID.
   Every event of every kind was refused — views, carts, checkouts, orders —
   which is the whole event-driven half of this migration. Separately, order
   line items looked products up by a column that never matched, so each line
   named an unknown product with no category, no image and no link.

All three are fixed on the branch, each with a test that asserts the API's rule
rather than the builder's output, and each verified by a push that the live API
accepted.

## 5. How existing carts and sequences are handed off

* 12 open carts were mid-sequence on 2026-09-16 ($2,306.85). Each has at
  least one in-house stage, so the legacy-only sweep finishes them; none is
  reported to Omnisend. A cart with no stage at cutover, touched in the last
  96 hours, is reported once by the cart-offer sweep and enters Omnisend's
  flow at step one, which is correct because it has received nothing.
* In-house automations (welcome pair, post-purchase, replenishment,
  win-backs) stop at cutover. A contact between the two welcome emails does
  not get the second; a buyer whose post-purchase was due does not get it
  from either system. This is the accepted loss; it is bounded to the seven
  days before cutover, and it is stated in `AUDIT.md` F-03.
* 412 live recovery gift tokens and 70 win-back tokens keep redeeming at
  checkout; nothing is revoked.
* `marketing_send_queue` was empty on 2026-09-16; anything in it at cutover
  still drains (it is event mail already claimed).

## 6. Test evidence and limitations

See `VERIFICATION.md`. Passed: unit and source suites (full run green),
typecheck, lint, production build, and the harness checks of the click route
(seven cases at phone width), the old recovery link, the legal pages, the
gated cron jobs, the guest checkout beacon and the sealed attestation handoff
(both at phone width, after the review fixes). Blocked on the owner: seed sends (no authenticated sender
domain, no authorisation), SMS (no verified sender, zero consents), and
production evidence (no cutover). Known limitations: conditional content is
not on the current plan, so the recovery flows use four template variants
behind segment splits; recommender blocks are plain links; partial refunds
send no event; Omnisend has no cross-flow frequency cap beyond each flow's
limiter; email opens are unreliable and SMS opens do not exist.

## 6a. What comes BACK from Omnisend, and the one thing that does not

Worth stating plainly because it has been described wrongly: an inbound
webhook is not needed and was not built. The write-back already exists and is
stronger than a webhook would be.

`reconcileOmnisendContacts({ push: false })` runs on EVERY sweep tick — every
thirty minutes, registered as `omnisendContactsReconcile` in
`/api/cron/sweep` — pages `GET /contacts?updatedAtFrom=<watermark>`, and
`planWriteBack` turns an Omnisend `unsubscribed` into an `email_suppressions`
row, an SMS opt-out into the account's opt-out stamp, and a form sign-up into
a guest subscriber. Only the full contacts PUSH is throttled to daily.

That it pulls rather than receives is the strength, not a gap. It is
authenticated by our own API key against Omnisend's servers, so there is
nothing forgeable about it. The Omnisend Public API exposes no webhook
registration at all (the operation catalogue has none), and an unsigned
inbound endpoint that can write `email_suppressions` is precisely the
vulnerability `webhooks/email/route.ts` spent a page of comment closing for
Resend. Latency is at most one sweep tick.

**THE REAL GAP IS BOUNCES AND SPAM COMPLAINTS.** The contacts API carries only
three channel statuses — `subscribed`, `unsubscribed`, `nonSubscribed` — and no
bounce field. So a hard bounce or a spam complaint that Omnisend observes after
cutover reaches `email_suppressions` only if Omnisend also flips the contact to
`unsubscribed`, which is not documented and not verified. Today Resend's
webhook fills that role; after cutover Resend stops seeing marketing mail, and
the store's own suppression list stops learning about dead and hostile
addresses — the list that also protects the domain carrying every receipt.

It is closable with a pull, on the same shape as the write-back.
`POST /api/events/query` returns per-contact events including
`marked message as spam` and `message delivery failed` (100 contacts per call,
20 calls a minute — four calls covers this audience). Mapping:
`marked message as spam` → `complained`, unliftable, unambiguous. A delivery
failure is NOT a hard bounce: the event name does not say whether it is
permanent, so it belongs on the existing consecutive-run escalation
(`CONSECUTIVE_SOFT_BOUNCE_LIMIT`, reason `soft_bounce_run`, customer-
reversible) unless a property in the payload says permanent. Not built; it
should be, before `OMNISEND_MARKETING_OWNER` is set.

## 7. What is live, staged, disabled, awaiting

| Item | State |
|---|---|
| Store code on branch | staged, not merged |
| `OMNISEND_API_KEY` in Vercel | set 2026-09-16, production scope. Inert: the deployed code has no Omnisend integration |
| `OMNISEND_MARKETING_OWNER` | unset |
| `omnisend-sync.sql` migration | applied — `omnisend_sync_state`, `omnisend_events_sent` and `omnisend_consent_snapshot` all exist and are being written |
| `sms-subscribers.sql` migration | not applied (owner) |
| Contacts in Omnisend | 123 as of 2026-09-17 18:32 — 120 subscribed, 1 unsubscribed, 2 never-consented buyers. `vl_link` and the offer-readiness flags are present on 122 of 123 (the exception is the unsubscribed contact, who needs none) |
| Catalogue in Omnisend | 9 categories, 34 products, 46 variants, pushed 2026-09-17 |
| Order history in Omnisend | 17 `paid for order` events, 2026-08-02 onward |
| Automations | 9, all disabled — enable only AFTER the data is in (§4) |
| Form | draft |
| Campaigns | 3 drafts |
| Sender domain | **AUTHENTICATED**, and verified by observation on 2026-09-18: a delivered Omnisend message shows `dkim=pass` for `d=vantalabsresearch.com` (selector `krs`), `spf=pass` via the Mailgun include, and `dmarc=pass` aligned on the root. The 2026-09-16 entry was right; a later note calling it unauthenticated was my error, from probing guessed selectors and reading absence into a negative result |
| SMS | Pro plan with SMS bought and US verification submitted 2026-09-16; awaiting approval (owner) |
| Postal address in footer | **still a placeholder** — the block renders `POSTAL ADDRESS — owner to replace before the first send`. `TRANSITION.md` §B2 |
| Scheduled sync | proven working 2026-09-17 18:30 — six watermarks stamped, every contact repaired |

Owner actions, in the order they unblock things (details in `OPERATIONS.md`
§1 and §4 and `MIGRATION.md`):

1. Authenticate the sender domain in Omnisend (DNS records the dashboard
   shows) and set the sender name and reply-to; until then campaigns fall
   back to Omnisend's shared address.
2. Choose the plan and complete US SMS verification if SMS is wanted; SMS
   steps stay off until the dashboard says approved.
3. Put the postal address into the footer layout.
4. Apply `src/lib/sql/omnisend-sync.sql` (three tables) and
   `src/lib/sql/sms-subscribers.sql` (one table) to production, no data
   change, and set `OMNISEND_API_KEY` in Vercel (set 2026-09-16, not yet
   redeployed).
5. Run the contact reconciliation: snapshot, dry run, read the report, push.
6. Set `OMNISEND_MARKETING_OWNER=true` first, then enable flows one at a
   time in the §4 order. The switch must precede the flows so that no cart
   has two owners.

## 8. Rollback

`OPERATIONS.md` §5 and `MIGRATION.md`. In short: disable the flows in
Omnisend, unset `OMNISEND_MARKETING_OWNER`, and if needed remove
`OMNISEND_API_KEY`. Consent was never widened; the ledger keeps completed
steps from replaying; nothing is deleted.

## 9. Costs and monitoring

`OPERATIONS.md` §6 and §7.

## 10. Launching a promotion

`OPERATIONS.md` §8.
