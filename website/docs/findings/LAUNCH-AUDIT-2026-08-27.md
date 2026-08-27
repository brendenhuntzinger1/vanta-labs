# Production Launch Audit — 2026-08-27

**Target:** https://www.vantalabsresearch.com
**Deployed commit audited:** `8a3dff4a822e1bc997a6ca0cc78d2b6f5f17508a`
(Vercel `dpl_JAwaMb1eQp1m155C4SK7YJPqZ6M4`, target=production) — verified identical
to the tree reviewed, so every finding below is against what customers are actually served.

**Method:** live Chromium (Playwright) against production, production `admin_control`
read from Supabase, production order rows reconciled by hand, RLS probed with the
storefront's own publishable key, full test/type/lint/build gate on the merged tree.

---

## 0. Environment artefact that must not be mistaken for a defect

Cloud sessions reach the internet through an intercepting proxy. Chromium finds that
proxy on its own, but its TLS 1.3 ClientHello is reset by the interceptor, so **every**
navigation to **every** host fails `net::ERR_CONNECTION_RESET` while `curl` to the same
URL succeeds. That is a transport artefact, not a site outage.

Fixed in this branch: `.playwright-mcp.json` launches the QA browser with
`--ssl-version-max=tls1.2`; `.mcp.json` points the Playwright MCP server at it. No proxy
flag is hard-coded, so the same config works on a laptop. Documented in
`BROWSER-TESTING-RUNBOOK.md`.

---

## 1. Findings

### A1 — Ambassador pages promise 15% base commission; the program default pays 10%
**Severity:** High · **Type:** BUSINESS DECISION (money) — not fixed, owner must choose

| Source | Value |
|---|---|
| `/ambassador` (`ambassador-client.tsx:56,72`) | "15% Base Commission", "You earn 15%" |
| `/partner` (`partner-program-landing.tsx:419`) | "A 15% commission on every completed order" |
| Production `admin_control` `referral.default_commission_percent` | **10** |
| `commission_tier_rules` | Starter 10% · Growth 12.5% · **Elite 15% (50+ monthly sales)** |

15% is the *top* tier, advertised as the *base*. An ambassador approved without a manual
rate override is paid 10% after being told 15%.

Not a payout bug: the approval email (`partner-portal.ts:270-280`) and the partner
dashboard both resolve rate, hold days, personal discount and referral discount from live
config. These two marketing pages are the only hard-coded copies.

Live exposure: `ambassadors` currently holds one **pending** applicant at `10.00`. Recent
approvals were hand-set to 15.00, i.e. the owner has been honouring the page manually; the
default is what fails.

Verified correct on the same pages, so do not "fix" them: 30-day hold, $100 minimum
qualifying order, $100 payout minimum, 20% personal discount, 10% customer discount —
all match production config.

**Options:** (a) set `referral.default_commission_percent = 15` (costs 5pp on every
un-overridden ambassador); (b) render both pages from `getReferralProgramConfig()`, which
will then display 10%. Both change a customer-facing promise, so neither was applied.

---

### A2 — Public Supabase key exposes full COGS and margin structure
**Severity:** High · **Type:** SECURITY / business-confidential data · needs a migration

`products_select_public` grants `SELECT` on **all 50 columns** of `products` to role
`public`. The storefront's publishable key (`sb_publishable_…`, necessarily in every page
load) therefore reads `product_cost_cents`, `min_profit_cents`, `min_selling_price_cents`,
`commission_cost_cents`, `shipping_cost_cents`, `suggested_retail_cents`.

Proven with the key captured from the live page — cost visible on **36/36** products:

| slug | retail | cost | margin |
|---|---|---|---|
| igf-1-lr3 | $119.99 | $35.00 | 70.8% |
| klow | $119.99 | $35.00 | 70.8% |
| glow | $109.99 | $35.00 | 68.2% |
| bpc-157-tb-500 | $104.99 | $33.98 | 67.6% |

The **row** filter is correct — `is_published/is_active/is_enabled/is_archived` are
enforced, and 0 unpublished and 0 archived rows are visible. This is a column problem only.

**Fix (needs approval — schema change):** revoke column-level `SELECT` on the cost columns
from `anon`/`authenticated`, or move the storefront read to a view exposing only
presentation columns. `/api/catalog/products` already omits them, so the app does not
depend on the exposure.

---

### A3 — Unsubstantiated quantified marketing claim
**Severity:** Medium-High · **Type:** LEGAL/COMPLIANCE (FTC §5 substantiation)

`bac-water-upsell.tsx:139` renders, on every peptide product page:

> "Over 70% of customers add BAC Water to complete their order."

Measured against production orders: **57.1%** of paid orders (4/7) and **50.0%** of all
orders (9/18). The number is hard-coded, not derived. At n=7 no percentage claim is
defensible at all. Express quantified claims require prior substantiation.

Not changed — rewriting a marketing claim is the owner's call, and inventing a replacement
number would repeat the defect.

---

### A4 — Live intermittent cron auth failure on the inventory RPC
**Severity:** Medium · **Type:** CODE/INFRA

`system_alerts` holds two unresolved `inventory_rpc_failed` (severity `critical`) entries
from today, 09:01 and 12:00 UTC:

> `expire_stale_reservations failed. Stock is not moving; counts on the storefront are no longer trustworthy.`
> context: `{"rpc":"expire_stale_reservations","detail":"JWT issued at future"}`

`"JWT issued at future"` is clock skew between the caller and Supabase auth, not a logic
error. **Empirically self-healing:** `inventory_reservations` currently holds 14 `released`
and 7 `finalized` rows and **zero** in an active/held state, so no inventory is stuck and
no storefront count is wrong right now. The 30-minute sweep retries and the job is
absence-based, so a failed tick is recovered by the next one.

Real cost is alert fidelity: a self-healing condition pages as `critical`. Worth a bounded
retry before alerting, and a lower severity when the next tick will cover it.

---

### A5 — A 3PL transmit failure never retries
**Severity:** Medium · **Type:** CODE (gap)

`fulfillment_failed`, unresolved since 2026-08-03:

> Order `order-8f2f12b9…` failed to transmit to the 3PL — customer is paid but the order did not reach fulfillment.
> context: `{"error":"3PL API error (422)","provider":"Arcline","statusCode":422}`

That order (VL-49CA32C1) is still `awaiting_fulfillment` with `shippo_sync_status = null`
24 days later. It is a $1.00 test order, so no real customer is waiting — but nothing
retries a failed 3PL transmit and nothing escalates a stale one. Shipping, commissions and
payments all have repair sweeps; fulfillment transmit does not.

---

### A6 — Shippo label that matches no order
**Severity:** Medium · **Type:** OPERATIONS

`shippo_label_unattributed`, unresolved, 2026-08-26: transaction
`d647fd12f7d84a0bba98b89db942c388`, tracking `1Z242F2B0313293233`. Postage is in no order's
profit. Owner action: identify it in Shippo.

---

### A7 — Two labels whose postage can never be recovered automatically
**Severity:** Low-Medium · **Type:** OPERATIONS (working as designed)

VL-8847B157 and VL-8D132452 carry real Shippo transaction IDs with
`postage_cost_cents = NULL`. Both labels were bought (2026-08-20, 2026-08-25) *before* the
writeback landed (2026-08-26), so this is backlog, not a live defect.

The repair sweep behaved correctly: it found them, could not read the postage back from
Shippo, and raised `shipping_cost_manual_entry_required` today at 12:30 rather than
retrying forever or writing a fabricated zero. **Owner action:** enter the two postage
costs by hand in Admin → Orders. Until then, profit on those orders is overstated by the
real label cost.

---

### A8 — 0-byte product image breaks a live gallery thumbnail
**Severity:** Low · **Type:** DATA (code already hardened)

`/products/bacteriostatic-water` requests
`…/1786813685448-bfaf442f….jpg` through `/_next/image` and gets **502 at every width**,
reproduced 3/3. Root cause: the object in Supabase Storage is **0 bytes** (Storage answers
200 with an empty body; the optimizer cannot decode it).

Not a live code defect — the file was uploaded 2026-08-15 and byte-sniffing
(`sniffImageType`, rejects anything under 12 bytes) landed 2026-08-26, so this upload is
now impossible. Scan of all 40 catalog images found **only this one**. Owner action: delete
that gallery image in Admin → Products.

---

### A9 — Live secrets stored in plaintext in `admin_audit_logs`
**Severity:** Low (contained) · **Type:** SECURITY hygiene

`admin_control_current` returns, in plaintext: the Resend API key, the SMTP password, the
Arcline `sk_live_…` fulfillment key, and the Arcline webhook secret. The table is
RLS-protected (anon reads return `[]`, verified) and the admin view redacts, so this is not
remotely exploitable — but the values are recoverable by anyone with database or backup
access, and one of them looks like a reused personal password. Rotate the SMTP credential
and prefer env-only storage for the rest.

---

### A10 — Unauthenticated ambassador application inserts
**Severity:** Low · **Type:** SECURITY (abuse)

