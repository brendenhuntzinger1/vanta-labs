# Final launch audit — 2026-09-04

**Commit audited:** `25d87f6` (`origin/main` at the start of the session)
**Fixes land in:** `claude/vanta-labs-launch-audit-77bzxl`
**Standard:** evidence-graded. Nothing below is called working unless it was
executed and observed here.

| Tag | Meaning |
|---|---|
| **BROWSER** | Driven in Chromium against the local harness (real Postgres, production schema, production build, payment stub, SMTP sink) |
| **HARNESS** | One of the scripted QA harnesses (`qa:*`, `qa-gift-wiring`) ran here and its output was read |
| **TEST** | Unit / integration suite, including the real-Postgres concurrency proofs |
| **PROD-DATA** | Read-only query against the production Supabase project, or a read-only probe of the live site |
| **CODE** | Read from the tree; not executed |

---

## Verdict

**READY WITH MINOR NON-BLOCKING ISSUES** — once the two production
*configuration* items under "Final launch blockers" are done. Both are
admin-dashboard changes, not code.

Every customer path was driven end to end on the audited commit. Seven real
defects were found in the recently changed offer, promotion, refund and copy
paths; all seven are fixed on the branch, each with a regression test, and the
full suite (7,210 tests, real Postgres) is green on the result.

---

## ✅ VERIFIED WORKING

### The transaction that outranks everything — BROWSER
Fresh browser, 390×844: age gate (two attestations, both buttons disabled until
ticked, storefront behind it `inert`) → guest → catalogue → product page →
add to cart → drawer → referral code → coupon → checkout → order row →
signed `payment.succeeded` → confirmation page → receipt.

    drawer  $69.00 − $6.90 (HARNESS10) + $15.00 shipping = $77.10 (fee disclosed)
    checkout $79.41 (3% card fee)  ==  orders.amount_paid 79.41
    order_items 1 × BPC-157 10mg @69.00  ·  reservation active → finalized
    dose stock 25 → 24, reserved 1 → 0, inventory_committed_at set
    coupons.redemptions_count 0 → 1  ·  order_email_log order_confirmation = sent
    receipt "Order Confirmed - VL-D4C78A0E": same five lines, same total
    confirmation page: same lines, cart emptied, address masked

The age gate did not reappear across `/`, `/products`, `/products/[slug]`,
`/checkout`, `/order-confirmation` in the same tab. It is `sessionStorage`
scoped by design (see `age-gate.tsx`), so a link opened in a *new tab* shows
it again — that is the intended behaviour, not a loop.

### Free GHK-Cu — HARNESS + BROWSER + PROD-DATA
`qa-gift-wiring.mjs` (23/23) on the fixed build, then the paid side by hand:
see the FREE GHK VERDICT section.

### Promotions and coupons — TEST + BROWSER
- Buy X Get Y engine, all six built-ins, mixed carts, exclusions, redemption
  limits, atomic claims, coupon/referral exclusivity: `bxgy-checkout`,
  `bxgy-engine`, `bxgy-redemption-claims` (real Postgres) — green.
- Percent, fixed, free-shipping, private and assigned coupons, welcome offer
  first-order gate: `coupons*` suites — green.
- Browser: a referral below the $100 programme minimum is *saved and inert*
  ("15% off unlocks at $100.00. Add $31.00 to qualify."), applying a coupon
  drops the referral, and the server accepted exactly what the client posted.
- Stacking rules are enforced server-side in `quoteOrder`; the client sends
  only ids, quantities and codes. `expectedTotal` is checked for
  *underpayment only* and the processor is charged the server's figure.

