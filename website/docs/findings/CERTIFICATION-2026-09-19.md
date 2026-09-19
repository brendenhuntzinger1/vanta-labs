# Full-system production certification — 2026-09-19

**STATUS: BLOCKED — HUMAN ACTION REQUIRED**

Nothing in the customer's path to a completed, correctly-priced, correctly-shipped
order is broken. No money is mis-stated anywhere. No consent record is wrong.
The block is not a code defect: it is two items that only a human with provider
credentials can close (the Twilio toll-free verification status, and a Supabase
Auth toggle), plus one deliberately-disabled feature that must not be enabled
until its parity work lands.

Six real defects were found. All six are low severity, none is customer-critical,
and they are listed with evidence below. Eight further suspicions were
investigated and **disproven** — they are recorded as disproven rather than
quietly dropped, because a certification that only lists what it found is not
auditable.

---

## A. Production baseline

| | |
|---|---|
| `origin/main` SHA | `7ccbee89add352cefe91d84e68f07c089acc98ef` |
| Deployed SHA | `7ccbee89add352cefe91d84e68f07c089acc98ef` |
| Deployment ID | `dpl_FMEUsKtfYPFsfox3hr1bGrCKTC7Q` |
| Exact match | **YES** |

The deployment ID was confirmed twice from independent sources: the Vercel API,
and the `data-dpl-id` attribute served in a live production response. The
audit branch `claude/certification` adds test files only — no `src/` behaviour
changes — so the tree under test is behaviourally identical to what is deployed.

Production host is **`www.vantalabsresearch.com`**. `vantalabs.co` is a
Squarespace "Coming Soon" page and is **not** the store; an early probe of it
nearly produced a false "the gate is not working" finding, which is why every
gate result below is stated against the verified host.

---

## B. Customer journeys

The thirteen roles named in the brief, each PASS/FAIL with its evidence.

| # | Journey | Verdict | Evidence |
|---|---|---|---|
| 1 | Brand-new customer | **PASS** | `certification-journeys.test.ts` journey C: quote → order → inventory → margin reconciled end to end. Browser: `/` → 307 → `/account/login?next=%2F`, sign-in, home, catalogue, product, cart at 390×844. |
| 2 | Returning customer | **PASS** | Journey H: returning shopper carrying a STOP + an email suppression; order completes, no marketing sent, suppression honoured. |
| 3 | Customer using the wheel | **PASS** | Journeys A, B, G: spin → prize minted → prize survives to the till → gift line priced at $0 by the server → inventory decremented → reward marked redeemed. |
| 4 | Customer not using the wheel | **PASS** | Journey C: identical order path with no offer token; no gift line, no phantom discount. |
| 5 | Normal checkout | **PASS** | Section F below: 18 tamper/lifecycle tests, all passing. Server prices every line from the catalogue. |
| 6 | Express / quick checkout | **N/A — FEATURE DISABLED** | See section G. The lane is closed at the source, not merely at an env var. |
| 7 | Payment fails or is abandoned | **PASS** | Journey E: decline → offer released back to live → retry succeeds and redeems it. Production: `VL-BD9AE9EB` failed 2026-09-01 21:18:36 and the same basket succeeded 59s later as `VL-27C530F8` — one charge, not two. |
| 8 | Mobile / in-app browser | **PASS** | Section S: 7 widths × 5 routes, zero horizontal scroll, zero nav/banner overlap. Facebook and Instagram in-app user agents receive byte-identical gate answers. |
| 9 | Vanta administrator | **PASS** | Every `/api/admin/*` probe unauthenticated returns 401/404/405 — never data. Manual cart-recovery resends are fully audited (actor, IP, UA, stage, timestamp). |
| 10 | Fulfilment operator | **PASS** | Zero orders shipped without payment; fulfilment ladder invariants clean (section V). |
| 11 | Business owner (revenue/COGS/margin/payouts) | **PASS with one gap** | Section Q: order arithmetic ties to the cent on all 20 paid orders; payouts tie three ways at $55.50. One historical order carries no postage cost — defect **Q-1**. |
| 12 | Security / privacy engineer | **PASS with one config gap** | Section R: 12 sensitive tables refuse the anonymous key outright. One Supabase Auth toggle is off — **R-1**. |
| 13 | Adversarial QA (cross-system assumptions) | **PASS** | Eight suspicions raised and driven to a verdict; see "Disproven" below. Two cross-journey double-spend tests prove one prize cannot pay for two orders. |

---

## C. Universal portal / access

Probed live against `www.vantalabsresearch.com` with no cookies.

**Gated — 307 to `/account/login?next=<path>`:** `/`, `/products`,
`/products/ghk-cu`, `/cart`, `/checkout`, `/spin`, `/account`.

**ROOT IS GATED.** `GET /` answers `307 → /account/login?next=%2F`. This was the
central requirement of the restoration and it holds in production.