Policy `"Anyone can submit ambassador application"` allows `INSERT` into `ambassadors`
from role `public` where `status='pending' AND commission_percent=10.00`. Correctly
constrained on the money columns, but reachable directly against Supabase REST, bypassing
any app-level rate limit or validation: an attacker can bulk-insert applications and squat
referral codes.

---

### A11 — Referral code enumeration
**Severity:** Low · **Type:** SECURITY (abuse)

`validate_referral_code` is `SECURITY DEFINER`, callable unauthenticated with the
publishable key, unrate-limited, and returns `ambassador_name`. Codes are short words
(`SMOKE`, `ZAIN`, `ELOA`, `MIZZY`, `BRUTUS`), so they are guessable; a hit yields a working
discount plus an ambassador's name.

---

### A12 — Sub-24px tap targets on mobile checkout
**Severity:** Low · **Type:** ACCESSIBILITY (WCAG 2.2 AA 2.5.8)

At 390×844, `/checkout` has 8 controls below the 24×24 CSS-px minimum — the consent/option
checkboxes are 18×18, and the "Sign in" and "Terms & Conditions" links are 15–17px tall.
`/ambassador`'s three application inputs are 16px tall.

Everything else on mobile is clean: **no horizontal scroll on any route tested**, one `h1`
per page, no images missing `alt`, no skipped heading levels.

---

### A13 — Generic `<title>` on transactional pages
**Severity:** Low · **Type:** UX/SEO

`/checkout`, `/login`, `/account/login`, `/account/forgot-password`, `/maintenance` and the
membership subscribe pages all render the site-wide default
"Vanta Labs | Premium Research Peptides" instead of a page title.

---

### A14 — `payment_processor.enabled = false` while the store takes cards
**Severity:** Informational (but a live trap) · **Type:** MISLEADING ADMIN SURFACE

Production `admin_control` has `payment_processor.enabled = false`. It gates **nothing** —
`getPaymentProcessorRuntimeConfig()` is consumed only by the admin settings screen. The
real gate is `isCheckoutOpen()` → `CHECKOUT_ENABLED === "true"`, and
`/api/catalog/payment-methods` returns `checkoutOpen: true`, so **the store is live for
real card payments through VeyraGate right now**. An owner reading the admin dashboard
would conclude the opposite. Either wire the flag up or remove it.

---

### A15 — `providerSettlesRefunds()` is dead code
**Severity:** Informational · **Type:** CODE

The function documents itself as the single source of truth for "did money actually move
on a refund" and says *"Callers must NOT tell a customer they have been refunded while this
is false."* It returns `false` and **has no callers**. The invariant it exists to enforce is
unenforced. (No customer has been wrongly told of a refund — `refund_amount` is 0.00 on
every order — but the guard is not doing anything.)

---

## 2. Financial reconciliation — order VL-C98B8AB1

Most recent real paid order, 2026-08-27 00:08:46 UTC. Computed independently from the
component columns and compared with `amount_paid`:

```
  subtotal                          84.98
  discount_amount                  - 0.00
  bulk_discount_amount             - 0.00
  store_credit_redeemed_cents      - 0.00
  ambassador_credit_redeemed_cents - 0.00
  points_redeemed (0 pts)          - 0.00
  shipping_amount                  +15.00   flat_rate=15, subtotal < 200 threshold
  shipping_protection_fee          + 3.40   84.98 x 4%  = 3.3992
  handling_fee                     + 0.00
  tax_amount                       + 0.00   nexus_states empty -> no nexus
  card_processing_fee              + 0.00   fee config disabled
                                   -------
  expected                          103.38
  amount_paid                       103.38   MATCHES
```

Side effects present and consistent: `paid_at` and `paid_side_effects_at` 41s after
creation and 44ms apart; `order_confirmation` logged `sent` via `resend`; no commission
(no referral); `points_earned = 0` (guest, free tier).

Open on this order: `profit_finalized = false` and `actual_shipping_cost_cents = null`
because no label has been bought yet — correct, not a defect.

**Cart maths independently re-derived in the live browser.** 3 × BPC-157 with code `SMOKE`
(15% override): list 119.97, bundle-3 8% → 110.37 shown as subtotal, then −8.40, total with
shipping 116.97. Reconciles as one-discount-wins: 119.97 × 15% = 18.00 beats the bundle's
9.60, and the −8.40 line is the 18.00 − 9.60 remainder on top of the already-bundled
subtotal. Money correct; the −8.40 presentation reads as ~7.6% to a customer told 15%.

---

## 3. What was proven, and what was not