### Email system — HARNESS + BROWSER + PROD-DATA
Observed leaving the app through the SMTP sink, one each, with the right
subject and recipient: account confirmation, sign-in link, password reset,
email-change confirmation, order confirmation (exactly one, replay-safe),
shipping update (on the carrier's first scan, not on label purchase),
delivered, membership renewal receipt, win-back with gift, affiliate campaign
(personalised per affiliate), affiliate test send, admin alert.

- Transactional mail: no `List-Unsubscribe`, no Reply-To, `orders@` From.
- Marketing mail: `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click`,
  Reply-To to a real mailbox, CAN-SPAM postal address in the footer.
- One-click unsubscribe (RFC 8058 POST) → 200, `email_suppressions` row
  written; tampered token → 400.
- Cron sweep runs all 20 jobs under `CRON_SECRET` in one call and reports
  per-job counts; a second sweep sends nothing twice.
- Production: `email.enabled=true`, provider Resend, marketing From on the
  `mail.` subdomain, postal address set, 58 delivery events (delivered and
  transient bounce) already flowing back through the webhook, one complaint
  and one hard bounce correctly suppressed.

### Affiliate system — HARNESS + BROWSER + PROD-DATA
- `qa:roles` 1,085 probes, 0 findings; admin positive control reached 77
  routes. `qa:crossaccount` 15 probes, 0 findings (payout method, referral
  code, orders, addresses, carts all owner-scoped).
- Commission: base is `subtotal − discount_amount` (excludes shipping, tax,
  protection, card fee, and the $0 gift line, which is added after the base
  is fixed). Below the $100 minimum the order is attributed with zero
  commission. Self-referral throws at pricing. `referral_orders.order_id` is
  unique. Refunds reverse or prorate; paid commissions go to manual review.
- Production rate check: default 15% (owner decision 2026-08-27); tier ladder
  starts at 10 monthly sales, so an unlocked 15% ambassador keeps 15% and
  only ever moves up. 18 approved ambassadors, no rate below the emailed one.
- Affiliate campaign, through the admin UI: draft → test send (merged sample)
  → "Send now" → typed-SEND modal → 2 personalised sends (code, link, 15%),
  affiliate-scoped unsubscribe footer, history row `sent`, tracked click →
  302 to the dashboard and one click recorded; tampered click → store, nothing
  recorded; next sweep advanced nothing.

### Inventory and fulfilment — HARNESS + TEST
- Reserve on order, finalise on paid, release on cancel/failure; oversell
  refused at the till; replay of `payment.succeeded` does not double-decrement
  (`qa:purchase`, `inventory-*` suites).
- Shipped email fires on the transition into the carrier network
  (`in_transit` etc.), never on `label_purchased`; delivered only from a
  carrier `DELIVERED` scan; a repeated scan sends nothing (`qa:journey` §13).
- Shipping-cost writeback from in-app labels, dashboard labels (webhook) and
  the repair sweep; voided labels clear the cost.

### Admin — BROWSER
All 27 admin routes render for a signed-in admin with no page errors or failed
API calls (the only console noise is the guest `/api/account/me` 401 probe and
the harness's missing realtime socket). Email automations dropdown, affiliate
composer, and the offer-status API were exercised as real writes.

### Security — HARNESS + CODE + PROD-DATA
- `qa:abuse`: flooding, CSRF (5 cookie-authenticated prefixes all 403 to a
  foreign Origin), XSS reflection, session fixation — pass.
- Production probes: `/api/cron/sweep` 401 without the bearer, both webhooks
  401 (not 503, so their secrets are set), payment webhook 400 without
  signature headers, `/api/health` database ok, `robots.txt` disallows
  `/admin /vault /api /account /checkout /cart`.

### Suites — TEST
| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `eslint` on touched files | 0 errors |
| `vitest` with `VANTA_TEST_DATABASE_URL` | **457 files, 7,210 passed, 3 skipped** |
| `next build` (harness, `NODE_ENV=test`) | clean |

---

## ❌ BROKEN / FIXED

### 1. The free gift ate the Buy X Get Y reward
**Wrong:** `quoteOrder` added the $0 gift line to `lineItems`, then handed the
same array to the promotion engine, which keeps every unit priced ≥ 0 and
rewards the *cheapest*. **Buy 2 Get 1 Free is enabled store-wide in
production**, so a lapsed customer with the gift and three vials would have
lost the free vial the promotion owed them.
**Impact:** customer pays for a unit the store advertised as free; support
tickets on the exact customers the win-back is meant to recover.
**Root cause:** a header comment promised the gift was invisible to Buy X Get
Y; the code contradicted it.
**Change:** the gift line carries `gift: true` and is filtered at the one door
into the engine (`toPromotionCartLines`). Stock, `order_items` and COGS still
see it.
**Verified:** `offer-gift-promotion.test.ts` drives the real `quoteOrder`
(4 × $40 + gift, Buy 3 Get 1 → discount $40, not $0); failed before, passes
after. `qa-gift-wiring` 23/23 on the fixed build.

### 2. Second win-back promised a gift with no token behind it
**Wrong:** the one-live-offer index was `(offer_key, email) where revoked_at
is null`. A customer who redeemed, bought again and lapsed again was
eligible for a new win-back, but the mint hit the index and the sweep sent the
operator's "here is your FREE GHK-Cu" copy with no token. Same outcome after
any send that failed after minting (the token is never stored).
**Impact:** the exact marketing/backend mismatch this audit was asked to
catch — customer clicks, gets nothing at checkout.
**Change:** the index now excludes redeemed rows (migration in
`customer-offers.sql`, idempotent). `issueCustomerOffer` retires an expired
or lost row and reissues; leaves a checkout's live hold alone; also retires a
redeemed row on a database still carrying the old index (production does,
until the migration is applied).
**Verified:** `customer-offers.test.ts` (real Postgres) and
`customer-offers-issue.test.ts` (7 cases).

### 3. Sweep minted before it claimed the send-once slot, and sent without a token
**Wrong:** mint, then claim. A sweep that lost the claim discarded its token
and the winner found the index taken. And an automation carrying a gift still
sent when the mint returned null.
**Change:** claim first, mint second; a gift automation with no token closes
the slot `failed` (outside the send-once index) and retries next sweep, with
the reason in the cron report. The email now renders the gift's real terms
(minimum, deadline, one per customer) from the offer catalogue beneath the
operator's copy, so the message can never promise more than the till honours.
**Verified:** `automation-offer-gate.test.ts` drives the real
`runAutomationSweep`; terms observed in the captured win-back email.

### 4. `/cart` priced an armed gift with its own numbers
**Wrong:** drawer and checkout asked the server; `/cart` did not, so it showed
neither the gift nor the server total.
**Change:** `/cart` uses the same `useOfferQuote` hook and renders the gift
row. **Verified:** BROWSER, 390×844, gift row "GHK-Cu 50mg $0.00" and the
server's total.

### 5. Gift stock check that could never fire
**Wrong:** `offerStock > 0 && offerStock < 1` on an integer count. A
tracked-but-empty gift was added, then `reserve_inventory` refused the whole
order naming a product the shopper never chose.
**Change:** `offerStock <= 0` means no gift this order. **Verified:** two
cases in `offer-gift-promotion.test.ts`.

### 6. Refund webhook could invent stock
**Wrong:** restock was gated on `payment_status` alone. A paid order whose
decrement had failed (alerted, latch null) would be restocked on refund —
units returned that never left. The cancel path already read the latch.
**Change:** the refund path reads `inventory_committed_at`; uncommitted →
release the hold only. **Verified:** `refund-partial-tender.test.ts`, two new
cases.

### 7. Copy that over-promised
- `/partner` and the approval email said commission "on every completed
  order"; production requires $100. Both now state the configured minimum.
- Product page said "Download the report for your selected dose" over the
  *default dose's* certificate when the chosen dose had none. It now says
  which report it is.
**Verified:** `ambassador-approval-email-rate`, `templates-sweep`,
`campaign-template` suites.

---

## ⚠️ NEEDS ATTENTION

### Production automation copy that the backend cannot honour — PROD-DATA
All four automations are **enabled** in production. Two promise things no
code grants:

| Automation | Copy | Backing | Fix (Admin → Email, no code) |
|---|---|---|---|
| `winback_30` | "ENJOY 15% OFF + FREE SHIPPING YOUR NEXT ORDER!" | `offer_key` null, `promo_code` null | set the gift dropdown to **Free shipping + 15% off** |
| `welcome_no_purchase` | "enjoy 15% off your first order" | `promo_code` null; `WELCOME15` exists but is private and not first-order-only; the welcome-offer feature is disabled (`WELCOME10`) | put `WELCOME15` in the promo code field, or enable the welcome offer at 15% |
| `winback_60` | "FREE GHK-Cu" | `offer_key = winback_60_free_ghkcu` ✔ | none; the email now states the $60 minimum automatically |

No customer has yet crossed the 60-day threshold in production (0 dormant
paying customers, 0 offers minted), so nothing wrong has been sent.

### Substantiation claims vs. what is published — CODE + PROD-DATA
Production has **no published COA** (one product has a whitespace `coa_url`,
no `coa_records`). The site still states, catalogue-wide: "99%+ purity" (home
hero, testing section, catalogue rail), "Every batch, third-party tested",
"We publish the proof", "Batch-to-COA mapping", the product-description seed
"ships with a Certificate of Analysis confirming >=99% purity" on 37 SKUs
(PDP body, meta description, JSON-LD), and "Third-Party Tested" on the HGH/HCG
pages whose own COA panel says testing is pending. Your `LEGAL-REVIEW-PACKET`
items 1, 2, 6, 7 remain open. This is a business/legal decision, so it was not
rewritten here; the `trust-claims.ts` gating already under-claims correctly
wherever it is used — the hits above bypass it.

### Operational
- **Commission merge field renders a bare number**: `{{commission_percent}}`
  → "15", so write "{{commission_percent}}%" in affiliate copy. The test send
  shows exactly what goes out, so it is visible before sending.
- **Admin resend of a confirmation** (`/api/admin/orders/[id]`, `/payments`)
  bypasses the send-once guard by design; it is a deliberate button, but it
  is not in `order_email_log`.
- **Stranded `sending` rows** in `email_send_log` for automations have no
  reaper (orders do). A sweep killed mid-send blocks that one reference
  permanently. Low likelihood; documented trade in `automations.ts`.
- **Label purchase has no role check** beyond "is an admin" (`canManageCoa`
  gates a PDF, nothing gates buying postage). Fine for a single-owner admin;
  add a role before handing out staff logins.
- **Legacy flags override stored promotions**: `promotions.buy_3_get_1_enabled`
  and `buy_2_get_1_half_enabled` unconditionally overwrite the matching
  entries in `bxgy_promotions`. The admin UI writes both, so only a manual DB
  edit can skew them.
- **Cache revalidation logs PGRST303 "JWT issued at future"** on one product
  view roughly daily (Vercel runtime errors). Stale catalogue is served; the
  cron jobs already retry on this. Harmless but noisy.
- **`/api/cart/restore` is unthrottled** (UUID capability, items only).
- Public `contact` / `wholesale` / `back-in-stock` forms rely on the rate
  limiter, which fails open by design; the auth forms also have Turnstile.
- `/products/hgh-gh-191` and `/hcg` show the "Third-Party Tested" trust row
  next to a "testing pending" COA panel.

---

## 🔒 EXTERNAL VERIFICATION NEEDED

1. **Apply `website/src/lib/sql/customer-offers.sql` to production** after
   deploying — it narrows `customer_offers_one_live_per_email`. Idempotent;
   the code already copes without it, but the index is the durable guard.
2. **Vercel environment**: the live site behaves as if `CRON_SECRET`,
   `PAYMENT_WEBHOOK_SECRET`, `SHIPPO_WEBHOOK_SECRET`, `EMAIL_WEBHOOK_SECRET`
   are set (each endpoint fails closed with the "configured" code). Confirm
   `UNSUBSCRIBE_SECRET` is set (it falls back to the service-role key) and
   that `TURNSTILE_SECRET_KEY` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` are present
   — the values themselves are not readable from here.
3. **Resend**: `mail.vantalabsresearch.com` is recorded as verified with
   DKIM/SPF/Return-Path; confirm the delivery webhook is pointed at
   `/api/webhooks/email` with the same secret (events are arriving, so it
   is, today).
4. **Pushover**: keys are configured; the daily health check validates the
   user key without sending. The 2026-09-01 `order_push_failed` predates
   that configuration.
5. **Shippo**: a 2026-09-01 `shippo_label_unattributed` critical was resolved
   nine minutes later. Nothing open.
6. **Arcline 3PL** is `enabled` with `auto_transmit` in production
   (`fulfillment.*`). If you self-fulfil through Shippo, confirm this is
   intended; transmitted orders are outside this audit.
7. **Sales tax** still has no nexus states (deferred by you on 2026-08-29).
8. Three `signup_confirmation_stalled` warnings this week: the emails show as
   `sent`, so check those addresses in Resend for delivery.

---

## FINAL LAUNCH BLOCKERS

1. **Set the 30-day win-back's gift** to "Free shipping + 15% off" in Admin →
   Email (or rewrite its copy). Today it promises both and grants neither.
2. **Give the welcome email a code** (`WELCOME15`) or enable the welcome
   offer at 15%. Today it promises 15% and carries no code.

Both are dashboard actions; the code change on this branch should deploy
before the first customer crosses 60 days.

---

## EMAIL MARKETING VERDICT

**Production-ready for the paths that exist, with the two copy fixes above.**

- Free GHK flow: proven end to end, both directions, on the fixed build (see
  below).
- Lifecycle automations: eligibility, dormancy episode keys, send-once (DB
  index), suppression, unsubscribe deletion of the claim, provider failure
  retry, batch cap 50 — tested; the sweep ran here against real rows.
- Campaigns: queue, atomic batch claims, 3 attempts, stale reclaim, terminal
  status counted from the DB, "Nobody received this" surfaced in the UI.
- Affiliate campaigns: driven through the real admin UI here, personalised,
  scoped unsubscribe, history, tracked clicks, no resend.
- Unsubscribe: HMAC token, one-click POST, suppression + preference mirror,
  provider bounces/complaints suppressed and never lifted by a preference
  save.
- Tracking: HMAC-signed click/open for campaigns and automations; the
  cart-recovery `track/*` pair is unsigned (reporting only).
- Scheduling: Vercel cron every 30 minutes, secret-gated, 50 s watchdog with
  a critical alert on stall.

## FREE GHK VERDICT

**How it works today (code, and production config):**

1. `winback_60` is enabled with `offer_key = winback_60_free_ghkcu`,
   `delay_days = 60`. A consented customer whose last paid order is ≥ 60 days
   old is eligible once per dormancy episode.
2. The sweep claims the send-once slot, then mints a 32-byte token whose
   sha256 is stored in `customer_offers` (reward `free_product`, slug
   `ghk-cu`, **minimum $60 pre-gift subtotal**, **30-day expiry**, bound to
   the recipient's address). No token → no send, retried next sweep.
3. The email carries the token on the tracked CTA and now states the terms.
   Clicking sets an httpOnly `vl_offer` cookie and lands on `/products`.
4. Drawer, `/cart` and checkout price through `/api/checkout/quote`: at ≥ $60
   a GHK-Cu line at $0 appears; below it, nothing, and the token stays
   spendable. The gift cannot help the order qualify, cannot enlarge any
   percentage, and (now) cannot touch Buy X Get Y.
5. At order creation the offer is reserved under an advisory lock for the
   order and address; a mismatched address or a second concurrent checkout is
   refused. The gift reserves real stock and books its real COGS.
6. On `payment.succeeded` the offer is redeemed permanently (refund does not
   hand it back), stock is finalised, the receipt shows "GHK-Cu 50mg × 1
   $0.00", and commission (if any) is computed on the paid subtotal, which
   excludes the gift.

**Tested end to end here:** admin dropdown → save → reload → real cron sweep
→ two tokens minted → email link → cookie → $59 order gets nothing, $69 order
gets the vial → paid via signed webhook → `redeemed_at` set by that order →
GHK-Cu stock 500 → 499 → receipt with the $0 line → a second order for the
same customer gets nothing. Cancelled/refunded orders do not re-open
eligibility (real-Postgres tests). Non-recipients cannot obtain it: the token
is a bearer secret, hashed at rest, address-bound at pricing and again under
lock at reservation.

## TOP 5 REMAINING RISKS

1. **Unsubstantiated quality claims** ("99%+ purity", "every batch
   third-party tested", "we publish the proof") on a catalogue with no
   published COA. Regulatory and reputational, not technical.
2. **Automation copy is free text.** The gift terms are now appended
   automatically, but an operator can still type a promise the store does not
   make (today's `winback_30` and welcome copy are examples).
3. **Refund-of-a-gift-order economics**: redemption is permanent by design,
   so a customer who orders, receives the vial and refunds keeps the vial and
   loses the offer — correct, but worth a support macro.
4. **Rate limiter fails open** if `rate_limit_hits` is unreachable, and three
   public forms have no CAPTCHA behind it.
5. **Single-session harness evidence**: everything above was proven in
   Chromium on the local harness. Production was touched read-only; Apple
   Pay express, real card capture and real Shippo label purchase were
   exercised only through their stubs and unit suites.

## FINAL VERDICT

**READY WITH MINOR NON-BLOCKING ISSUES** — deploy this branch, apply the
offer-index migration, and make the two Admin → Email changes before the first
dormant customer reaches day 60.