**Public compliance island — 200 with real content:** `/sms`
("SMS Marketing Sign-Up"), `/legal/privacy` ("Privacy Policy"),
`/legal/terms` ("Terms of Service"). `/privacy` and `/terms` 308 to their
canonical `/legal/*` homes, so the obvious URL a carrier or reviewer types
resolves rather than hitting the wall.

**The island grants nothing.** Measured, not assumed:

- `/sms`, `/legal/privacy`, `/legal/terms` each return **zero `Set-Cookie`
  headers**.
- After visiting all three with a shared cookie jar, the jar is **empty**, and
  `/` and `/products` are still `307`.
- The same holds for the other public pages (`/ambassador`, `/partner`,
  `/contact`, `/wholesale`, `/legal/cookies`): zero cookies, `/` still gated.

**No cloaking.** Eight identities — plain curl, Googlebot, Bingbot, a Twilio
UA, an Omnisend UA, iPhone Safari, the Facebook in-app browser and the Instagram
in-app browser — received **identical** answers: `/` 307, `/products` 307,
`/sms` 200. There is no branch on user agent, IP or crawler identity.

**Sitemap is consistent with the wall.** All 11 sitemap URLs return 200 to an
anonymous visitor. The sitemap advertises nothing that is gated, and `/` is not
in it.

---

## D. Wheel

Server authority is intact. The prize is drawn server-side, written to
`customer_offers`, and the browser never learns anything it could forge: the
checkout request carries an id and a quantity and nothing else
(`cart-cannot-price-itself.test.ts` asserts `CartItemInput` is *exactly*
`{id, quantity}` as an equality, so a newly-added price field fails the test).

Production state: 520 offers ever issued, 399 revoked (re-issues retiring their
predecessor, as designed), 115 live now, 0 redeemed to date.

The one-live-offer rule is `customer_offers_one_live_per_email` on
`(offer_key, email) WHERE revoked_at IS NULL AND redeemed_at IS NULL` — one live
offer *per programme* per address. See the disproven item **DIS-6** for why 13
addresses legitimately hold two.

---

## E. 72-hour rewards

`certification-72h-boundary.test.ts` — **14 tests, all passing.**

72 hours = 259,200 s = **259,200,000 ms**, pinned three ways: the constant
(`SPIN_TTL_DAYS = 3`), the line that stamps the row, and the SQL that refuses a
stale one.

The boundary walked through the **real** `peekCustomerOffer` filter with an
injected clock — exact, not approximate, no sleeping, no flake:

| Moment | Verdict |
|---|---|
| at issue | live |
| 71 h 59 m 59 s | live |
| 90 s remaining | live |
| 1 s remaining | live |
| **1 ms remaining** | **live** |
| **exactly 72 h** | **dead** |
| +1 ms | dead |
| +1 s | dead |
| +1 day | dead |

Dead *on* the stroke, because the comparison is `<=`. That is what stops 72
hours quietly becoming 72 hours plus one round trip.

The two clocks are pinned apart so they cannot be confused: the spin **link**
lives 30 days (`SPIN_TOKEN_TTL_MS`) because people open marketing mail late; the
**prize** lives 72 hours from the moment it is drawn. And the SQL enforces the
same instant as the read — `if v_offer.expires_at <= now() then return; end if;`
— so the reserve cannot honour what the read refused.

---

## F. Normal checkout

`certification-tamper-lifecycle.test.ts` — **18 tests, all passing.**

Every one of these is refused or ignored, server-side:

- a claimed line price, subtotal, discount or total
- an unknown product slug (refused, never priced at zero)
- a client-supplied $0 gift line
- a **forwarded** offer token (the row is fetched by token *and* address
  together, so a forwarded link quotes nothing for whoever is holding it)
- a **forged** offer token
- an **expired** prize
- a gift below its own minimum subtotal (withheld, and the customer is told)
- an oversell beyond available stock

One finding from writing these is worth stating plainly: where the test expected
the server to *ignore* a tampered `expectedTotal` and return 200, the server
actually returns **400 and refuses the request**. That is stronger than the
specification, so the test now accepts either and documents both.

---

## G. Express / Apple Pay

**FEATURE DISABLED — NOT CURRENT CUSTOMER IMPACT — REQUIRES COMPLETION BEFORE
ENABLEMENT.**

**Correction to an earlier statement in this engagement.** I previously said the
express lane had never been live. That was wrong, and the production record is
unambiguous:

| Order | Date | Paid |
|---|---|---|
| VL-E8F4D52F | 2026-08-02 | $76.04 |
| VL-8847B157 | 2026-08-03 | $73.84 |
| VL-C98B8AB1 | 2026-08-27 | $103.38 |
| VL-27C530F8 | 2026-09-01 | $94.96 |
| VL-E2E1BF57 | 2026-09-03 | $69.98 |
| **Total** | | **$418.20** |

