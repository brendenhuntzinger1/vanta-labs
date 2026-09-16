# Omnisend transition: launch summary

Everything below is staged. Nothing is enabled in Omnisend, nothing has been
sent, no contact has been pushed, and nothing has merged to `main`. This is
the document to read before authorising any step in `OPERATIONS.md` §4.

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
* **Omnisend account**: 2 universal layouts, 30 templates, SMS catalogue,
  17 segments, 8 automations (disabled), 1 sign-up form (draft), 3 campaign
  drafts. All generated from `website/scripts/omnisend/` and re-creatable.
* **Policies**: privacy, cookie and terms text name Omnisend, what it
  receives, and the SMS program terms; pinned by tests.
* **Documents**: `AUDIT.md` (what sends today, ownership table, findings),
  `MIGRATION.md` (field map, operator sequence, report, rollback),
  `OPERATIONS.md` (deliverability, attribution, metrics, launch order,
  rollback, cost, monitoring, promotions), `VERIFICATION.md` (evidence),
  `CHECKLIST.md` (state of the work).

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
| welcome-3 | `6aa988a450c3f856bc4fb830` |
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
| vl-unengaged-120 | `6aa9895956e90f08f163f5ae` |
| vl-repeat-customers | `6aa9895a56e90f08f163f5af` |
| vl-browsed-no-order-30d | `6aa9895c56e90f08f163f5b0` |
| vl-recovery-gift-ready | `6aaaae67f658a847e55713a6` |
| vl-recovery-code-ready | `6aaaae68f658a847e55713a7` |
| vl-winback-ready | `6aaaaefc171138e617aa7178` |

| Automation (all disabled) | Omnisend id |
|---|---|
| welcome | `6aaaafe4db06f9edc9ed232e` |
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

## 4. Contact reconciliation

Not run. The first run is the owner's call, in this order: `snapshot` →
`contacts` with `dryRun: true` → read the report → `contacts`. Store totals on
2026-09-16 that the dry run should reproduce: 106 consented addresses,
0 SMS consents, 3 suppressions, 12 buyers, 183 accounts. The report's
`unresolved` list must be empty before flows are enabled.

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
(seven cases at phone width), the old recovery link, the legal pages and the
gated cron jobs. Blocked on the owner: seed sends (no authenticated sender
domain, no authorisation), SMS (no verified sender, zero consents), and
production evidence (no cutover). Known limitations: conditional content is
not on the current plan, so the recovery flows use four template variants
behind segment splits; recommender blocks are plain links; partial refunds
send no event; Omnisend has no cross-flow frequency cap beyond each flow's
limiter; email opens are unreliable and SMS opens do not exist.

## 7. What is live, staged, disabled, awaiting

| Item | State |
|---|---|
| Store code on branch | staged, not merged |
| `OMNISEND_API_KEY` in Vercel | not set (owner) |
| `OMNISEND_MARKETING_OWNER` | unset |
| `omnisend-sync.sql` migration | not applied (owner) |
| Contacts in Omnisend | 0 pushed |
| Automations | 8, all disabled |
| Form | draft |
| Campaigns | 3 drafts |
| Sender domain | awaiting DNS (owner) |
| SMS | awaiting verification and plan (owner) |
| Postal address in footer | awaiting owner |

## 8. Rollback

`OPERATIONS.md` §5 and `MIGRATION.md`. In short: disable the flows in
Omnisend, unset `OMNISEND_MARKETING_OWNER`, and if needed remove
`OMNISEND_API_KEY`. Consent was never widened; the ledger keeps completed
steps from replaying; nothing is deleted.

## 9. Costs and monitoring

`OPERATIONS.md` §6 and §7.

## 10. Launching a promotion

`OPERATIONS.md` §8.