**Proven against production**

- Storefront: every public route returns 200 with no page errors, no hydration errors, no
  failed requests, on desktop *and* iPhone-class mobile. (The recurring `401 /api/account/me`
  is an anonymous session probe — expected, though it logs a console error on every page.)
- Bundle pricing matches `admin_control` exactly (5/8/12/20%) with consistent per-unit
  rounding; free-shipping threshold, flat rate and "away from free shipping" all correct.
- Referral: valid code applies, invalid code is refused with "That referral code is not
  active", discount reconciles to the cent.
- RLS: with the storefront's own publishable key, **every** sensitive table
  (`orders`, `order_items`, `ambassadors`, `commissions`, `payouts`, `admin_credentials`,
  `admin_sessions`, `admin_audit_logs`, `store_credit_ledger`, `points_ledger`,
  `customer_addresses`, `coupons`, `partner_clicks`, `referral_orders`, `email_send_log`,
  `pending_emails`, `inventory_items`) returns empty while service-role shows rows present.
  All 70 tables have RLS enabled. Every money-bearing write policy requires
  `current_auth_role() = 'admin'`, which no client key can present.
- Exactly-once money invariants, against real Postgres (9 tests, `affiliate-concurrency`):
  concurrent double-release pays once; no commission paid twice or left unpaid; both payout
  ledgers stay in step; a refund landing mid-sweep neither resurrects a paid commission nor
  re-queues a reversed one; the paid-side-effects claim is won by exactly one of many
  concurrent deliveries.