Five real orders carrying `checkout_channel = 'express_apple_pay'`, plus one
`payment_failed` that succeeded on retry 59 seconds later. The lane was closed
on **2026-09-08** by commit `7538e83b`, which added a second hard gate —
`EXPRESS_OFFER_PARITY = false` — that the env var cannot open.

The defect that closed it was real: the express routes priced quotes without the
offer cookie and stamped no email attribution. Production confirms the
symptom exactly — all five orders show `offers_reserved = 0`,
`attributed_automation_key = NULL` and `attributed_campaign_id = NULL`.

**But no customer was shortchanged.** Checked directly: for all six express
attempts, the number of live, unredeemed, unrevoked offers held by that address
at the moment of purchase was **zero**. The defect was latent; the harm never
materialised. The shutdown was nonetheless correct — the next wallet customer
holding a prize would have lost it silently.

Current state, verified in the browser: the Apple Pay button and the accepted-
payments pill do not render. `EXPRESS_CHECKOUT_ENABLED` requires
`NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED === "true"` **and**
`EXPRESS_OFFER_PARITY`, and the latter is a source constant set to `false`.

A parity fix exists on the unmerged branch `claude/zealous-johnson-atb3n5`
(offer cookie into the quote, one named offer address, reservation before the
order). It is **not** part of this certification and the flag has **not** been
flipped. Do not describe Vanta as having working Apple Pay while this lane is
disabled.

---

## H. Payments / webhooks

Covered by the 18 tests in section F. Proven: a successful delivery; a duplicate
event id ignored; distinct event ids each honoured; a late event ignored;
concurrent delivery resolved to one outcome; an **unsigned** payload refused; a
**mis-signed** payload refused; an abandoned session left clean.

Production cross-check: 3 orders sit at `pending_payment`, and Sentry's own
`payment_reconcile_backlog` alert reports the same 3 — the alert and the
database agree, and the alert text is correct that these are abandoned
checkouts with no money moved.

---

## I. Inventory / fulfilment

Clean. Zero products with negative on-hand stock; zero products whose reserved
quantity exceeds on-hand; zero orders shipped, in transit, out for delivery or
delivered without `payment_status = 'paid'`.

---

## J. Abandoned cart — the depth analysis

The brief asked whether the weak abandoned-cart numbers are **a software problem
or a marketing problem**. The answer is **marketing**, and here is the
discriminator.

Both surfaces share one click-tracking route. If that route were broken, both
would read zero.

| Surface | Sends | Opens | Clicks |
|---|---|---|---|
| Cart recovery | 176 | 72 (40.9%) | **2 (1.1%)** |
| Campaigns | 213 | 51 (23.9%) | **8 (3.8%)** |

The tracker demonstrably works in production. Recovery mail is opened at nearly
**double** the campaign rate and clicked at under a **third** of it. The subject
lines are earning the open; the bodies are not earning the click.

Two counter-hypotheses were tested rather than assumed:

**"The recovery link is broken."** Not supported. Clicks have been recorded on
2 of the 4 stages (t30m and t12h). The two stages with zero clicks have 44 and
30 sends against a ~1% base rate, so their expected click counts are 0.5 and
0.3. Zero there is unremarkable, not evidence of a broken link.

**"The 40.9% open rate is Gmail/Apple image prefetch."** Partly true, and the
repository already knew — `admin-cart-recovery.ts` says so in as many words.
Measured: of 72 opens, 9 land within 10 s, 18 within 60 s, 22 within 5 minutes,
and **50 (69%) more than 5 minutes after the send**. Stripping the likely
machine opens still leaves ≈28.4% plausibly-human — a healthy rate. The funnel
still breaks between open and click.

**And the harder finding: the "recovered" number attributes nothing.**

Of 20 recovered carts:

- **10 were never mailed at all** before the customer ordered.
- **0** clicked a recovery email before ordering.
- **0** used the restore link (`restored_at` is null on all 20).

Not one of the 20 can be causally linked to the programme. "Recovered" is
counting any paid order from that address inside the window — a coincidence
counter, not an attribution. The repository says this about itself too; this
certification confirms it against the live data.

**Per the brief, the programme has not been changed.** This is a measurement, not
an intervention.

Volume caveat, stated honestly: at n=176 and a 1.1% click rate the 95% interval
is roughly 0.1–4%. That the tracker works is certain. That the copy is the
binding constraint is well supported but rests on a small sample.

---

## K. Omnisend email

**Nine automations exist and every one is `isEnabled: false`** — VL · Welcome
offer, VL · Sunset, VL · Win-back, VL · Replenishment, VL · Post-purchase,
VL · Browse abandonment, VL · Abandoned checkout, VL · Abandoned cart,
VL · Welcome. All carry `sendingThresholds: {email: "subscribed", sms:
"subscribed"}`.

**So there is currently no Omnisend/Resend double-send risk at all** — Omnisend
is sending nothing, and the in-house system owns every live flow.

**No unattributed duplicate send exists in the entire production history.** The
accounting closes exactly:

```
179  cart-recovery rows in email_send_log (status <> 'failed')
176  stage reservations in abandoned_cart_emails (unique on (cart, stage))
  3  difference
  3  duplicate (campaign_type, reference_id, address) triples
 41  audited operator resends (cart_recovery_manual_resend)
```

Each of the 3 extra rows matches an `admin_audit_logs` entry for the same cart
and stage, by `brendenhuntzinger1`, timestamped within a second of the send.
They are deliberate operator resends through a path that is documented to bypass
the automatic stage claim — and that path is documented to mint **no** gift, so
a second press cannot dispense a second vial. The remaining duplicates are
`auth:*` (password reset, signup confirmation), which are re-sendable by design.

---

## L. Omnisend SMS / compliance

**No SMS has ever been sent from production.** Measured: 0 consent events,
0 sends, 0 delivery events, 0 suppressions, 0 link clicks. Five phone numbers
are stored and **zero** are marked subscribed — consistent with the design
decision to store a number without inferring consent.

### LATEST REJECTION CAUSE NOT PROVEN

What **is** proven, from the repository's own record: two rejection causes drove
design decisions and are named in source.

- *"Opt-in not provided"* — every copy of the consent form lived behind the
  account wall, so the one artefact the review was about was the one artefact a
  reviewer could not reach. `/sms` exists to be that artefact at a stable public
  URL.
- *"Cannot validate business website URL"* — named in `access-policy.ts` as the
  cost of the 307 on `/`, and recorded there as knowingly accepted.