- Membership negative-option disclosure: intro terms ("$1.00 today for your 7-day intro
  period. Then the remaining first-month balance, then $24.99/month until canceled"),
  annual non-refundable/non-auto-renewing notice, and "nothing is charged until you
  confirm" all appear before card entry.
- Cold gate on the merged tree: **4761 tests / 303 files pass, 0 fail**; plus 42 DB-backed
  tests that are skipped by default; `tsc --noEmit` clean; ESLint 0 errors (45 unused-var
  warnings, all in tests); production build succeeds with `.next` deleted first.
- Performance (through an intercepting proxy, so absolute times are pessimistic):
  CLS 0 mobile / 0.069–0.083 desktop — comfortably good. LCP 2.54s on the mobile homepage
  is marginal; product pages 0.7–1.8s. ~1.15 MB of decompressed JS per page is the main
  weight.

**Not proven — do not read as passed**

- **No payment was completed.** No production order was created and no card was charged, so
  the VeyraGate hosted form, 3-D Secure, decline handling, double-submit protection,
  refresh-during-payment and the payment webhook were **not** exercised live.
- **The commission pipeline has never run in production**: `commissions` and
  `referral_orders` are both empty. Accrual, hold, auto-approval and payout are proven by
  tests and by DB-backed concurrency suites, never by a real referred order.
- **Admin was not exercised** — no credentials. Every admin surface, the Control Center,
  fulfillment workstation, replacement workflow and profit dashboard are unverified in the
  browser.
- **Signed-in customer flows were not exercised** — account, orders, wishlist, rewards,
  subscriptions, membership purchase, password reset.
- **Inventory edge cases were not exercised live.** All 36 published products are In Stock
  at qty 10, so out-of-stock, low-stock, zero-parent/stocked-variant and disabled-tracking
  paths could not be reached without mutating production inventory.
- **Shippo lifecycle** (PRE_TRANSIT → TRANSIT → DELIVERED, duplicate/late/out-of-order
  webhooks) not exercised end-to-end live.
- **Email deliverability** not verified beyond one `sent` row; inbox placement, SPF/DKIM
  alignment and the shipping/delivery/membership templates were not observed.
- **Express/Apple Pay** not exercised.

---

## 4. Legal / compliance

Issue spotting only — this is not legal advice, and the items below need qualified counsel.

### Requires counsel — material, and the largest single risk

Current authoritative position: FDA issued **50+ warning letters in September 2025** to
companies compounding or manufacturing GLP-1 peptides, and has explicitly targeted
**"research use only" labelling where the advertising indicates human use**, treating those
products as unapproved new drugs and misbranded. The peptides named include semaglutide,
tirzepatide, retatrutide **and BPC-157**.

This catalogue sits inside that description: GLP-1 / GLP-2 / GLP-3 and BPC-157 are all
published products. The RUO disclaimers on the site are present, prominent and well
drafted — but FDA's stated test is intended use inferred from the **totality of the
presentation**, which a disclaimer does not cure. Signals a regulator would read on this
storefront:

- bacteriostatic water (an injection diluent) cross-sold on every peptide page, in 10 mL
  vials, with "Over 70% of customers add BAC Water to complete their order";
- variants presented as **dose** (5mg/10mg/20mg/30mg) under the label "VIAL SIZE";
- a consumer retail apparatus — membership tiers, points, referral codes, "MOST POPULAR",
  bundle-and-save — rather than a B2B laboratory-supply channel;
- a 21+ age gate, which is a consumer-product control, not a lab-supply one.

Counsel should also advise on whether "GLP-1/GLP-2/GLP-3" as product names, without naming
the actual compound, helps or hurts.

### Defect (fixable, not a legal judgement)

- **A3**, the "Over 70%" claim — measured at 50–57% on n=18/n=7.

### Reviewed and reasonable

- Terms, Privacy, Shipping, Return & Reimbursement, Cookie Policy and Research Disclaimer
  all resolve (`/legal/{terms,privacy,shipping,refund,cookies,research-disclaimer}`) and are
  linked from the footer.
- Cookie consent gates analytics and the TikTok/Snapchat/Reddit pixels behind an explicit
  Accept, with Decline offered equally.
- Membership recurring-billing disclosure meets the substance of ROSCA. Note the FTC's
  click-to-cancel rule was **vacated by the Eighth Circuit in July 2025** and the FTC opened
  a fresh ANPRM in March 2026 — so ROSCA and state auto-renewal statutes (California's ARL
  in particular; the store already has California customers) are the operative law today,
  not the vacated rule.
- Ambassador program terms are config-derived in the email and dashboard, with an FTC-style
  disclosure obligation on ambassadors that should be checked against the actual partner
  agreement.

---

## 5. What a $1M operation should have and this does not

Ranked by business value against launch urgency.

1. **Reconciliation against the processor.** Nothing compares VeyraGate settlements to
   `orders.amount_paid`. `reconcileVeyraPendingPayments` recovers lost webhooks but does not
   prove the day's takings. Highest value, because it is the control that catches every
   other money bug.
2. **Chargeback / dispute handling.** No representment workflow, no evidence pack, no
   dispute state on an order. For high-risk peptide MIDs this is existential.
3. **Fraud controls.** No velocity limits, no AVS/CVV policy surface, no blocklist, no
   manual-review queue.
4. **Restore-tested backups.** `security.backup_schedule = "daily"` is a stored string, not
   a verified job. Supabase PITR should be confirmed and a restore actually rehearsed.
5. **Retry for failed 3PL transmits** (A5) and escalation for alerts unresolved past a
   threshold — three criticals have sat unresolved for 1–24 days.
6. **Accounting export.** Tax export exists; a general ledger / Shopify-equivalent payouts
   report for a bookkeeper does not.
7. **Deployment rollback runbook.** Vercel offers instant rollback and several deployments
   are marked rollback candidates, but no documented trigger or owner.
8. **Support workflow.** Contact form and support email exist; no ticketing, SLA or macro
   library.
9. **Dependency/security maintenance** — no Dependabot/renovate or scheduled audit.
10. **2FA on admin.** `security.require_2fa = false`, and `/vault` is linked in the public
    footer. The login is the control, but a second factor on the account that can change
    prices and issue store credit is cheap insurance.

---

## 6. Owner checklist before real traffic

Money and promises first.

1. **Decide the ambassador commission number (A1)** — either raise
   `default_commission_percent` to 15 or change the two pages. Today a newly approved
   ambassador is paid 10% after being promised 15%.
2. **Decide the "Over 70%" claim (A3)** — remove it, soften it to a non-quantified
   statement, or substantiate it once volume supports it.
3. **Get counsel on the RUO/FDA exposure** before scaling paid traffic.
4. **Lock down the cost columns (A2)** — approve the migration.
5. **Enter the two missing postage costs (A7)** in Admin → Orders, and clear the
   unattributed Shippo label (A6).
6. **Reconcile VeyraGate against `orders` for every paid order to date** by hand, once,
   before volume makes it impractical.
7. **Place one real end-to-end test order yourself** — card, confirmation, email in the
   inbox, label, tracking, delivery — and confirm the money lands in the merchant account.
   No automated audit can substitute for this, and it is the single largest unproven area.
8. **Rotate the SMTP password (A9).**
9. **Delete the 0-byte gallery image (A8)** on Bac Water.
10. **Confirm Supabase PITR/backups are on and rehearse one restore.**
11. **Re-check `system_alerts` for unresolved criticals** and set yourself a daily habit of
    doing so — the alerting is good and is already telling the truth.