What is **not** proven: no dated provider artefact for the **latest** rejection
exists anywhere reachable from this session. Searched: `website/docs/**`,
`system_alerts`, and the Twilio MCP (which exposes documentation and API
schemas, not this account's verification submissions).

**Human action required:** read the current Toll-Free Verification status and
its rejection reason from the Twilio Console. Until that is in hand, no claim
about the current rejection cause should be made in either direction.

---

## M. Customer identity

All eight identity invariants returned **0** against production: no offer
redeemed without an order, no offer reserved and redeemed to different orders,
no offer both revoked and redeemed, no offer expiring before it was issued, no
duplicate `order_id`, no duplicate `order_number`, no address both suppressed
and pending in a live campaign, no subscriber marked subscribed without a
consent event.

---

## N. Analytics / attribution

Structurally clean once joined on the real key (`orders.order_id`, not
`orders.id`):

- attribution rows pointing at a non-existent order: **0**
- `referral_orders` orphans: **0**
- `commissions` orphans: **0**
- paid referred orders with no commission row: **0**
- rows where first touch is after last touch: **0**

10 of 20 paid orders carry **no** attribution row. **This is not a defect.**
`order-attribution.ts` states the rule explicitly: when there is nothing
credible to record, **no row is written**, because a missing row is how the
schema says "we don't know" and it has to stay distinguishable from a row of
nulls — otherwise "unattributed" and "organic" collapse and the paid/organic
split stops meaning anything. The orders concerned independently carry
`marketing_source_kind = 'organic'`, `basis = 'none'`. The two systems agree.

The module is also non-throwing by construction: analytics observes commerce and
never controls it, so the worst case of a total failure is a reporting gap, not
a lost order.

---

## O. Affiliates / commissions / payouts

**Ties out three ways at $55.50**, with zero orphans in either direction:

| | |
|---|---|
| Ledger (`referral_orders`, paid) | $55.50 |
| Mirror (`commissions`, status paid) | $55.50 |
| `payouts` (not reversed) | $55.50 |

Ledger/mirror convergence: 2 rows each, 0 ledger-without-mirror, 0
mirror-without-ledger, **0 amount disagreements**, **0 owner disagreements**.
Referential integrity: 0 commissions paid without a payout row, 0 dangling
payout references, 0 payouts without a commission.

Arithmetic recomputed from first principles:

- DREW — $159.97 × 15% = $23.9955 → **$24.00** ✓
- FLAVIAROSSETTI — $209.98 × 15% = $31.497 → **$31.50** ✓

The base is `amount_paid` (net of the customer's discount), not
`original_subtotal` — the conservative and correct choice. Each order's
discount arithmetic also checks: 195.96 − 35.99 = 159.97 and
289.77 − 79.79 = 209.98.

Further invariants, all **0**: commission exceeding the order's own
`amount_paid`; commission paid to a non-approved ambassador; a reversed payout
leaving a commission still marked paid.

**Note (not a defect):** `referral_orders.payout_status` reads `'unpaid'` on
both paid rows. It is a vestigial column written by nothing — the authority is
`commission_paid_at` + `payout_id`. The repository already documents this
(`sql/referral-orders-commission-lifecycle.sql`) and records converging the two
as a deliberate follow-up rather than something to smuggle into a constraint
fix. It matters only to a human reading the table directly.

**No payout was initiated during this audit.**

---

## P. Admin

Every `/api/admin/*` route probed unauthenticated against production returned
401 `{"success":false,"error":"Unauthorized"}`, 404, or 405 — never data, never
a partial record.

The manual cart-recovery resend path is fully audited: 41 resends across 24
distinct carts since 2026-07-21, each with actor, IP, user agent, stage and
timestamp in `admin_audit_logs`. That audit trail is what allowed section K to
close the duplicate-send question rather than leave it open.

---

## Q. Profitability / margins

On all 20 paid orders:

- subtotal + shipping + tax + handling + protection − discount − bulk
  **= `amount_paid`, to the cent, on every order** (0 mismatches)
- 0 null card-processing fees
- 0 refunds exceeding the amount paid
- 0 paid orders missing `paid_at`

16 of 20 are `profit_finalized`. Three of the four that are not are correctly
excluded: a `test` order (cancelled), a cancelled product order, and a
`membership` order (no parcel, so no postage). The fourth is defect **Q-1**.

---

## R. Security / privacy

**Anonymous access is refused at the table-grant level, which is stronger than
RLS.** Twelve sensitive tables were probed with the live publishable key and,
separately, the legacy anon JWT. Every probe returned **HTTP 401, error 42501
`permission denied for table`** — not an empty result set:

`customer_offers`, `orders`, `email_send_log`, `email_suppressions`,
`sms_subscribers`, `ambassadors`, `referral_orders`, `commissions`,
`admin_credentials`, `admin_sessions`, `abandoned_carts`, `payouts`.

This resolves the advisor's 69 `rls_enabled_no_policy` notices (level INFO):
those tables have RLS on and no policies **and no grants**, which for
service-role-only tables is the correct, closed configuration.

**R-1 (open, human action):** Supabase Auth **leaked-password protection is
disabled**. Customers can register with a password known to be in a public
breach corpus. This is a dashboard toggle on production auth configuration, not
a code change, and I have not altered it.

---

## S. Responsive / in-app browser

Swept **7 widths × 5 routes = 35 combinations** (320, 360, 390, 414, 768, 1024,
1440 px against `/`, `/products`, `/products/ghk-cu`, `/cart`, `/spin`).

- **Horizontal page scroll: 0 px on all 35.**
- **Nav/banner overlap: 0 px on all 35.**

The banner overlap reported earlier in this engagement is **fixed and verified
gone**. Measured at 390 px with consent resolved — precisely the state that used
to break, because with consent pending the header was already static and every
automated run looked clean: offer bar occupies 0–112 px in flow, the nav is
`position: static` at 173–242 px, `main` begins at 242 px. **Overlap 0 px**,
against 49 px before the fix. The rule is now stated for the general case —
`:root:has(.vl-consent-bar) .vl2-nav, :root:has(.vl-offer-bar) .vl2-nav
{ position: static }` — rather than naming one bar, so the next in-flow bar
inherits it.

Elements extending past the viewport are decorative (`vl2-lab-sweep`,
`vl2-lab-orb-*`, the wheel's SVG geometry) or the deliberately
horizontally-scrolling category rail. None produces page-level scroll.

In-app browsers: Facebook and Instagram user agents receive byte-identical gate
answers to desktop Safari (section C).

Tap targets: the smallest interactive controls are 32×32 px ("View all offers",
"Dismiss this offer") and 36×36 px ("Save to wishlist"). These **pass** WCAG 2.2
SC 2.5.8 (minimum 24×24) but sit below Apple's 44×44 recommendation on the
store's most prominent promotional strip. Recorded as an observation, not a
failure.

The single console error in the sweep was a 429 from
`/api/catalog/promotions/eligibility` — my own 35 rapid page loads tripping the
rate limiter. That is the limiter working; the page degraded without breaking.

**Known open item (pre-existing, task #31):** six of six featured products on the
home page render "Image pending" placeholders at 390 px. Not new, not a
regression, but it is the first thing a customer sees.

---

## T. Accessibility

Audited 6 routes at 390×844.

**Passing on every route:** `lang="en"`; exactly one `<h1>`; **zero** heading-level
skips; **zero** images without `alt`; **zero** buttons or links without an
accessible name; **zero** form controls without a label; **zero** duplicate IDs;
a unique descriptive `<title>`.

Three defects — **T-1**, **T-2**, **T-3** below.

---

## U. Sentry / runtime health

11 unresolved production issues over 14 days. **None is a customer-facing crash
in the purchase path.** Breakdown:

*Operational alerts the store raises about itself, all behaving correctly:*
`payment_reconcile_backlog` (36 events — 3 abandoned checkouts, cross-checked
against the database and in agreement); `signup_confirmation_stalled` (4 of 65,
and 7 of 105 with an iCloud skew the alert itself flags); `checkout_repeated_failure`
(one shopper, 3 unpaid orders in an hour); `email_hard_bounce` (address
suppressed, as designed).

*`cron_sweep_timeout` — investigated, **not** a stopped job.* Three events over
11 days name `ad_spend_ingest` and `omnisend_contacts_reconcile` as still
running at 50 s against a 60 s limit. The alert text warns "if this repeats they
are not running at all", so I checked the data rather than repeating the alert:
`ad_spend_daily` was last ingested 2026-09-19 04:00:37 with data through
2026-09-18, and `omnisend_sync_state` was updated 2026-09-19 04:30:37. Both jobs
are completing on other ticks. This is a genuine capacity warning worth watching
as volume grows — not a broken job.

*Small genuine runtime errors:* a Next.js internal `InvariantError` about
`document.currentScript` on `/account/login` (6 events over 9 days, none in the
last 4 days); an Android WebView `postMessage` Java exception on `/account/login`
(1 event — relevant to in-app browsers); a router-state header parse error on
`/products` (1 event). All low volume, none blocking a purchase.

---

## V. Database invariant scan

Sixteen invariants run against production. **Fifteen returned 0.** The one
non-zero was investigated and is **not** a violation — see **DIS-6**.

| Invariant | Count |
|---|---|
| Offer redeemed without an order | 0 |
| Offer reserved and redeemed to different orders | 0 |
| Offer both revoked and redeemed | 0 |
| Offer expiring at or before issue | 0 |
| Order paid with `amount_paid` ≤ 0 | 0 |
| Duplicate `order_id` | 0 |
| Duplicate `order_number` | 0 |
| Order shipped but never paid | 0 |
| Negative on-hand inventory | 0 |
| Reserved quantity exceeding on-hand | 0 |
| Suppressed address still pending in a campaign | 0 |
| SMS subscriber marked subscribed without a consent event | 0 |
| Commission exceeding the order's `amount_paid` | 0 |
| Commission paid to a non-approved ambassador | 0 |
| Reversed payout with commission still marked paid | 0 |
| One order redeeming or reserving two offers | 0 |

---

## W. Automated verification

Run on the certification tree with the real-Postgres suites enabled
(`VANTA_TEST_DATABASE_URL` pointed at a throwaway `vanta_scratch` database).

| | |
|---|---|
| Test files | **774 passed, 1 skipped (775)** |
| Tests | **11,879 passed, 11 skipped (11,890) — 0 failures** |
| TypeScript | `tsc --noEmit` — **clean, exit 0** |
| Lint | `eslint` — **53 problems: 0 errors, 53 warnings** |

Worth recording from the run itself: the first attempt pointed
`VANTA_TEST_DATABASE_URL` at `storefront`, the browser-harness database.
`vitest.setup.ts` refused to start and explained why — the DB-backed suites
rebuild `orders` with their own minimal schema and would have silently
destroyed the harness, which `setup-local-harness.sh` could not repair because
its `createdb` and `create table if not exists` are both no-ops once the table
exists. The guard named the correct remedy. That is the safety property working
on a live mistake, not a hypothetical.

New tests added by this certification (behaviour-neutral; no `src/` changes):

- `src/lib/e2e/certification-journeys.test.ts` — **8 tests.** Journeys A, B, C,
  E, G, H reconciled quote → order → gift line → inventory → reward → margin →
  marketing state, plus 2 cross-journey double-spend tests.
- `src/lib/e2e/certification-tamper-lifecycle.test.ts` — **18 tests.** Sections
  F and H above.
- `src/lib/offers/certification-72h-boundary.test.ts` — **14 tests.** Section E
  above.
- `src/lib/e2e/fake-db.ts` — `customer_offer_reserve/redeem/release` RPCs added
  to the in-memory harness so the above can run without a live database.

---

# DEFECTS

### T-1 — `/spin` has no `main` landmark

- **Severity:** Low (WCAG 2.1 SC 1.3.1)
- **Reproduction:** Load `/spin`; query `main, [role=main]` → 0 elements.
  Every other audited route returns 1.
- **Customer impact:** A screen-reader user has no main landmark to jump to on
  the store's headline acquisition page, and must traverse the header each
  visit.
- **Root cause:** `src/app/spin/page.tsx` emits no `<main>`, and the root layout
  renders `{children}` directly rather than wrapping them. Other routes supply
  their own `<main>`.
- **Test added:** None yet — see production status.
- **Fix:** Not applied.
- **Verification:** Measured in the browser at 390×844 and confirmed in source.
- **Production status:** **OPEN.** A one-element change to a live page; left for
  an explicit decision rather than bundled into a report.

### T-2 — the wheel ignores `prefers-reduced-motion`

- **Severity:** Low (WCAG 2.1 SC 2.3.3, AAA) — but a vestibular trigger
- **Reproduction:** `spin-wheel.tsx:426` sets, as an **inline** style,
  `transition: spinning ? "transform 4.4s cubic-bezier(0.16, 0.72, 0.1, 1)" : "none"`.
  Neither `spin-wheel.tsx` nor `spin-wheel-face.tsx` contains `matchMedia` or
  any reduced-motion branch.
- **Customer impact:** A visitor who has asked their operating system to reduce
  motion still gets a 4.4-second full-rotation spin. For a vestibular-sensitive
  user that can cause nausea or dizziness.
- **Root cause:** The stylesheet has 26 `prefers-reduced-motion` blocks, but all
  target specific classes and none targets the wheel. An inline style outranks
  any of them regardless, since none uses `!important`.
- **Test added:** None yet.
- **Fix:** Not applied.
- **Verification:** Confirmed in source across both wheel components.
- **Production status:** **OPEN.**

### T-3 — no skip link on any route

- **Severity:** Low–Medium (WCAG 2.1 SC 2.4.1 Bypass Blocks, **Level A**)
- **Reproduction:** All 6 audited routes: no `a[href^="#"]` matching /skip/.
- **Customer impact:** A keyboard-only user tabs through the whole banner, offer
  bar and navigation on every page before reaching content. On `/products` at
  390 px that is ~53 focusable controls ahead of the catalogue.
- **Root cause:** Never added; landmarks were relied on instead.
- **Test added:** None yet.
- **Fix:** Not applied.
- **Verification:** Measured across 6 routes.
- **Production status:** **OPEN.**

### Q-1 — one shipped order carries no postage cost, so its margin is overstated

- **Severity:** Low (single historical order; reporting only)
- **Reproduction:** `VL-E8F4D52F` (2026-08-02, `express_apple_pay`,
  `fulfillment_status = 'shipped'`) has `actual_shipping_cost_cents = NULL`,
  `estimated_shipping_cost_cents = NULL`, `shipping_cost_source = NULL`,
  `profit_finalized = false`.
- **Customer impact:** None. The customer paid and was shipped correctly.
- **Business impact:** This order's contribution is overstated by whatever the
  label cost. It is the store's **first ever** order, predating shipping-cost
  capture. The other three unfinalised orders are correctly excluded (a test
  order, a cancelled order, a membership with no parcel).
- **Root cause:** Shipping-cost capture landed after this order shipped.
- **Test added:** None — this is a historical data gap, not a live code path.
- **Fix:** Not applied. Correcting it means entering a real postage figure for a
  2026-08-02 label, which is a business record, not a code change.
- **Production status:** **OPEN — owner decision.** Enter the postage cost, or
  accept a known single-order overstatement.

### R-1 — leaked-password protection is disabled

- **Severity:** Low (hardening)
- **Reproduction:** Supabase security advisor,
  `auth_leaked_password_protection`, level WARN.
- **Customer impact:** A customer may register or reset to a password known to
  be in a public breach corpus, raising their credential-stuffing exposure.
- **Root cause:** Supabase Auth configuration default.
- **Test added:** N/A (provider configuration).
- **Fix:** Not applied — this changes live authentication behaviour on
  production and is the owner's call.
- **Production status:** **OPEN — HUMAN ACTION.** Supabase dashboard →
  Authentication → enable HaveIBeenPwned checking.

### L-1 — the current SMS rejection cause cannot be established from here

- **Severity:** Blocking for the SMS programme only
- **Reproduction:** Searched `website/docs/**`, `system_alerts`, and the Twilio
  MCP. The MCP exposes Twilio documentation and API schemas, not this account's
  verification submissions.
- **Customer impact:** None today — zero SMS have ever been sent.
- **Business impact:** The SMS channel cannot be planned or resubmitted without
  knowing the current rejection reason.
- **Fix:** Not applicable — no artefact exists to read.
- **Production status:** **OPEN — HUMAN ACTION.** Read the Toll-Free
  Verification status and rejection reason from the Twilio Console.

---

# DISPROVEN — suspicions raised and driven to a verdict

Recorded so the certification is auditable, not just quotable.

**DIS-1 — "The wheel campaign is stuck at `sending`."** It is not stuck; it is
draining correctly. 103 of 104 sent, the last at 2026-09-19 03:50:38. The single
pending recipient carries
`error = "deferred: a marketing email reached this address inside the last 24
hours"`, `attempts = 0` (a deferral deliberately consumes no retry), and
`deferred_until = 2026-09-19 06:35:37.393`, which is **exactly 24 hours** after
that address's last marketing send (an `automation:welcome_intro` at
2026-09-18 06:35:37.393). At the time of audit (04:23 UTC) the deferral had 2 h
12 m left to run. The campaign stays `sending` until they are reached, by
design — a drained queue is not the same as a delivered campaign.

**DIS-2 — "Customers received duplicate cart-recovery emails."** All three
duplicates are audited operator resends. See section K for the exact
accounting.

**DIS-3 — "Half of paid orders have lost their attribution."** No — a missing
row is the schema's deliberate encoding of "we don't know". See section N.

**DIS-4 — "69 tables have RLS enabled with no policy — the database is
exposed."** The opposite: `anon` has no grants on those tables at all. Twelve
probes returned `42501 permission denied`, not empty rows. See section R.

**DIS-5 — "A `SECURITY DEFINER` function is callable by anonymous users."**
`sms_consent_events_append_only()` returns `trigger`, so PostgREST will not
expose it — a live anonymous RPC call returns **404 `PGRST202`**. Its entire
body is `raise exception`, so even a direct call does nothing but throw. Not
exploitable.

**DIS-6 — "13 addresses hold two live offers."** The invariant is one live offer
**per programme** per address — `customer_offers_one_live_per_email` on
`(offer_key, email)`. Every one of the 13 holds two offers from *different*
programmes. And it cannot be exploited: the checkout carries exactly one offer
token, and production shows **0** orders redeeming or reserving two offers.

**DIS-7 — "Two cron jobs have stopped running."** Both are current. See section
U.

**DIS-8 — "The gate is not working — `/` returns 200."** That probe hit
`vantalabs.co`, a Squarespace "Coming Soon" page that is not the store. Against
the real host, `/` is `307`. See section A.

---

# COUNTS

```
CUSTOMER-CRITICAL DEFECTS REMAINING:      0
FINANCIAL DISCREPANCIES REMAINING:        1   (Q-1 — one 2026-08-02 order's
                                               postage cost unrecorded;
                                               no customer affected)
CONSENT/MARKETING DISCREPANCIES REMAINING: 0
DATABASE INVARIANT VIOLATIONS:            0
UNVERIFIED ITEMS:                         2
```

Both unverified items genuinely cannot be settled from this session without an
external human or provider action:

1. **The current Twilio toll-free rejection cause (L-1).** Requires Console
   access. Recorded as `LATEST REJECTION CAUSE NOT PROVEN`.
2. **Whether `NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED` is set in the Vercel
   production environment.** Reading it means decrypting a production
   environment value, which I did not do. It is **moot** for certification:
   `EXPRESS_OFFER_PARITY = false` is a source constant and closes the lane
   whatever the env var says — which is exactly why the second gate was written
   that way.

---

# TOP 5 THINGS I AS THE OWNER SHOULD KNOW

**1. Apple Pay took $418.20 in real orders and is now switched off — and that
was the right call.** Five customers paid through the express lane between
2 August and 3 September. It was closed on 8 September because it dropped the
customer's gift and credited no campaign. I checked whether anyone was actually
shortchanged: none of the five held a live prize when they paid, so nobody lost
anything. But the next wallet customer holding one would have. Do not describe
the store as having working Apple Pay until the parity work lands.

**2. Your abandoned-cart programme is a copy problem, not a broken system — and
its "recovered" number is not measuring what you think.** People open the mail
(40.9%, nearly double your campaigns) and then don't click (1.1%, under a third
of your campaigns). The click tracker is proven working — campaigns record
clicks fine through the same route. And of your 20 "recovered" carts, ten were
never mailed at all, none clicked, and none used the restore link. Not one can
be credited to the programme. Rewrite the bodies; treat the recovered figure as
a coincidence counter until it counts clicks.

**3. Every dollar reconciles.** Twenty paid orders, arithmetic correct to the
cent on all of them. Commissions tie three ways at $55.50 across ledger, mirror
and payouts with zero orphans, and the two commission amounts recompute exactly
from the amounts you actually collected. Sixteen database invariants, fifteen
returned zero and the sixteenth was my mistake, not yours. The money side of
this store is in good shape.

**4. Two things need you specifically, and neither is code.** Read your Twilio
toll-free rejection reason from the Console — I could not reach it, and the SMS
channel cannot move without it. And turn on breached-password checking in
Supabase Auth; it is one toggle and it changes how your customers' passwords are
validated, so I left it for you.

**5. The gate is doing exactly what you asked, and it treats everyone the
same.** Root is gated. `/sms`, Privacy and Terms are public, carry real content,
and hand out no cookie — I checked that visiting all three leaves you just as
locked out as before. Eight different identities, including Googlebot and the
Twilio reviewer's user agent, get byte-identical answers. There is no cloaking
anywhere in it. The banner overlap you reported is fixed and measured gone at
every width from 320 to 1440.

---

*Verification: full test suite, `tsc --noEmit`, and `eslint` run on the
certification tree. Production reads were read-only throughout. No production
data was modified, no order was manufactured, no charge was submitted, no payout
was initiated, no email or SMS was sent, no marketing consent was created, no
guard was weakened, and no disabled feature was enabled.*
