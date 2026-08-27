# LIVE SITE INSPECTION — vantalabsresearch.com

**Session:** first walk of the real, merged, deployed store.
**Instrument:** Playwright (Chromium 1194) driven from Node, through this
environment's egress proxy, against `https://www.vantalabsresearch.com`.
**Production DB:** Supabase project `mlpimwgkwuqpsvsrlpqv` — READ-ONLY.
**Harness DB:** Supabase project `snnezhxvssochqpqsjcm` — transactional work only.

**Standing rule for this document:** every claim carries its evidence and its
grade. `NOT VERIFIED` is a real answer and is never upgraded to close a gap.

---

## 0. INSTRUMENT NOTE — how the browser was made to work

The project's Playwright MCP server could not reach the network from this
environment: every navigation returned `net::ERR_CONNECTION_RESET`, for
`example.com` as well as for the store, while `curl` through the same proxy
returned 200. Cause, isolated by bisecting Chromium flags:

| Chromium args | `https://example.com/` |
|---|---|
| default | `ERR_CONNECTION_RESET` |
| `--disable-features=PostQuantumKyber,X25519MLKEM768` | `ERR_CONNECTION_RESET` |
| `--ssl-version-max=tls1.2` | **200 OK** |

The egress proxy terminates TLS and cannot complete a TLS 1.3 handshake with
this Chromium build. Every browser observation in this document was therefore
taken through a directly-driven Playwright browser launched with
`proxy: http://127.0.0.1:35941` and `--ssl-version-max=tls1.2`.

**This is an environment artefact, not a site defect.** Real customers are not
behind this proxy. It is recorded because it constrains what "browser-proven"
means here: TLS 1.3 behaviour of the live site is `NOT VERIFIED` from this
session.

---

## 1. ROUTE INVENTORY

Status vocabulary, per the brief:

- **PROVEN WORKING** — observed behaving correctly on the live site
- **DEFECT FOUND** — observed incorrect behaviour
- **PARTIALLY VERIFIED** — safe part tested live; completing it requires a write
- **NOT VERIFIED** — could not safely or technically test it (reason given)
- **N/A** — not reachable/applicable (reason given)

### 1.1 Customer-facing pages (23 route patterns)

| Route | Status | Note |
|---|---|---|
| `/` | pending | homepage |
| `/products` | pending | catalog |
| `/products/[slug]` | pending | 38 published slugs, enumerated in §1.5 |
| `/cart` | pending | |
| `/cart/restore` | pending | abandoned-cart restore |
| `/checkout` | pending | read-only up to submit |
| `/checkout/pay/[orderId]` | pending | needs a real order — NOT VERIFIED on prod |
| `/pay/[orderId]` | pending | needs a real order — NOT VERIFIED on prod |
| `/pay/mock/[orderId]` | pending | mock lane; harness only |
| `/order-confirmation/[orderId]` | pending | needs a real order |
| `/coa-library` | pending | |
| `/research` | pending | |
| `/research/[slug]` | pending | 4 slugs |
| `/legal/[slug]` | pending | 6 slugs |
| `/membership` | pending | |
| `/membership/[tierSlug]/subscribe` | pending | write at the end |
| `/ambassador` | pending | program landing |
| `/partner` | pending | partner landing |
| `/partner/login` | pending | |
| `/partner/pending` | pending | |
| `/partner/dashboard` | pending | needs partner auth |
| `/contact` | pending | form submit is a WRITE — not submitted on prod |
| `/wholesale` | pending | form submit is a WRITE — not submitted on prod |
| `/login` | pending | |
| `/maintenance` | pending | |
| `/r/[code]` | pending | referral entry — Part 3 |

### 1.2 Account pages (13) — all require auth

`/account`, `/account/login`, `/account/forgot-password`,
`/account/reset-password`, `/account/orders`, `/account/orders/[orderId]`,
`/account/orders/[orderId]/invoice`, `/account/addresses`,
`/account/ambassador`, `/account/notifications`, `/account/rewards`,
`/account/settings`, `/account/subscriptions`, `/account/support`,
`/account/wishlist`

Account creation is a prohibited write on production. Signed-in behaviour is
therefore `NOT VERIFIED` on production unless credentials are supplied.

### 1.3 Admin pages (24)

`/vault`, `/admin`, `/admin/account`, `/admin/ads`, `/admin/audit-log`,
`/admin/cart-recovery`, `/admin/coa`, `/admin/content`, `/admin/coupons`,
`/admin/customers`, `/admin/email`, `/admin/fulfillment`,
`/admin/fulfillment/workstation`, `/admin/inventory`, `/admin/membership`,
`/admin/orders`, `/admin/orders/[orderId]`, `/admin/partners`,
`/admin/partners/[partnerId]`, `/admin/payments`, `/admin/payments/settings`,
`/admin/policies`, `/admin/products`, `/admin/promotions`,
`/admin/reconciliation`, `/admin/revenue`, `/admin/settings`, `/admin/status`,
`/admin/team`

### 1.4 API routes — 143 handlers

Enumerated from `src/app/api/**/route.ts`. Only GET handlers that are provably
read-only were exercised on production; every POST/PATCH/DELETE is a write and
was left alone on production.

### 1.5 Dynamic segment values

**Published product slugs (38):** `5-amino-1mq`, `b12`, `bacteriostatic-water`,
`bpc-157`, `bpc-157-tb-500`, `cagrilintide`, `cerebrolysin`, `cjc-1295-no-dac`,
`cjc-1295-ipamorelin`, `dsip`, `epithalon`, `ghk-cu`, `ghrp-2`, `ghrp-6`,
`glow`, `glp-1`, `glp-2`, `glp-3`, `glutathione`, `hcg`, `hgh-gh-191`,
`igf-1-lr3`, `kisspeptin`, `klow`, `kpv`, `l-carnitine`, `lipo-c`, `mots-c`,
`mt-2-melanotan-ii`, `nad`, `pinealon`, `pt-141`, `selank`, `semax`, `snap-8`,
`ss-31`, `tesamorelin`, `thymosin-alpha-1`

**Archived / unpublished slugs (8)** — must NOT be reachable:
`cjc-1295-ipamorelin-blend`, `glp-1-legacy-…`, `glp-2-legacy-…`,
`glp-3-legacy-…`, `hgh-191aa`, `ipamorelin`, `mt-2`, `nad-plus`

**Legal (6):** `research-disclaimer`, `privacy`, `terms`, `shipping`, `refund`,
`cookies`

**Research (4):** `research-use-only`, `how-to-read-a-coa`,
`storing-and-handling`, `purity-and-third-party-testing`

**Non-page:** `/sitemap.xml`, `/robots.txt`

---

## 2. FINDINGS

### LIVE-001 — the store promises published COAs on five surfaces and has published none

**Severity:** P1 (consumer-protection / advertising exposure in a regulated-adjacent
category). Not P0 only because no money or stock is mis-handled.
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN
**Cross-reference:** NEW. Not in COMPLETE-FIX-REGISTER.md or POST-LAUNCH-BACKLOG.md.
**Owner context:** the owner states COAs are coming soon. That is exactly why this is
filed as a *claims* defect, not a *missing data* defect — the library already handles
the pending state honestly; the marketing copy does not.

**What is actually stored (production, read-only):**

```sql
select count(*) from coa_records;                    -- 0
select count(*) from products
 where is_published and is_enabled
   and (coalesce(coa_url,'')<>'' or coalesce(batch_number,'')<>''
        or coalesce(purity_result,'')<>'' or coalesce(lab_name,'')<>''
        or testing_date is not null);                -- 0 of 36
```

Every one of the 36 live products has an empty `coa_url`, `batch_number`,
`purity_result`, `lab_name` and a null `testing_date`. `coa_records` is empty.

**What `/coa-library` says — and it is the honest surface:**

> ALL 36 · **VERIFIED 0** · **DOCUMENTATION PENDING 36**
> "Batch records are published here as testing is completed."
> "Batch documentation has not been published yet." (×36)

The product page's **COA & QUALITY** tab is equally straight:

> "Vanta Labs-branded, batch-specific COAs are currently being prepared and will be
> added to this library as they become available."

**What the rest of the store tells the same customer:**

| Where | Claim |
|---|---|
| `/` testing section | "Anyone can print a label. **We publish the proof.** … every vial's batch number **maps to its Certificate of Analysis — so you can confirm exactly what you're getting before you order**." |
| `/` trust tile | "Batch-to-COA mapping — Each vial's batch number links to its Certificate of Analysis — **confirm it before you buy**." |
| `/products` header strip | "**PUBLISHED COAS**" |
| every product description (all 36) | "Every batch is independently third-party tested and **ships with a Certificate of Analysis** confirming >=99% purity." |
| `/research/purity-and-third-party-testing` | "Our standard — **We publish COAs per batch so you can verify exactly what you received** — no vague marketing claims, just documentation." |
| `/` FAQ | "Can I review COAs before ordering?" |

**Self-contradiction inside one page.** On `/products/glp-1` the description says
">=99% purity" while the **Specifications** tab on the same page says:

> Purity Result — **Pending** · SKU — **N/A**

**What a real person experiences.** A cautious buyer — the exact buyer this store is
built for — reads "confirm it before you buy", clicks through to the COA Library, and
finds 36 rows of "not published yet". The claim that made them trust the store is the
claim the store cannot honour. That is worse than saying nothing.

**Source locations for the copy:** `website/src/app/page.tsx:93`,
`website/src/app/page.tsx:280-283`, `website/src/lib/articles.ts:90`, plus the
per-product `description` column in the database (36 rows).

---

### LIVE-002 — "Over 70% of customers add BAC Water to complete their order"

**Severity:** P2 · fabricated social proof
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN
**Cross-reference:** NEW.
**Where:** every product page, under FREQUENTLY PURCHASED TOGETHER. Observed on
`/products/glp-1` and `/products/dsip`, desktop 1440×900.

Production has **6 paid orders in total** (`orders` grouped by `payment_status`, as
recorded in POST-LAUNCH-BACKLOG.md and re-checked this session). There is no
population from which "over 70% of customers" could be measured. The number is
hard-coded copy, not a computed statistic.

This sits directly beside a genuine, checkable claim ("third-party batch tested"),
which is what makes it costly: one invented number devalues the honest ones.

---

### LIVE-003 — the Specifications tab has three rows, two of which are empty

**Severity:** P2 · missing content on the surface a technical buyer opens first
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN
**Cross-reference:** NEW.
**Where:** `/products/[slug]` → SPECIFICATIONS tab. Observed on `/products/glp-1`.

Rendered content, in full:

```
Purity Result | Pending
Category      | GLP Research
SKU           | N/A
```

Confirmed against the database: `molecular_formula`, `cas_number`,
`peptide_sequence`, `molecular_weight` and `storage_recommendation` are **empty
strings for all 36 published products**. A researcher comparing suppliers gets no
CAS number, no sequence, no molecular weight, and no storage guidance — while
`/research/storing-and-handling` tells them storage matters.

The tab is not broken; it has nothing to render. Either populate it or drop the tab.

---

### LIVE-004 — free-shipping badges appear on quantity tiers with no stated threshold

**Severity:** P2 · CONFUSING
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.
**Where:** `/products/[slug]` quantity selector, desktop and mobile.

`/products/glp-1` ($44.99 each):

```
1 Vial $44.99 | 2 Vials $85.48 −5% | 3 Vials $124.17 −8%
5 Vials $197.95 −12%            | 10 Vials $359.90 −20%  Free ship
```

`/products/dsip` ($59.99 each):

```
5 Vials $263.95 −12%  Free ship  | 10 Vials $479.90 −20%  Free ship
```

The badge appears at 5 vials on DSIP and only at 10 on GLP-1, so it is order-value
driven — but **the threshold is never stated anywhere on the page**. The customer can
see that more spending unlocks free shipping without being told what the number is,
which is the one piece of information that would make them add another vial.

**Not a maths error.** The bulk tiers themselves reconcile exactly, using per-unit
floor rounding: `floor(4499 × 0.80) × 10 = 35 990` = $359.90, `floor(4499 × 0.88) ×
5 = 197.95`, `floor(4499 × 0.92) × 3 = 124.17`, `floor(4499 × 0.95) × 2 = 85.48`.
Verified on both products.

---

### LIVE-005 — two near-identically named cross-sell modules on one page

**Severity:** P3 · polish
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.
**Where:** `/products/[slug]`, desktop.

"FREQUENTLY PURCHASED TOGETHER" (BAC Water, +$14.99, **ADD**) sits ~200px above
"FREQUENTLY BOUGHT TOGETHER" (this product + BAC Water, **ADD BOTH TO CART**). Same
upsell, same product, two names, two buttons with different semantics. A customer who
uses the first and then sees the second cannot tell whether they already added it.

---

### LIVE-006 — "Save to wishlist" fails silently for signed-out visitors

**Severity:** P2 · SILENT FAILURE + MISSING STATE
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.
**Where:** heart button on every product card — `/`, `/products`, related-products
rails. Observed at 1440×900, signed out.

Clicking the heart issues `POST /api/account/wishlist` → **401**. The page shows no
toast, no sign-in prompt, no change to the heart. The `role=alert` region contains
only the page title. The customer clicks, nothing happens, and they have no way to
know why.

Correct behaviour is to open the sign-in flow (or persist locally). Doing nothing
teaches the visitor the site is broken.

---

### LIVE-007 — the header search field is a dead, `aria-hidden` element

**Severity:** P3 · dead code behind a working control
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.

The magnifier in the header **does work** — it navigates to `/products`, where a real
"Search compounds" field filters correctly (`bpc` → 2 products, matching the database).
That part is PROVEN WORKING.

Behind it sits an expanding search input that never expands:

```html
<div class="flex items-center overflow-hidden transition-[width] duration-300 w-0">
  <input type="search" aria-label="Search" placeholder="Search"
         tabindex="-1" aria-hidden="true" ...>
```

The wrapper stays `w-0` before and after the click (input measured at 8×37 px both
times). It is permanently `aria-hidden="true"` and `tabindex="-1"`, so it is invisible
to assistive tech and unreachable by keyboard — yet it is a live form control that
submits to `/products?search=…` when driven programmatically. Either wire the
expansion up or delete the element; leaving it is how a future author concludes
in-header search exists.

**Also:** at 390px there is no search control in the header at all (`hidden lg:flex`).
Whether mobile search is reachable from the menu is tested separately.

---

### LIVE-008 — `/api/account/me` returns 401 to every signed-out visitor, on every page

**Severity:** P3 · console noise
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.

Every page load by an anonymous visitor produces a red console error:

```
HTTP_401: GET /api/account/me
Failed to load resource: the server responded with a status of 401
```

Functionally harmless — the UI handles the signed-out state correctly — but it means
the store's console is never clean, so a real error has nowhere to stand out. A 200
with `{user: null}` costs nothing and removes the noise permanently.

---

### LIVE-009 — heavy prefetch churn: 142 aborted `_rsc` requests on one catalog view

**Severity:** P3 · performance polish, mobile data
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.

Scrolling `/products` once at 1440×900 produced **142 failed requests**, all of them
Next.js App Router prefetches (`?_rsc=…`) cancelled with `net::ERR_ABORTED` — every
product page, every legal page, `/vault`, `/ambassador`, the cart, several of them
twice under two different `_rsc` tokens.

Aborted prefetch is normal in small numbers. 142 on one screen is a lot of radio time
for a store whose traffic is mostly mobile. Worth capping prefetch on the card grid.

## 2b. THE AFFILIATE SYSTEM

**Method note.** `/r/[code]` is NOT a read-only route: it `INSERT`s into
`partner_clicks` **and** `referrals` on every hit (`src/app/r/[code]/route.ts`).
It was therefore never requested against production in this session. The
customer-visible half of the chain was exercised instead by placing the code in
the browser's own cart state — which is exactly the state `/r/[code]` leaves
behind — and reading the result off the screen. That path calls the read-only
Postgres RPC `validate_referral_code` from the browser and writes nothing.

### Program configuration, as actually stored

`GET /api/catalog/promotions` (live) and the `referral` section of
`admin_audit_logs`:

```
referralDiscountPercent : 10     (program default customer discount)
referralMinimumOrder    : 100    ($100 merchandise subtotal, bundle-adjusted)
personal_discount_percent: 20    (ambassador's own order)
default_commission_percent: 10
enabled: true   commissions_paused: false
freeShippingThreshold: 200 (US) / 400 (CA)   flat: $15 (US) / $25 (CA)
```

Note the program's **customer** discount percent has never been written in the
control centre — there is no `referral/discount_percent` audit row — so it is
running on the code default of 10.

### AFF-01 — the rate shown is the ambassador's own rate, and it is right

**Status:** CONFIRMED CORRECT · BROWSER-PROVEN + DATABASE-PROVEN

Seven codes, cart screen vs `ambassadors` row:

| Code | Ambassador | `customer_discount_percent` | Cart shows | Verdict |
|---|---|---|---|---|
| `SMOKE` | Xavier Martinez | 15.00 | "15% customer discount" | ✅ |
| `MIZZY` | Jaeley Reynolds | 15.00 | "15% customer discount" | ✅ |
| `BRUTUS` | Paul huntzinger | **NULL** | "10% customer discount" | ✅ inherits program default |
| `ZAIN` | zain | **NULL** (commission 20) | "10% customer discount" | ✅ inherits; commission not leaked |
| `ELOA` | Eloa wolf | **NULL** | "10% customer discount" | ✅ |
| `ELIJAH-AB78AE` | Elijah Lagrama, `info_requested` | 10.00 | **no discount, code rejected** | ✅ required behaviour |
| `NOTACODE` | — | — | no discount | ✅ |

`validate_referral_code` run directly against production returns
`{"valid": false}` for the `info_requested` ambassador and for the unknown code,
and the real rate (or `null` to inherit) for the five approved ones. **The
explicit-rate vs NULL-inherits-default distinction is correct on both sides.**

### AFF-02 — the discount arithmetic is correct at every quantity

**Status:** CONFIRMED CORRECT · BROWSER-PROVEN

`SMOKE` (15%) on BPC-157 5mg @ $39.99, read off the live cart:

| Qty | Full | Bundle subtotal | Bundle saved | 15% of full | Shown as | Check |
|---|---|---|---|---|---|---|
| 3 | 119.97 | 110.37 | 9.60 | 18.00 | −$8.40 | 9.60+8.40 = 18.00 ✅ |
| 5 | 199.95 | 175.95 | 24.00 | 29.99 | −$5.99 | 24.00+5.99 = 29.99 ✅ |
| 6 | 239.94 | 211.14 | 28.80 | 35.99 | −$7.19 | 28.80+7.19 = 35.99 ✅ |

The store gives **one** discount per order and the referral must beat the bundle
pricing already inside the subtotal, so the line shows only the *incremental*
saving. Every figure reconciles to exactly 15% of the full subtotal. Free
shipping flipped to $0.00 at qty 6 ($211.14 ≥ $200) exactly as configured.

Checkout carries it through: `/checkout` showed "Xavier Martinez · 15% off",
"Remove code", and disabled the coupon box with "A referral code is applied.
Remove it to use a coupon instead." Coupon/referral exclusivity is stated
plainly. Zero console errors, zero failed requests on `/checkout`.

### AFF-03 — **DEFECT** — a referral link below $100 promises a discount it will never give

**Severity:** P1 · SILENT FAILURE / INCONSISTENT (two code paths, two answers)
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.
**Where:** `/cart`, any viewport, any approved code, merchandise subtotal < $100.

Same basket ($39.99), same code (`SMOKE`), two ways in:

| Entry path | What the cart says |
|---|---|
| **Code restored** from cart state (i.e. arriving from a real ambassador link) | "Ambassador Xavier Martinez • **15% customer discount**" — and the totals are Subtotal $39.99, Shipping $15.00, **Final total $54.99. No discount line. No reduction. No explanation.** |
| **Code typed** into the cart's REFERRAL CODE box | "**Referral codes require a minimum order of $100.00. Add more items to use one.**" — correct, clear, actionable. |

Root cause, located in `src/components/cart-context.tsx`:

- `applyReferralCode` (line 1078) checks `subtotal < referralMinimumOrder` **before**
  validating, and sets a precise error.
- the restore effect (line ~556) that rehydrates a persisted/linked code performs
  **no minimum check at all** — it validates the code and sets
  `referralDetails`, which is what renders the "• 15% customer discount" line.
- `promoDiscount` (line 724) *then* correctly returns `null` below the minimum,
  so the money is right and the message is wrong.

**Why this matters more than it looks.** This is the *only* path a real referred
customer takes. Nobody types an ambassador's code — they click her link. So the
broken message is the one every referred customer sees, and the correct message
is the one almost nobody sees. The ambassador is told her audience gets 15% off;
her audience is shown "15% customer discount" and charged full price with no
reason given. The likeliest outcome is an abandoned cart and an ambassador who
believes her link is broken.

**Server behaviour is correct and consistent** — `quote-order.ts:569` throws
below the same minimum, comparing the same bundle-adjusted subtotal
(`quote-order.ts:476` vs `cart-context.tsx:595`). There is no client/server
divergence in the *money*. The defect is entirely in what the customer is told.

### AFF-04 — **DEFECT** — "15% customer discount" next to a line reading −7.6%

**Severity:** P2 · CONFUSING (trust)
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.
**Where:** `/cart` with any referral code and any multi-unit basket.

At qty 3 the cart simultaneously displays:

```
Subtotal                 $110.37
Ambassador code SMOKE     -$8.40      <- 7.6% of the subtotal shown
...
Ambassador Xavier Martinez • 15% customer discount
```

Both are true (see AFF-02) — $9.60 of the 15% is already inside the $110.37
through bundle pricing — but **nothing on the screen says so.** There is no
"Bundle pricing −$9.60" line; the bundle saving is invisible. The customer sees
a 15% promise and a 7.6% deduction and has no way to reconcile them.

This is the finding most likely to generate ambassador support tickets ("your
code only gave me 7% off"). Showing the bundle saving as its own line, or
labelling the referral line "additional saving", resolves it without changing a
single number.

### AFF-05 — no affiliate money has ever moved through production

**Status:** DATABASE-PROVEN · not a defect, a coverage statement

```
referral_orders                      0
commissions                          0
orders where referral_code is not null  0
orders (all)                        15
```

Every repair the audit made to accrual, hold state, payout and reversal is
therefore **NOT VERIFIED in production**. The first real ambassador sale will be
the first execution of that path on this database. Anything proven about it is
proven on the harness only.

### AFF-06 — **DEFECT** — the partner program advertises earnings that do not exist

**Severity:** P1 · fabricated financial claims used to recruit
**Status:** CONFIRMED (data) · DATABASE-PROVEN — page rendering verified separately below
**Cross-reference:** NEW.

`partner_program_stats` holds:

```
total_commissions_paid_base    22,638.00
average_partner_earnings_base   1,918.00
top_partner_payout_base         4,829.00
average_approval_time_hours_base   24.00
```

against `commissions` = **0 rows** and `referral_orders` = **0 rows**. Not one
cent of commission has ever been accrued, let alone paid. These are seeded
baseline numbers presented as programme performance to people deciding whether
to promote the brand. Earnings claims to prospective affiliates are exactly the
category regulators treat most harshly.

### AFF-07 — `ambassadors` and `partners` are two base tables holding the same rows

**Severity:** P2 · structural risk (two sources of truth)
**Status:** CONFIRMED · DATABASE-PROVEN
**Cross-reference:** NEW.

```sql
select table_name, table_type from information_schema.tables
 where table_schema='public' and table_name in ('partners','ambassadors');
-- ambassadors | BASE TABLE
-- partners    | BASE TABLE
```

Neither is a view. Both currently hold the **same 8 rows with the same UUIDs and
identical `commission_percent`, `customer_discount_percent`, `status` and
`referral_code` values** — so today they agree. Nothing in the schema forces
them to keep agreeing. Different modules read different ones
(`referral-client.ts` falls back to `ambassadors`; `partner-portal.ts` reads
`partner`), so a write that lands on one and not the other produces a store
where the cart and the portal quote different rates for the same person.

They agree today. That is a fact about the current data, not a guarantee.

### AFF-08 — consent on a referral click: fixed, and honestly flagged

**Status:** CONFIRMED FIXED (code) · NOT VERIFIED live (route writes; not called)
**Cross-reference:** matches the fix described in COMPLETE-FIX-REGISTER; re-read here.

`src/app/r/[code]/route.ts` now gates `utm_source/medium/campaign`, `referrer`,
`user_agent` and `ip_address` behind `hasAnalyticsConsent(request)`, with
`unset` counting as no. The attribution itself — ambassador id, code, landing
path — is still written either way, and the code says so out loud rather than
hiding it:

> "whether THAT is essential storage is the owner's call, not a decision to make
> silently inside a bug fix. Flagged, not changed."

**That remains an open owner decision**, and the Cookie Policy wording should be
checked against it (§ content review). The 30-day `vl_referral_code` cookie is
set on every referral click regardless of consent.

---

## 2c. CHECKOUT

### LIVE-010 — **DEFECT** — the marketing opt-in is pre-ticked

**Severity:** P1 · consent / CASL exposure (the store ships to Canada)
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.
**Where:** `/checkout`, step 04.

```html
<input type="checkbox" class="… accent-[color:var(--accent-gold)]" checked="">
```
→ "Email me exclusive offers, coupons & restock alerts. Optional — unsubscribe anytime."

`checked` is in the **markup** (`defaultChecked: true`), `:checked` matches, and
an element screenshot shows the gold ticked control (the unticked shipping-
protection box beside it renders empty). Stable at 300 ms, 1.5 s and 4 s.

Checkout offers **United States and Canada**. Canada's CASL requires express
consent; a pre-ticked box is the textbook example of what does not qualify.

**It also contradicts this store's own stated design.** The age gate deliberately
requires four separate, individually unticked attestations, and the code
explains why:

> "a single combined tick is one click that stands for four different
> representations, which is exactly the assent a regulator would question"

The same reasoning applies to a pre-ticked marketing consent one page later.

### LIVE-011 — the two legal confirmations are also pre-ticked

**Severity:** P2 · consent quality
**Status:** CONFIRMED · BROWSER-PROVEN
**Where:** `/checkout` step 04, "Required confirmations · 2 of 2".

"Research & Compliance" (21+, research-use-only, terms) and "Return &
Reimbursement Policy" both ship `checked` in the markup, with the instruction
"Untick either one to withhold it."

Opt-out consent for an age and research-use attestation is weaker than the
opt-in the age gate already collected, and weaker than this codebase argues for
elsewhere. Lower severity than LIVE-010 only because the equivalent attestation
*was* actively made at the gate.

### LIVE-012 — **DEFECT** — no visible focus indicator on any checkout input

**Severity:** P2 · accessibility (WCAG 2.2 SC 2.4.11/2.4.13), on the purchase flow
**Status:** CONFIRMED · BROWSER-PROVEN
**Where:** `/checkout`, every text input and select.

Focused email field, computed style:

```
outline-style : none
outline-width : 0px
box-shadow    : … rgba(255, 255, 255, 0.05) 0px 0px 0px 4px
border-color  : rgba(255, 255, 255, 0.4)
```

The only focus affordance is a 4px ring at **5% white opacity** over a near-black
surface — far below the 3:1 contrast a focus indicator requires, and invisible in
the screenshots. Buttons and links are fine (`outline: solid 2px`); it is the 15
form fields that are not. A keyboard or switch user filling in this form cannot
see where they are.

### LIVE-013 — the cart quotes shipping protection at "+$0.00", checkout at "+$4.41"

**Severity:** P3 · CONFUSING
**Status:** CONFIRMED · BROWSER-PROVEN

`/cart`: "Shipping Protection (Recommended) · optional … **+$0.00**"
`/checkout`: "Shipping protection · Protect against loss, theft, or damage … **+$4.41**"

Same unticked add-on, same basket. The cart is showing its *current contribution
to the total* where the customer reads it as *the price*, so an optional paid
extra is advertised as free one screen before it costs $4.41.

### LIVE-014 — the coupon box suggests a code that will be refused

**Severity:** P3 · polish
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN

Checkout placeholders are `VANTA10` (referral) and `SAVE10` (coupon).
`VANTA10` does not exist in `coupons`; `SAVE10` exists with `active = false`.
A customer who reads the placeholder as a hint and types `SAVE10` is told the
code is not valid.

### LIVE-015 — 335 "active" coupons that all expired

**Severity:** P2 · admin truth
**Status:** CONFIRMED · DATABASE-PROVEN

```
source=cart_recovery  active=true  n=335  email_bound=335  expired=335
source=null           active=false n=30 (percent) + 2 (fixed)
```

Every one of the 335 cart-recovery coupons has `active = true` **and** an
`ends_at` in the past. Redemption is presumably safe (validation checks dates),
but any count of "active coupons" — admin dashboard included — reports 335 live
promotions when zero are redeemable. Verified against the admin screen in §ADMIN.

### Checked and NOT a defect (recorded so it is not re-raised)

- **Canada province field.** Selecting Canada removes the US state `<select>` and
  renders a free-text **"Province / region"** input carrying
  `autocomplete="shipping address-level1"`. An earlier read of the select count
  suggested the field vanished; it does not. The only note is asymmetry: US is a
  constrained dropdown, Canada is free text, so a mistyped province reaches the
  label unvalidated. P3 at most.
- **Canada shipping.** "Secure Canada shipping — free at $400.00+, otherwise
  $25.00" matches `northAmericaFee: 25` / `northAmericaFreeShippingThreshold: 400`.
- **Form semantics.** 17 fields, **0 unlabelled**, correct `autocomplete` tokens
  throughout (`shipping address-line1`, `billing postal-code`, …), `inputmode`
  on email/tel/ZIP. This is better than most stores.
- **Bulk tier maths.** Reconciles exactly at every tier via per-unit floor
  rounding — see LIVE-004.
- **Self-referral.** `quote-order.ts:577` blocks it by both email and account id.

## 2d. CONTENT, CLAIMS AND CONSISTENCY

### LIVE-016 — **DEFECT** — the partner page contradicts itself on the commission rate

**Severity:** P1 · INCORRECT / recruiting on wrong numbers
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN
**Cross-reference:** NEW.

On `/partner`, in the same scroll:

| Where on the page | Rate stated |
|---|---|
| WHAT YOU GET → Benefits | "A **15% commission** on every completed order placed with your code." |
| Earnings Calculator input | "Commission percentage **10%**" |
| Earnings Calculator footnote | "Commission rate used: **10%**" |

The projected figure the calculator advertises ($702/mo, $8,424/yr) is therefore
computed at 10% while the bullet above it promises 15%.

Reality: `default_commission_percent = 10`; live ambassadors are set to 10, 10,
15, 15, 15, 15 and 20. So neither number is "the" rate — but the page presents
both as fact, twice, without qualification.

`/ambassador` states "**15% Base Commission**" and "You earn **15%**", agreeing
with the benefits bullet and disagreeing with the calculator.

### LIVE-017 — **DEFECT** — two landing pages for one programme, telling different stories

**Severity:** P2 · INCONSISTENT
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.

`/partner` ("VANTA LABS PARTNER PROGRAM") and `/ambassador` ("VANTA AMBASSADOR
NETWORK") are both linked from the footer and both describe the same programme.
They disagree on:

| | `/partner` | `/ambassador` |
|---|---|---|
| Approval time | "Average approval time: **11.0 hours**" | "Most qualified applications are reviewed in **under 24 hours**" |
| Commission | 15% (bullet) / 10% (calculator) | 15% |
| Payout minimum | not mentioned | "**$100 payout minimum**" |
| Minimum order | not mentioned | "**$100 minimum order**" ✅ matches config |
| Hold period | "payable 14 days after an order completes" ✅ | "**14-day hold**" ✅ |
| Apply flow | "Sign in or create your free account, then come back here to apply" | name + email form → "CONTINUE IN PARTNER PORTAL" |

A prospective ambassador can land on either and come away with a different
understanding of what they earn and how fast they are approved.

Also: `/ambassador` says "Commission is calculated on the order subtotal after
the customer's **10%** discount". The code does compute commission on the
post-discount subtotal (`payment-webhook.ts:721`) ✅ — but the discount is 15%
for four of the seven approved ambassadors, so the stated percentage is wrong
for the majority of them.

### LIVE-018 — **DEFECT** — the legal pages render raw Markdown

**Severity:** P2 · VISUAL / UNPOLISHED, on the pages that carry the promises
**Status:** CONFIRMED · BROWSER-PROVEN
**Where:** `/legal/shipping`, `/legal/refund` (both read via `innerText`, so the
characters below are literally on the page).

`/legal/shipping`:
```
**What it covers:** with protection added, if your order is lost in transit…
**What it does not cover:** orders shipped to an incorrect or incomplete address…
**How to file a claim:** contact support@… within 14 days…
```

`/legal/refund`:
```
- have its return requested within **14 days of delivery** - be unused and
unopened - retain its **original factory cap/seal, fully intact** - be in its
original condition
```

Asterisks are shown as asterisks, and the bullet list has collapsed into a
single run-on line with stray hyphens. These are the two pages a cautious buyer
reads before paying. They currently look like an unrendered draft.

### LIVE-019 — the shipping policy is silent where the store is specific, and describes shipping it does not offer

**Severity:** P2 · INCONSISTENT
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN

`/legal/shipping` says:

> "Rates — Domestic shipping is free over the current threshold; otherwise, a
> flat fee applies. **International shipping has its own threshold and flat
> fee.** Exact shipping is shown at checkout before you pay."

Two problems:

1. **No numbers.** Every other surface states them — cart "Free shipping at
   $200.00", checkout "free at $200.00+, otherwise $15.00", Canada "$400.00+,
   otherwise $25.00". The policy page, the one a careful buyer opens, states
   none of them.
2. **International shipping is described but not sold.** The checkout country
   selector offers **United States and Canada only**; the shipping block says
   "Ships to the United States and Canada." Config does carry
   `internationalFee: 60 / internationalFreeShippingThreshold: 600`, but no
   customer can select an international destination.

Third: the policy's Processing clause says only "Orders are prepared after
payment is verified". **Same-day dispatch is promised on the homepage, the
catalog strip, every product page, the cart, the checkout and the footer** —
"Order by 2PM ET, ships same day (Mon–Fri)" — and the shipping policy commits to
nothing. The one page a customer would cite makes no dispatch promise at all.

### LIVE-020 — COA claims, complete list of surfaces

Extending LIVE-001, the claim appears on **seven** customer-facing surfaces:

1. `/` testing section — "We publish the proof… maps to its Certificate of Analysis"
2. `/` trust tile — "Batch-to-COA mapping… confirm it before you buy"
3. `/products` header strip — "PUBLISHED COAS"
4. every product `description` (36 rows) — "ships with a Certificate of Analysis"
5. `/research/purity-and-third-party-testing` — "We publish COAs per batch"
6. **`/wholesale`** — "The same certificates of analysis **we publish**, on every wholesale lot."
7. **`/account/login`** side panel — "Third-party tested — **COA on every batch**"

### LIVE-021 — a configured $1 introductory membership is never shown

**Severity:** P2 · DEAD FEATURE / lost conversion
**Status:** CONFIRMED · BROWSER-PROVEN + API-PROVEN

`GET /api/catalog/promotions` returns, for all three tiers:

```json
"introPriceCents": 100, "introDurationDays": 7, "introOfferEnabled": true
```

A $1-for-7-days trial is enabled on Pro, Elite and Black. **The `/membership`
page never mentions it.** It shows "$39.99 → $24.99/mo", "$59.99 → $39.99/mo",
"$149.99 → $89.99/mo" and three "JOIN" buttons. The single strongest conversion
lever the membership has is configured and invisible.

(The three struck-through prices are compare-at values; the live prices $24.99 /
$39.99 / $89.99 match `monthlyPriceCents` 2499 / 3999 / 8999 exactly.)

### LIVE-022 — `/login` is a second, orphaned partner sign-in page

**Severity:** P2 · DEAD FEATURE / two auth entry points
**Status:** CONFIRMED · BROWSER-PROVEN

- `/partner/login` **redirects to `/account/login`** — the customer sign-in
  ("Sign in to Vanta Labs", with account/membership/rewards copy).
- `/login` still serves a **separate** page headed "PARTNER PORTAL — Secure
  Login · Use your approved partner credentials to access real-time commissions
  and referral performance", with its own email/password form.

Two different sign-in pages for the same people, one of them no longer linked
from the flow that replaced it. Either it works (and is a second, unmaintained
auth surface) or it does not (and is a dead end an ambassador may have
bookmarked). **Whether `/login` actually authenticates is NOT VERIFIED** — no
credentials, and submitting is a write.

### LIVE-023 — `/vault` took 22.8 seconds to become interactive

**Severity:** P2 · SLOW, on the owner's front door
**Status:** CONFIRMED (single observation) · BROWSER-PROVEN

`/vault` — `domcontentloaded` → `networkidle` measured at **22,830 ms**, against
2.7–5.4 s for every other page in the same sweep. It fires
`GET /api/admin/auth/session` → 401 for an anonymous visitor.

One observation only, so this may be a cold start on a rarely-hit route rather
than a steady-state cost. Recorded as **CONFIRMED slow once, cause NOT
DIAGNOSED**. It is the page the owner opens to start work.

---

## 2e. MOBILE (390×844 and 320×568)

### LIVE-024 — adding to the cart shows a third BAC-water ask, with no way to check out

**Severity:** P2 · FRICTION
**Status:** CONFIRMED · BROWSER-PROVEN

Tapping ADD TO CART on `/products/glp-1` at 390×844 opens a modal:

> LABORATORY SUPPLIES — **Need bacteriostatic water?** … [BAC Water 10 mL +$14.99] [No thanks, continue shopping]

The item *is* added (verified: cart 0 → 1, badge "Open cart with 1 items"), but
the modal offers only "add water" or "continue shopping" — **no View Cart, no
Checkout**. The customer who just decided to buy is handed an upsell and then
sent back to browsing.

It is also the **third** ask for the same product on that page, after
"FREQUENTLY PURCHASED TOGETHER" and "FREQUENTLY BOUGHT TOGETHER" (LIVE-005).

The modal appears for the in-page button but **not** for the sticky bottom-bar
button on the same page — two controls, two behaviours.

### LIVE-025 — touch targets below the 24px minimum on the purchase flow

**Severity:** P2 · accessibility (WCAG 2.2 SC 2.5.8), mobile
**Status:** CONFIRMED · BROWSER-PROVEN · measured at 390×844

| Control | Size | Where |
|---|---|---|
| consent / shipping-protection checkboxes | **18 × 18** | `/checkout` (×3) |
| "Sign in" link | **37 × 17** | `/checkout` rewards row |
| quantity − / + | 32 × 32 | `/checkout` summary |
| "Remove" | 67 × 32 | `/checkout` summary |
| footer links | ~24 high | every page |
| cookie Decline / Accept | 70 × 32 / 68 × 32 | every page |

The 18×18 checkboxes and the 17px-tall "Sign in" fail the 24×24 AA minimum
outright; the 32px controls pass AA but sit well under the 44×44 both Apple and
Google recommend. These are on the checkout, being tapped by a thumb.

### LIVE-026 — an accidental double-tap silently buys two

**Severity:** P3 · FRICTION
**Status:** CONFIRMED · BROWSER-PROVEN

A double click on ADD TO CART (40 ms apart) took the cart from 2 units to 4.
There is no debounce and no "already in your cart" feedback, so a fat-fingered
tap on a phone adds a second $44.99 vial with only the header badge to show for
it.

### Checked on mobile and NOT a defect (recorded so it is not re-raised)

- **The age gate is reachable at 390×844 and at 320×568.** The dialog is 1210 px
  tall against an 844 px viewport and `documentElement.scrollHeight` equals the
  viewport (`body { overflow: hidden }`), which looks unreachable — but the gate's
  own container is `fixed inset-0 overflow-y: auto` with `scrollHeight 1298`.
  A plain wheel/flick scroll moved "Continue as guest" from y=939 to y=518
  (`reachable: true`), all four boxes ticked, and the gate was passed. Same at
  320×568 (button ends at y=558 in a 568 px viewport — only 10 px of margin, but
  reachable). **This is exactly the false P0 the earlier audit was burned by; it
  is not one.**
- **Nothing intercepts ADD TO CART.** The fixed `.vl2-lab-sweep` decorative layer
  that overlaps the button is `pointer-events: none; z-index: -1`, and
  `elementFromPoint` returns the button itself at 10 %, 25 %, 50 %, 75 % and 90 %
  of its width.
- **No horizontal scroll** at 390 or 320 on home, catalog, PDP, cart or checkout.
- **Mobile navigation** is a fixed bottom bar (`.vl-bottom-bar`, 390×82), not a
  hamburger — there is no hamburger and none is needed. On a product page the bar
  carries the product name, price and its own ADD TO CART.
- **Dose switching updates the price correctly**: GLP-1 5mg $44.99 → 20mg $114.99
  → 30mg $144.99, matching `product_doses.price_cents` 4499 / 11499 / 14499.
- **The cart drawer, empty state and quantity controls** all render and behave.

---

## 2f. TRUTH CHECKS THAT PASSED

Recorded with evidence because "we checked and it was right" is a result.

### PRODUCT TRUTH — PASS · DATABASE-PROVEN + BROWSER-PROVEN

- `/products` renders exactly **36** cards; the database has 36 published *and*
  enabled products. The two `is_published = true, is_enabled = false` rows
  (`cerebrolysin`, `pinealon`) are correctly absent.
- Direct URLs for every unpublished or archived slug return **404**:
  `cerebrolysin`, `pinealon`, `hgh-191aa`, `mt-2`, `nad-plus`,
  `cjc-1295-ipamorelin-blend`, and a nonsense slug.
- **The parent-zero / dose-stocked invariant holds.** `dsip` and `ss-31` carry
  `products.stock_status = 'Out of Stock'` with `inventory_quantity = 0`, and a
  dose holding 19 units. Both render **In Stock**, both show an enabled ADD TO
  CART on the catalog and the product page, and `/api/catalog/products` reports
  `stockStatus: "In Stock"` for both. **No stocked dose is hidden by a zero
  parent.**
- 31 of the 36 have `parent_inv = 0` with stocked doses; all 36 are purchasable.

### PRICE TRUTH — PASS · DATABASE-PROVEN

Every price on every surface was reconciled to `product_doses.price_cents`:

- **48 dose prices** in `/api/catalog/products` match the database exactly
  (spot-checked in full: GLP-1 10mg $64.99 = 6499, GLP-2 30mg $144.99 = 14499,
  GLP-3 30mg $169.99 = 16999, NAD 1000mg $94.99 = 9499, HGH 36iu $84.99 = 8499,
  Thymosin $60.00 = 6000).
- Catalog card price = default dose price = parent price for all 36.
- Product page dose switching produces the stored dose price.
- **Cart and checkout agree exactly**, with nothing entered:
  | Qty | Cart | Checkout |
  |---|---|---|
  | 1 | Subtotal $39.99 · Shipping $15.00 · Final total **$54.99** | Subtotal $39.99 · Shipping $15.00 |
  | 3 | Subtotal $110.37 · Shipping $15.00 · Final total **$125.37** | Subtotal $110.37 · Shipping $15.00 |
- Bulk tiers reconcile by per-unit floor rounding at 2 / 3 / 5 / 10 units.

**The browser is not the authority** — `quote-order.ts` recomputes everything
server-side; the client mirrors it. That is code-read, not runtime-proven, since
no order was placed.

### PERSISTENCE / RETURNING CUSTOMER — PASS · BROWSER-PROVEN

| Step | Cart | Badge |
|---|---|---|
| add | 1 unit | "Open cart with 1 items" |
| refresh | 1 | 1 |
| navigate to `/cart` | 1 | 1 |
| back ×2 | 1 | 1 |
| forward | 1 | 1 |
| **second tab** | 1 | 1 — and the age gate is *not* re-shown |
| add in tab 2 | 2 | **tab 1 updated to 2 with no reload** (live cross-tab sync) |
| fresh browser session | gate shown again ✅ (sessionStorage, by design) |

Prices were still correct after every one of those transitions.

### AUTHORIZATION TRUTH — PASS · BROWSER/HTTP-PROVEN

35 unauthenticated GETs. Every privileged surface refuses:

```
/api/admin/{metrics,inventory,products,partners,coupons,settings,control,team,
            customers/export,orders/export,cart-recovery,shipping/origin,
            fulfillment/queues,membership/customers,
            ambassadors/payouts,ambassadors/settings}   401
/api/admin/auth/session                                 401 {"authenticated":false}
/api/partner/{me,summary}                               401
/api/account/{me,wishlist}                              401
/api/cron/sweep                                         401
/api/ads/tracking-health                                401 "admin session required"
/admin, /admin/orders, /admin/revenue, /admin/settings  307 (redirect away)
```

Public by design and correct: `/api/health`, `/api/catalog/products`,
`/api/coupons/featured`, `/api/storefront/offers`, `/vault` (the login door).

**No cost data leaks.** `/api/catalog/products` exposes no `product_cost_cents`,
`min_profit_*`, `suggested_retail_cents`, supplier or margin field — checked key
by key on product and dose objects.

`/api/admin/orders`, `/api/admin/account` and `/api/account/addresses` return
**405** rather than 401 to an unauthenticated GET, i.e. method routing runs
before authorization. No data is returned; P3 note only.

### LIVE-027 — inventory is capped at 10 in the public API, so low stock can never be shown

**Severity:** P3 · MISSING STATE (and a trap for future work)
**Status:** CONFIRMED · DATABASE-PROVEN

`/api/catalog/products` reports `availableQuantity: 10` for **every** product and
**every** dose. Real stock ranges from 15 to 146. The cap is sensible (it stops
competitors reading inventory), but it has two consequences:

- **No scarcity signal is possible from this API.** `selank` holds 15 units
  against a `low_stock_threshold` of 5; nothing on the site says so. There is no
  "only N left", no low-stock badge and no out-of-stock state anywhere on the
  storefront today.
- Any future low-stock UI driven from this endpoint will be **wrong by
  construction**, because 10 is a constant, not a measurement.

### Crawl surfaces — PASS

`robots.txt` correctly disallows `/admin`, `/vault`, `/api`, `/account`,
`/checkout`, `/cart`, `/pay`, `/maintenance`, `/r/` and points at the sitemap.
`sitemap.xml` (200, 7.4 KB) lists 1 home + 37 products (`/products` + 36 pages) +
5 research + 6 legal + membership, ambassador, partner, wholesale, contact,
coa-library. No unpublished slug appears.

`/r/NOTACODE-XYZ` returns 307 to `/products` with no attribution and **no write**
(`resolveReferralCode` returns null before the insert) — the one referral URL it
was safe to request.

## 2g. CATALOG CONTROLS

### Working — PROVEN WORKING · BROWSER-PROVEN

- **All 9 categories filter correctly** and the rendered card count matches the
  page's own "N products" every time: Blends 2, Cognitive 3, GLP 4, Growth
  Hormone 7, Longevity 5, Metabolic 4, Repair & Recovery 5, Solvents 1,
  Specialty 5 — **summing to exactly 36**.
- **Price: Low to High** verified ascending; **Price: High to Low** verified
  descending; **Name: A to Z** verified against a locale sort of the rendered
  names.
- **Search** works and is not just a name match — `glp` → 4 (including
  Cagrilintide, by category), `water` → 1, `BPC` → 2, `zzzz` → 0 with a proper
  empty state: "No products matched your filters".
- **Best Sellers** toggle → 3 cards, matching the three ★ BEST SELLER badges.
- **CLEAR ALL** resets to 36.
- **Deep link** `/products?category=Growth%20Hormone` applies the category, and
  browser back/forward across that real navigation restores it.

### LIVE-028 — **DEFECT** — filters and sort are lost the moment a customer opens a product

**Severity:** P2 · FRICTION, high frequency, direct conversion cost
**Status:** CONFIRMED · BROWSER-PROVEN
**Cross-reference:** NEW.

Reproduction, desktop 1440×900:

```
1. /products → category "Growth Hormone", sort "Price: High to Low"
   state: 7 cards, selects = [Growth Hormone, Price: High to Low], url = /products
2. click the first card                    → /products/igf-1-lr3
3. press Back                              → /products
   state: 36 cards, selects = [All, Best Sellers First]
```

**Every filter and the sort are discarded.** The customer who narrowed 36
products down to 7, opened one, and hit Back is returned to the top of the
unfiltered catalog.

Root cause is visible in the state dump: **filter state never enters the URL** —
`url` stays `/products` through all nine category changes and all five sort
changes. With nothing in the URL there is no history entry to come back to, and
no filtered view can be shared or bookmarked either.

### LIVE-029 — **DEFECT** — "Purity: Highest" sorts by something that is not purity

**Severity:** P2 · DEAD FEATURE presented as data
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN

`products.purity_result` is an **empty string for all 36 published products**
(§LIVE-001). There is no purity value to rank by.

Selecting "Purity: Highest" nevertheless reorders the grid, into an order that
is neither the A-to-Z order nor the Best Sellers order:

```
A-Z     : 5-Amino-1MQ | B12 | Bac Water | BPC-157 | BPC-157 + TB-500 | Cagrilintide
Purity  : 5-Amino-1MQ | BPC-157 | Cagrilintide | CJC-1295 no DAC | DSIP | GHK-Cu
Best    : GLP-1 | MOTS-C | Bac Water | 5-Amino-1MQ | BPC-157 | Cagrilintide
```

A customer who sorts by purity is shown an arbitrary order and will reasonably
read the first item as the purest product Vanta sells. Presenting an unranked
list as a purity ranking is worse than not offering the option.

### LIVE-030 — the "In Stock" toggle can never do anything

**Severity:** P3 · DEAD CONTROL
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN

Toggle ON → 36 cards. Toggle OFF → 36 cards. Every catalog product reports
`stockStatus: "In Stock"` (§LIVE-027), so there is nothing for the filter to
remove. Harmless today; it becomes meaningful only once something can go out of
stock, which — given the parent-zero architecture and the capped
`availableQuantity` — nothing currently can.

---

## 2h. TAX, TOTALS AND FORM VALIDATION AT CHECKOUT

Method: the checkout form was **filled completely and never submitted**.
`/checkout` only issues `GET /api/catalog/payment-methods` and
`GET /api/account/me` on load; `create-session` (the write) fires on submit only.

### LIVE-031 — sales tax is switched off in every state, and the cart implies otherwise

**Severity:** P1 for the owner to *decide on* (not a code defect) · business/compliance
**Status:** CONFIRMED · BROWSER-PROVEN + DATABASE-PROVEN

`GET /api/catalog/promotions` → `"salesTax": {"nexusStates": [], "rateOverrides": {}}`.

Filled the same $110.37 basket with a Texas, then a California, then a New York
shipping address:

| State | Subtotal | Shipping | Tax line | TOTAL |
|---|---|---|---|---|
| TX 78701 | $110.37 | $15.00 | **none** | $125.37 |
| CA 90001 | $110.37 | $15.00 | **none** | $125.37 |
| NY 10001 | $110.37 | $15.00 | **none** | $125.37 |

**No sales tax is charged anywhere.** Meanwhile the cart shows a line reading

> Sales tax — *Calculated at checkout*

which is never calculated and simply disappears at checkout. And the database
shows tax **was** collected historically: `$9.69` across four earlier orders
(`orders.tax_amount`), so this was configured once and is now off.

Whether to collect is the owner's call and depends on real nexus. What is not a
judgement call: **the store promises a calculation it never performs**, and the
owner should know tax collection is currently disabled everywhere before
volume arrives.

### LIVE-032 — **DEFECT** — the pay button is never disabled, however invalid the form

**Severity:** P2 · MISSING STATE (submit behaviour itself NOT VERIFIED)
**Status:** CONFIRMED for the button state · BROWSER-PROVEN

`Continue to secure payment`, measured after each step:

| Form state | Button |
|---|---|
| completely empty | **enabled** |
| email = `not-an-email`, then blurred | **enabled**, and *no inline error appeared* |
| fully filled, valid | enabled |
| **a required legal confirmation UNTICKED** ("Confirm to continue — 1 of 2") | **enabled** |
| cart empty | disabled ✅ (the one case handled) |

So the page states "Both are required to place a research order", displays
"1 of 2", and still offers an enabled primary button. An invalid email produces
no feedback at all until the customer commits.

**What happens on click is NOT VERIFIED and must not be guessed.** Clicking
`Continue to secure payment` calls `POST /api/checkout/create-session`, which
writes an order row, so it was not clicked on production. The three
possibilities — client-side guard, server rejection, or an order created from an
invalid form — are materially different, and **this is the single highest-value
thing to exercise on the harness.**

### Verified correct here

- **Shipping protection** — $4.41 on a $110.37 subtotal is exactly 4.0 %
  (`110.37 × 0.04 = 4.4148`), and the total moved $125.37 → **$129.78** when
  ticked and back when unticked.
- **Country switch** — US $15 / free at $200; Canada $25 / free at $400, both
  matching config.
- **Quantity controls** in the checkout summary adjust the line and the totals.

---

## 2i. ADMIN — reconciled against the database without signing in

**No admin credentials were available to this session**, and `/vault` requires a
username, a password *and* a 6-digit passcode. **Every admin screen is therefore
`NOT VERIFIED` as an interface.** What could be done instead: call the same
Postgres rollup functions the admin screens read, and reconcile them against raw
SQL. That is DATABASE-PROVEN, and it answers the "do the numbers agree" question
without a login.

### ADM-01 — the three revenue surfaces agree with each other

**Status:** PASS · DATABASE-PROVEN

```
admin_revenue_summary(today)   -> total_paid_orders 6, total_paid_revenue 232.38
admin_ops_summary(today,month) -> live_sales_month 232.38, live_sales_today 0
admin_revenue_by_method()      -> card: 6 orders, revenue 232.38
```

Raw check: the six `payment_status = 'paid'` rows sum to **exactly $232.38** of
`amount_paid`. The audit's warning about *"five surfaces using three different
definitions of revenue"* does **not** reproduce at the rollup layer — these
three agree.

### ADM-02 — but "revenue" is gross receipts, and includes a cancelled order

**Severity:** P2 · ADMIN TRUTH (harmless at 6 orders, material at 100/day)
**Status:** CONFIRMED · DATABASE-PROVEN
**Cross-reference:** NEW (related to, but distinct from, POST-LAUNCH-BACKLOG PLB-02).

The $232.38 the owner sees decomposes as:

| Component | Amount |
|---|---|
| merchandise subtotal | $145.26 |
| shipping charged | $75.00 |
| **sales tax collected** (owed to states, not revenue) | **$9.69** |
| shipping protection fees | $2.43 |
| **= reported "revenue"** | **$232.38** |

and separately:

| | |
|---|---|
| **paid orders whose `fulfillment_status` is `cancelled`** | **$45.47** |
| membership orders counted in product revenue | $1.00 |

So of a headline "$232.38 revenue": 4 % is a tax liability, 32 % is shipping
recovery, and **$45.47 belongs to an order that was cancelled after payment**.
At six orders this is noise. At a hundred orders a day it is a materially wrong
number on the screen the owner runs the business from.

**Correction made during this session.** An earlier draft of this finding
attributed the $2.43 to a card processing surcharge. That was wrong: every paid
production order carries `card_processing_fee = 0.00` and
`card_processing_fee_percent = 0.00` — **the store charges no card surcharge**.
The $2.43 is `shipping_protection_fee` (0.08 + 0.15 + 2.20). Recorded because
the mistake is the kind this document exists to catch.

**Order-level accounting reconciles exactly.** For all six paid orders:
`subtotal − discount + shipping + tax + card fee + handling + protection =
amount_paid`, to the cent, with no residual.

### ADM-03 — 75 referral clicks, zero referral orders

**Status:** DATABASE-PROVEN · operational finding, not a defect claim

```
partner_clicks            75      referrals (click events)   75
ambassadors with clicks    2      MIZZY 51  ·  FLAVIAROSSETTI 24
referral_orders            0      commissions                0
orders with referral_code  0
```

Two ambassadors have sent **75 real visitors** to the store and **not one has
converted**. This does not prove a cause, and small numbers can be nothing. It
is recorded because it sits directly beside **AFF-03**: the only path those 75
visitors took is the one that shows "Ambassador X • 15% customer discount" and
then charges full price whenever the basket is under $100 — which, at a $39.99
median product price, is most first baskets.

**Worth the owner's attention before spending more on ambassadors.**

### ADM-04 — `admin_bulk_savings_stats()` returns no rows

**Status:** DATABASE-PROVEN · not currently wrong

The function the bulk-savings admin surface reads returns **zero rows**. The
audit's "bulk-savings figure inflated nearly 3×" therefore **cannot be
reproduced today** — there is no figure. Recorded so the absence is not mistaken
for a passing check: it is untestable at present, not proven correct.

### ADM-05 — `admin_partner_rollups()` returns only ambassadors who have clicks

**Severity:** P3 · SUSPECTED (page not seen)
**Status:** DATABASE-PROVEN for the function; admin rendering NOT VERIFIED

The function returns **2 rows** for the 2 ambassadors with click history. The
other **6 approved ambassadors are absent entirely**. If the partners screen
renders this rollup directly, the owner sees 2 of 8 ambassadors and has no way
to find the other six. If the screen joins it onto the full `partners` list,
this is fine. **Cannot be determined without signing in.**

### Other admin facts worth the owner's eye

- `points_outstanding()` = **3,000 points** of outstanding customer liability.
- `orders` = 15 total: 6 paid, 5 canceled, 4 pending_payment.
- One paid order sits at `fulfillment_status = 'shipped'`, two at
  `label_purchased`, one at `awaiting_fulfillment`, one at `cancelled`.
- **335 `active = true` coupons that have all expired** (LIVE-015) will inflate
  any "active promotions" count the dashboard shows.

## 2j. THE TRANSACTIONAL CHAIN — HARNESS

**What this is.** A real Next.js production build of the current `main`, served
against a local Postgres carrying the schema from `scripts/setup-local-harness.sh`,
with the payment processor replaced by a stub that only mints a session id and a
signed `payment.succeeded` event POSTed to the **real** `/api/webhooks/payment`.
No production data was touched. Grade: **HARNESS-PROVEN**. RLS and signed-in
flows are not exercised and stay NOT VERIFIED.

**Two things had to be worked around, and neither weakened a control:**

1. `harness-server.mjs` no longer works. It sets `NODE_ENV = "test"` at runtime
   so mock payments are reachable, but Next 16 / Turbopack **inlines**
   `process.env.NODE_ENV` at build time and the minifier then deletes the branch
   entirely. The shipped bundle reads:
   ```js
   if ("mock" === t || "test" === t) throw Error("PAYMENT_PROVIDER=mock/test is forbidden in production…")
   ```
   **This is good news for production** — the mock-payment lockout is not a
   runtime check that a stray env var could satisfy, it is an unconditional
   throw compiled into the bundle. It also means the audit's own harness tooling
   cannot run mock payments against this build. `NODE_ENV=test npx next build`
   does not help; Next forces production. The lockout was **not** weakened.
2. Payment was therefore driven the way `scripts/harness-pay-order.mjs` already
   does it: sign the same `payment.succeeded` event and POST it to the real
   webhook route — the identical code path a live processor callback takes.

### HARN-01 — the full affiliate chain is CORRECT, end to end

**Status:** HARNESS-PROVEN

One qualifying referred order, `EXPLICIT15` (15 %), 3 × $39.99:

| Stage | Value |
|---|---|
| cart | Subtotal $110.37 · **Ambassador code EXPLICIT15 −$8.40** · total $116.97 |
| order row | `paid` · `awaiting_fulfillment` · `paid_at` set · `paid_side_effects_at` set |
| | subtotal 110.37 · discount **8.40** · amount_paid 120.48 |
| `referral_orders` | pct **15.00** · commission **15.30** · original_subtotal 110.37 · customer_discount **8.40** · customer_discount_percent **15.00** · payment_status **pending** · payout_status **unpaid** · ineligible_reason **none** |
| `commissions` | pct 15.00 · amount **15.30** · status **pending** |
| inventory | BPC5 **19 → 16**, reserved returns to **0** |

**The commission arithmetic is right and matches the published rule.**
`/ambassador` says "Commission is calculated on the order subtotal after the
customer's discount". Commissionable = 110.37 − 8.40 = 101.97; 15 % = 15.2955 →
**$15.30**. Exactly what was written.

**One consistent financial event:** the $8.40 the customer saved appears on the
order *and* in `referral_orders.customer_discount`; the $15.30 appears in both
money tables; the hold state is `pending`/`unpaid`. Nothing disagrees.

### HARN-02 — a replayed webhook changes nothing

**Status:** HARNESS-PROVEN

The same signed `payment.succeeded` event was POSTed a second time:

```
orders with this id  : 1
referral_orders rows : 1
commissions rows     : 1
inventory BPC5       : 13 on hand, 0 reserved   (unchanged)
```

**No duplicate order, no duplicate commission, no second inventory decrement.**

### HARN-03 — inventory cannot be oversold, and a failed payment consumes nothing

**Status:** HARNESS-PROVEN

| Test | Result |
|---|---|
| **Two buyers race for the final unit** (1 in stock, both submit simultaneously) | one 200, one **400 "1ct just sold out. Please adjust your cart and try again."** — stock ends 1 on hand / 1 reserved. **No oversell.** |
| **Order 5 of a 1-unit product** | **400 "We can't ship that many of Last One right now. Please lower the quantity and try again."** |
| **Processor unreachable mid-checkout** | order written then set `canceled`, reservation `released`, **inventory unchanged**, customer told "No charge was made and no order was placed" |
| **Negative inventory** | `count(*) where inventory_quantity < 0` → **0** |
| **Reserved exceeding on-hand** | `count(*) where reserved_quantity > inventory_quantity` → **0** |

### HARN-04 — the affiliate edge cases behave

**Status:** HARNESS-PROVEN

| Edge | Result |
|---|---|
| **Below the $100 minimum** with a valid code | create-session **refuses**: "This referral code requires a minimum merchandise subtotal of $100.00. Add more items or remove the referral code to continue." **No order created.** |
| **Unapproved ambassador** (`info_requested`) | order created and paid with **discount 0.00** and `referral_code` **stripped to null**; **zero** `referral_orders` rows. No discount, no commission, no attribution. |
| Invalid code | `validate_referral_code` → `{"valid": false}` (production, §AFF-01) |
| Self-referral | blocked by email and by account id (`quote-order.ts:577`) — code-read, not run |

### AFF-03 ESCALATED — the sub-$100 referral path is a **checkout blocker**, not just a missing discount

**Severity: P0 for the ambassador channel** (was P1)
**Status:** CONFIRMED · BROWSER-PROVEN (production) + HARNESS-PROVEN (the server side)

The harness supplies the half production could not safely show. Putting the two
together, here is what happens to a customer who clicks an ambassador's link and
puts one $39.99 vial in the basket:

1. `/cart` displays **"Ambassador Xavier Martinez • 15% customer discount"**.
2. The order summary applies **no discount** and gives no reason.
3. The client still sends `referralCode` to `create-session` — confirmed in the
   captured request payload.
4. The server **throws**: *"This referral code requires a minimum merchandise
   subtotal of $100.00. Add more items or remove the referral code to
   continue."* — HTTP 400, **no order created**.

So the customer is promised a discount, shown none, and then **stopped at the pay
button** by a minimum they were never told about. They can recover — checkout
offers "Remove code" — but only if they work out that the ambassador's own code
is what is blocking them.

**This is the only path a referred customer takes.** Nobody types a code; they
click a link. And beside it sits the production fact from ADM-03: **75 referral
clicks, 0 referral orders.** At a $39.99–$49.99 median product price, most first
baskets are under $100.

The fix is not in the money — the money is right at every step. It is that the
minimum is invisible until the last possible moment, and that the restore path
announces a discount the basket does not qualify for.

### AFF-09 — **DEFECT** — a failed commission accrual is invisible to everyone

**Severity:** P1 · SILENT FAILURE (FAILURE TRUTH)
**Status:** CONFIRMED · HARNESS-PROVEN (demonstrated) + code-read
**Cross-reference:** NEW. Distinct from the constraint defect the audit fixed.

While reproducing the chain, the harness hit a constraint that refused the
accrual. What the system did:

```
order              -> paid, awaiting_fulfillment, paid_side_effects_at set
inventory          -> 3 units committed  (19 -> 16)
customer           -> shown a successful order
webhook response   -> HTTP 200 {"success":true, "status":"paid"}
referral_orders    -> 0 rows
commissions        -> 0 rows
the only trace     -> console.error("Unable to record commission for order …")
```

**The customer received the ambassador's 15 % discount and the ambassador earned
nothing, and nothing anywhere said so.**

Both accrual lanes swallow the failure identically:

```
payment-webhook.ts:1622  } catch (commissionError) {
payment-webhook.ts:1623    console.error("Unable to record commission for order", orderId, commissionError);
payment-webhook.ts:1110  } catch (commissionError) {
payment-webhook.ts:1111    console.error("Unable to record commission for manually approved order", orderId, commissionError);
```

There is **no `Sentry.captureException`**, no `ineligible_reason` written, no
admin flag, no retry. `captureException` appears exactly once in the codebase, in
`global-error.tsx` (client-side React errors), and no
`captureConsoleIntegration` is configured — so `console.error` never reaches
Sentry. Confirmed against the live Sentry project: three open issues, none about
commissions.

**Catching is right — an unfulfilled order is worse than a missing commission
row.** What is missing is the alarm. This store already proves it can alert well:
`express_reconcile_backlog` and `shippo_label_unattributed` are deliberate,
well-written Sentry alerts (§LIVE-033). The money path that pays ambassadors has
none.

**Production is not currently broken by this** — see AFF-10 — but a guard whose
failure mode is silent is one bad row away from costing an ambassador their
earnings with no way to discover it.

### AFF-10 — production's constraint is CORRECT, and the harness parity script re-creates the broken one

**Status:** DATABASE-PROVEN (both sides)

The constraint that refused the accrual above:

| Where | Constraint | Accepts `'pending'`? |
|---|---|---|
| **Production** | `referral_orders_payment_status_check` — `CHECK (payment_status = ANY (ARRAY['pending','approved_for_payout','paid','reversed','voided','refunded','partially_refunded']))` | **YES ✅** |
| **Freshly built harness** | `pc_ro_ps` — `CHECK (payment_status = ANY (ARRAY['paid','refunded','partially_refunded']))` | **NO ❌** |

The accrual writes `payment_status: "pending"` (`payment-webhook.ts`, `basePayload`).

**So the production fix is real, and this session proved it by reproducing the
original failure and then showing production's constraint accepts exactly what
the code writes.** The first real ambassador sale will accrue.

**But `src/lib/sql/harness-prod-parity-constraints.sql:51` still adds `pc_ro_ps`**,
and `scripts/setup-local-harness.sh` runs it. Every harness built from this repo
therefore carries the narrow constraint and **fails every commission accrual**.
`referral-orders-commission-lifecycle.sql` already anticipated this — it drops by
rule rather than by name, and its comment names `pc_ro_ps` explicitly — but the
parity script that creates it was never updated to match the widened production
rule.

Consequence: **future affiliate testing on a rebuilt harness produces a false
failure**, and an engineer could reasonably conclude the production P0 had
regressed. It cost this session about an hour to distinguish the two. Aligning
the parity script with production closes it.

### HARN-05 — the server is the price authority, and it errs in the customer's favour

**Status:** HARNESS-PROVEN

The captured `create-session` payload sends **no prices** — only
`{id, quantity}` per line — plus an `expectedTotal` for the server to check
against. On one run the client sent `expectedTotal: 125.37` (its referral had not
hydrated) while the server computed **$116.97 + fees**, applied the discount, and
created the order at the **lower** figure rather than rejecting the mismatch.

The browser cannot set a price, and a client that under-claims a discount does
not cost the customer money. **AUTHORIZATION TRUTH for pricing: PROVEN.**

## 2k. WHAT PRODUCTION IS TELLING YOU RIGHT NOW

Read from the live Sentry project `vanta-innovation-llc` and reconciled against
the production database. These are **current, open, unresolved**.

### LIVE-033 — **a real customer failed checkout three times in the last half hour**

**Severity:** P0 for revenue · **live right now**
**Status:** CONFIRMED · DATABASE-PROVEN

```
order-574d6762…  19:28:38Z  pending_payment  $98.18   glp-1 + bac water
order-0a0cffc4…  19:36:46Z  pending_payment  $103.38  glp-3 + bac water
order-a0190dd6…  19:44:24Z  pending_payment  $103.38  glp-3 + bac water
                              all three: lilycaroline2006@icloud.com
```

Three attempts in **sixteen minutes**, from one real customer, none completed.
All three hold **active** inventory reservations:

```
glp-3 10mg           39 on hand,  2 reserved
glp-1 10mg           29 on hand,  1 reserved
bacteriostatic-water 39 on hand,  3 reserved
```

Three attempts in that pattern is not idle browsing — it is someone who wants to
buy and cannot. `create-session` clearly succeeded each time (order rows exist
with `pending_payment`), so the failure is at or after the hosted payment step.

**Not diagnosed, and deliberately so.** Loading `/checkout/pay/<orderId>` for
another person's live order was not something to do on production during an
inspection. The pay page polls `GET /api/checkout/order-status/…` and is
read-only (verified on the harness), so it *can* be opened safely — but it is
that customer's order, and the decision belongs to the owner.

**This is the first thing to look at.** Either the payment step is broken for
some customers, or this customer's card is failing three times — and the store
has no way to tell those apart from the outside.

### LIVE-034 — two orders have been alerting for 21 hours and nobody has acted

**Severity:** P2 · operational
**Status:** CONFIRMED · Sentry + DATABASE-PROVEN

Sentry `VANTA-LABS-2`, **15 events**, first seen 21 hours ago, last seen minutes
before this was written:

> **express_reconcile_backlog:** 2 express order(s) have been pending at the
> processor for over 24h — typically an abandoned 3DS challenge. **They hold
> inventory and will never settle on their own**; review and cancel or complete
> them.

The two matching orders:

```
order-694115f4…  pending_payment  $68.49   16 days old
order-21fb4328…  pending_payment  $125.02  23 days old
```

**Two corrections to the alert's own text**, both checked:

- Their reservations are `released`, not active — they are **not** holding
  inventory. The alert overstates. An owner acting on it would find nothing held.
- The genuinely held stock belongs to the *three fresh* orders in LIVE-033, which
  this alert does not mention.

The monitoring is well built and the message is actionable; it has simply been
firing into a void for a day, and it is slightly wrong about the consequence.

### LIVE-035 — a Shippo label was bought that no order can be matched to

**Severity:** P2 · money spent, unattributed
**Status:** CONFIRMED · Sentry

`VANTA-LABS-4`, 1 event, 6 hours old, from `POST /api/webhooks/shippo`:

> **shippo_label_unattributed:** A Shippo label was purchased that Vanta could
> not match to an order. The postage is not in any order's profit, and if this
> was a Vanta order it is still sitting in Needs Fulfillment.

Real postage was spent and is missing from profit. Open, unactioned.

### LIVE-036 — a JavaScript error inside an in-app browser, on the catalog

**Severity:** P3 · SUSPECTED impact
**Status:** CONFIRMED occurrence · Sentry

`VANTA-LABS-3`, 2 events, 7 hours old, culprit `/products`:

> `Error: Error invoking postMessage: Java object is gone`

That signature is an Android WebView / in-app browser (TikTok, Instagram)
teardown. Given the store's ad channels are TikTok, Snapchat and Reddit, **most
paid traffic will arrive inside an in-app browser**, so this is worth
reproducing there rather than dismissing. Whether it breaks anything the
customer can see is NOT VERIFIED.

### The monitoring itself is good — that is the point

`express_reconcile_backlog` and `shippo_label_unattributed` are custom,
deliberate, well-written operational alerts with the consequence and the remedy
in the message. The store *can* tell its owner when something needs attention.
Which is exactly why **AFF-09** matters: the one money path with no alarm at all
is the one that pays ambassadors.

---

## 2l. CONSENT ON A REFERRAL CLICK — the fix works, the policy still disagrees

**Status:** HARNESS-PROVEN (`/r/[code]` writes two rows, so it was never called
on production)

Three clicks on `/r/EXPLICIT15?utm_source=tiktok&utm_medium=bio&utm_campaign=aug`,
one per consent state:

| `vl_cookie_consent` | utm / user-agent / IP recorded | attribution row | 30-day `vl_referral_code` cookie |
|---|---|---|---|
| **unset** (banner unanswered) | **NULL, NULL, NULL** ✅ | written | **set** |
| **declined** | **NULL, NULL, NULL** ✅ | written | **set** |
| **accepted** | `tiktok`, `Mozilla/5.0 (X11; Li…`, `127.0.0.1` | written | set |

**The audit's consent fix is correct and now proven at runtime**, including
`unset` counting as no.

### LIVE-037 — the Cookie Policy does not cover the referral cookie

**Severity:** P2 · policy vs behaviour
**Status:** CONFIRMED · HARNESS-PROVEN + BROWSER-PROVEN (policy text)
**Cross-reference:** the open owner decision `/r/[code]` flags in its own comment.

`/legal/cookies` says:

> "**Essential** — cart contents, checkout state, login sessions, and your age
> confirmation. These are always on; the store cannot work without them."
> "**Choosing Decline on the banner stops all non-essential storage**; nothing in
> the analytics category is created."

A visitor who clicks Decline and then follows an ambassador's link still gets a
**30-day `vl_referral_code` cookie**, and a server-side `partner_clicks` row and
`referrals` row naming the ambassador, the code and the landing path.

The referral cookie is **in none of the three published categories**. Either it
is essential (say so, and list it) or it is not (and Decline must stop it). The
code says as much and declines to decide:

> "whether THAT is essential storage is the owner's call, not a decision to make
> silently inside a bug fix. **Flagged, not changed.**"

**It is still flagged and still not decided, and the policy has not been
updated.** This is an owner decision, not an engineering bug.

---

### LIVE-038 — the cookie banner works, and the pixels are unverifiable by design

**Status:** PROVEN WORKING (consent) · NOT VERIFIABLE (pixels)

Both banner buttons were clicked on production and the result measured across a
navigation:

| Choice | first-party analytics identifiers created | third-party hosts contacted |
|---|---|---|
| **Decline** | **none** — storage is `vanta-labs-cart`, `vanta-labs-cart-session-id`, `vl_recently_viewed`, `vl_cookie_consent` only | Sentry only |
| **Accept** | `vl_analytics_visitor_id`, `vl_analytics_session_id`, `vl_attribution` | Sentry only |

`vl_cookie_consent` is stored as a cookie with a one-year expiry and the banner
does not return. **Decline genuinely creates no analytics identifiers** — exactly
what `/legal/cookies` promises.

**No TikTok, Snap or Reddit request was made even after Accept — and that is
correct behaviour, not a defect.** `src/lib/ads/ads-environment.ts:145`:

```js
// The one rule that fires on production. Playwright, Puppeteer and Selenium all
// set navigator.webdriver, so a QA pass against the live site — which the audit
// plan explicitly contemplates — records nothing in the ad account.
if (environment.webdriver === true) return { allowed: false, reason: "automated_browser" };
```

The store deliberately refuses ad reporting to automated browsers, specifically
so an inspection like this one cannot pollute the ad account. **It worked.**

**Consequence for this report:** whether the three advertising pixels actually
fire for a real visitor who accepts is **NOT VERIFIED and not verifiable with
this instrument.** It would need a real browser session, or the admin
`/api/ads/tracking-health` endpoint (401 without credentials). Given the store
advertises on TikTok, Snapchat and Reddit, confirming the pixels fire for real
traffic is worth doing by hand.

**Minor, related:** Sentry is contacted **before** the banner is answered, and
`/legal/cookies` does not mention it in any of its three categories. Arguably
essential error monitoring; still undisclosed. P3.

---

## 3. COVERAGE COUNTS

Exact, measured, and deliberately unflattering where relevant.

### Routes

| | Count |
|---|---|
| **Distinct production URLs loaded in a real browser** | **66** |
| — of which product pages | 36 (all published slugs, each at 390×844) |
| — legal pages | 6 |
| — research pages | 5 (hub + 4 articles) |
| — other customer pages | 17 |
| — non-page (`sitemap.xml`, `robots.txt`) | 2 |
| **Negative checks (must 404 / must not attribute)** | **11** (8 unpublished/archived slugs, 2 bad dynamic slugs, 1 random order id) |
| **Unauthenticated API GETs probed** | **35** |
| **Harness URLs driven transactionally** | 9 |
| **Routes NOT VERIFIED** | **43 page routes + ~108 API routes** |

**NOT VERIFIED, with reasons:**

| Routes | Count | Why |
|---|---|---|
| `/account/**` | 15 | account creation and sign-in are prohibited writes; no credentials supplied |
| `/admin/**`, `/vault` interior | 24 | `/vault` needs username + password + 6-digit passcode; none supplied. Login door seen; every screen behind it unseen |
| `/partner/dashboard` | 1 | partner auth |
| `/pay/[orderId]`, `/checkout/pay/[orderId]`, `/order-confirmation/[orderId]` | 3 | need a real production order. The pay page was driven on the harness |
| `/pay/mock/[orderId]` | 1 | inert in production by design (mock lockout) |
| `/membership/[tierSlug]/subscribe` | 1 | not loaded; ends in a write |
| API routes | ~108 | every POST/PATCH/DELETE is a write |

### Everything else

| | Count |
|---|---|
| **Viewport configurations** | **5** — 320×568, 390×844, 820×1180, 1440×900, 1920×1080 |
| **Customer journeys completed** | **6** — Stranger, Mobile customer, Returning customer, Ambassador's customer, Researcher, Owner (**partial** — database only, no admin UI) |
| **Playwright scenario runs** | **33** (25 against production, 8 against the harness) |
| **Parameterised cases inside those runs** | **≈140** — 36 product pages, 9 categories, 5 sorts, 4 searches, 7 referral codes, 5 cart quantities across the referral minimum, 5 US/CA address permutations, 3 consent states, 2 banner choices, 4 affiliate edges, 2 concurrent buyers, 5 dose switches, back/forward/second-tab/refresh sequences |
| **Interactive controls exercised** | **≈120** distinct controls — 4 age-gate checkboxes + 3 buttons, 3 FAQ accordions, search open/type/submit/clear, cart drawer open/close, wishlist, 10 category options, 5 sort options, 2 filter toggles, clear-all, 36 add-to-cart buttons, dose selectors, quantity tiers, BAC-water upsell (add and dismiss), cart +/−/remove, referral apply/clear, 17 checkout fields, 5 checkboxes, 2 selects, 2 cookie-banner buttons |
| **Console errors observed** | **1 recurring class** — `GET /api/account/me` → 401 on every anonymous page load (LIVE-008); plus 1 extra on `/vault` (`/api/admin/auth/session` 401) and 1 on `/partner/pending` (`/api/partner/me` 401). **Zero uncaught page errors anywhere.** |
| **Failed network requests** | **~1,900** across the session, of which **all but ~40 were Next.js `?_rsc=` prefetch aborts** (LIVE-009). The genuine 4xx are the 401s above. **No 5xx was seen on production at any point.** |
| **Broken images** | **0**, after scrolling. Unscrolled measurements report 3–11 per page; that is lazy-loading, verified by re-measuring the same pages after a scroll (4/5 → 0/5, 6/7 → 0/7). |
| **Horizontal scroll** | **0 pages**, at every viewport including 320×568 |

---

## 4. ROUTE STATUS — every customer-facing route accounted for

| Route | Status |
|---|---|
| `/` | **PROVEN WORKING** |
| `/products` | **PROVEN WORKING** — filters/sorts/search all verified; **DEFECT** LIVE-028 (state lost on Back), LIVE-029 (purity sort), LIVE-030 (dead In Stock toggle) |
| `/products/[slug]` ×36 | **PROVEN WORKING** — 36/36 HTTP 200, buyable, prices match DB; **DEFECT** LIVE-003/004/005 |
| `/cart` | **PROVEN WORKING**; **DEFECT** AFF-03, AFF-04, LIVE-013 |
| `/cart/restore` | **PARTIALLY VERIFIED** — missing-id state correct; a real recovery link not exercised (would need a tracked cart) |
| `/checkout` | **PARTIALLY VERIFIED** on production (form, totals, tax, Canada, validation state); **submission NOT VERIFIED there** — completed on the harness |
| `/checkout/pay/[orderId]` | **HARNESS-PROVEN** (order created, status polling read-only); **NOT VERIFIED** on production |
| `/pay/[orderId]`, `/pay/mock/[orderId]` | **NOT VERIFIED** — real order required / inert by design |
| `/order-confirmation/[orderId]` | **NOT VERIFIED** — random id correctly 404s; no real order opened |
| `/coa-library` | **PROVEN WORKING** — and the honest surface (§LIVE-001) |
| `/research`, `/research/[slug]` ×4 | **PROVEN WORKING** |
| `/legal/[slug]` ×6 | **PROVEN WORKING**; **DEFECT** LIVE-018 (raw Markdown, 4 of 6), LIVE-019 |
| `/membership` | **PROVEN WORKING**; **DEFECT** LIVE-021 (intro offer invisible) |
| `/membership/[tierSlug]/subscribe` | **NOT VERIFIED** |
| `/ambassador`, `/partner` | **PROVEN WORKING** as pages; **DEFECT** AFF-06, LIVE-016, LIVE-017 |
| `/partner/login` | **PROVEN WORKING** — redirects to `/account/login` |
| `/partner/pending` | **PROVEN WORKING** |
| `/partner/dashboard` | **NOT VERIFIED** — partner auth |
| `/login` | **DEFECT** LIVE-022 — orphaned second partner sign-in; whether it authenticates NOT VERIFIED |
| `/account/login`, `/account/forgot-password` | **PARTIALLY VERIFIED** — render correctly; submitting is a write |
| `/account/**` (13 more) | **NOT VERIFIED** — auth |
| `/contact`, `/wholesale` | **PARTIALLY VERIFIED** — forms render and are labelled; submitting is a write |
| `/maintenance` | **PROVEN WORKING** |
| `/vault` | **PARTIALLY VERIFIED** — login door renders; **DEFECT** LIVE-023 (22.8 s) |
| `/admin/**` ×24 | **NOT VERIFIED** — no credentials. Numbers reconciled via SQL instead (§2i) |
| `/r/[code]` | **PARTIALLY VERIFIED** — invalid code 307s with no write (production); valid-code behaviour **HARNESS-PROVEN** (§2l) |
| `/sitemap.xml`, `/robots.txt` | **PROVEN WORKING** |


---

## 5. THE ANSWERS

### 1. What did I notice?

It looks like a real company. The dark, restrained design holds up at every
width from a 320 px phone to a 1920 px desktop, nothing overflows, nothing is
broken, no page threw an uncaught error, and no 5xx appeared once. The age gate
is thoughtful — four separate attestations rather than one lazy tick — and the
cookie banner does exactly what its policy says. Add-to-cart, the cart, the
drawer, filters, sorts, search, dose switching and cart persistence all simply
work, including live sync across two tabs. That is better than most stores.

What I noticed second is that **the store makes more promises than it can keep.**
It tells you seven different times that it publishes a Certificate of Analysis
for every batch, and it has published none. It tells you "over 70 % of customers
add BAC Water" on the strength of six orders. It tells prospective ambassadors it
has paid out $22,638 when it has paid out nothing. On one product page it claims
≥99 % purity and, one tab across, prints "Purity Result: Pending".

None of that is a bug. All of it is the thing that decides whether a careful
buyer — the only kind this store sells to — trusts you.

### 2. What is not working? Ranked by what it costs.

1. **A real customer is failing to check out right now.** Three
   `pending_payment` orders from one address in sixteen minutes this afternoon,
   none completed, all holding stock. (LIVE-033)
2. **The ambassador link is a checkout blocker below $100.** The cart promises
   15 % off, applies nothing, and the pay button returns 400 with a minimum the
   customer was never told about. 75 referral clicks in production, 0 referral
   orders. (AFF-03)
3. **A failed commission accrual is invisible.** Demonstrated: order paid, stock
   committed, customer told success, ambassador earns nothing, one `console.error`
   and no Sentry event. (AFF-09)
4. **Seven surfaces promise published COAs; zero exist.** (LIVE-001)
5. **Fabricated earnings recruit ambassadors.** (AFF-06)
6. **The partner page contradicts itself** — 15 % in the benefits list, 10 % in
   the calculator that produces the advertised income. (LIVE-016)
7. **Marketing consent ships pre-ticked** on a store that sells to Canada.
   (LIVE-010)
8. **Sales tax is off in every state** while the cart says "calculated at
   checkout". (LIVE-031)
9. **Filters and sort are destroyed by the Back button.** (LIVE-028)
10. **The pay button is never disabled** — empty form, invalid email, withheld
    legal confirmation. (LIVE-032)
11. Two Sentry alerts have gone unactioned for 21 hours and 6 hours; one names a
    Shippo label whose postage is missing from profit. (LIVE-034, LIVE-035)

### 3. Is the affiliate system correct?

**The money is correct. The customer experience of it is broken.**

Correct, with evidence:

- The rate shown is the ambassador's own rate — 7 codes checked against the
  `ambassadors` table, explicit rates and NULL-inherits-default both right, and
  the `info_requested` ambassador correctly produces nothing. (AFF-01)
- The discount arithmetic reconciles to exactly 15 % of the full subtotal at
  every quantity once bundle pricing is accounted for. (AFF-02)
- On the harness, a qualifying referred order produces commission **$15.30** on a
  commissionable $101.97, written identically to `referral_orders` and
  `commissions`, hold state `pending`/`unpaid`, inventory committed. A replayed
  webhook changes nothing. Below the minimum the server refuses. An unapproved
  code is stripped and accrues nothing. (HARN-01, HARN-02, HARN-04)
- **The production constraint that once refused every accrual is genuinely
  fixed** — proven by reproducing the original failure on a harness that still
  carries the old narrow rule, then showing production's accepts exactly what
  the code writes. (AFF-10)

Not correct:

- **AFF-03**, above. This is the whole channel.
- **AFF-09** — the accrual has no alarm.
- **AFF-06 / LIVE-016 / LIVE-017** — what ambassadors are told does not match
  what they get or what the other page says.
- **AFF-07** — `ambassadors` and `partners` are two base tables holding the same
  rows with nothing enforcing agreement. They agree today.

And the number that should worry you most: **zero commissions have ever been
written in production, against 75 real referral clicks.**

### 4. Would a stranger successfully buy from this store?

Up to the pay button, yes, and pleasantly. They will hesitate in four places:

- **At the proof.** They click "confirm it before you buy", reach the COA
  Library, and find 36 rows of "not published yet".
- **At the price.** Every card shows a struck-through price and a −12 % badge
  that turns out to require a paid membership.
- **At the shipping.** Bulk tiers show "Free ship" with no threshold stated
  anywhere on the product page. (The cart does say $200 — the product page does
  not.)
- **At the referral discount**, if they came from an ambassador: promised 15 %,
  charged full price, then blocked at the pay button.

**Whether they can actually pay is NOT VERIFIED**, and LIVE-033 is a live reason
to doubt it.

### 5. Can the owner run it?

**Unknown, and that is the honest answer** — no credentials were available, so
all 24 admin screens are unseen. What can be said from the database:

- The three revenue surfaces agree exactly with each other and with raw SQL.
- All six paid orders reconcile to the cent.
- The headline "revenue" is gross receipts: it includes $9.69 of sales tax owed
  to states, $75 of shipping recovery, and $45.47 belonging to an order cancelled
  after payment. Fine at six orders; wrong at a hundred a day.
- 335 coupons are flagged active and have all expired.
- `admin_partner_rollups()` returns only the 2 ambassadors with clicks, not all 8.
- The monitoring is genuinely good — and two alerts have been ignored for a day,
  which is the real risk at volume.

### 6. What I would fix first, and why

1. **Find out why that customer could not pay.** (LIVE-033) It is the only
   finding costing money this hour.
2. **Fix the referral path below $100.** (AFF-03) State the minimum in the cart,
   do not announce a discount the basket does not qualify for, and never let an
   ambassador's own code 400 the pay button. 75 clicks, 0 orders.
3. **Make the claims true or remove them.** (LIVE-001, LIVE-002, AFF-06,
   LIVE-016) This is copy, not engineering — a day's work that removes real
   advertising exposure and the contradiction a careful buyer will find.
4. **Put an alarm on commission accrual.** (AFF-09) One `Sentry.captureException`
   in two catch blocks converts a silent, permanent loss into a page.
5. **Untick the marketing consent box.** (LIVE-010) One character; removes a CASL
   problem on a store that ships to Canada.

### 7. What is still not verified, and what it would take

| Not verified | What would close it |
|---|---|
| **The real-money lifecycle** — real card, real processor callback, real production order, real inventory decrement, real email, real label | A single small real order, placed deliberately and refunded |
| **All 24 admin screens** | Admin credentials |
| **All 15 account pages, signed-in pricing, membership pricing interaction** | A test account |
| **Whether the advertising pixels fire** | A real browser; automated ones are refused by design (LIVE-038) |
| **Email** — order confirmation, shipping, delivery, unsubscribe | Any real send |
| **Fulfilment** — label purchase, carrier events, monotonic status | A real label |
| **RLS policy correctness** | The harness runs as superuser |
| **TLS 1.3 behaviour of the live site** | Not behind this proxy |
| **Whether `/login` still authenticates** | Partner credentials |
| **Why LIVE-033's customer failed** | The owner opening that order |

---

## 6. DO THE CORE SYSTEM PRINCIPLES HOLD?

| Principle | Grade | Evidence |
|---|---|---|
| **PRODUCT TRUTH** | **DATABASE-PROVEN + BROWSER-PROVEN** | 36 cards = 36 enabled rows; every unpublished/archived slug 404s; `dsip` and `ss-31` prove a stocked dose is never hidden by a zero parent |
| **PRICE TRUTH** | **DATABASE-PROVEN** | 48 dose prices match the DB; catalog = PDP = cart = checkout at qty 1 and 3; bulk tiers reconcile by per-unit floor rounding; client sends no prices |
| **DISCOUNT TRUTH** | **PARTIAL — money PROVEN, communication FAILED** | Referral/bundle/membership arithmetic all reconcile; coupon-vs-referral exclusivity stated and enforced; **AFF-03/AFF-04** break the customer's understanding. Membership pricing interaction NOT VERIFIED |
| **AFFILIATE TRUTH** | **HARNESS-PROVEN correct · NOT VERIFIED in production · one FAILED sub-claim** | One consistent financial event end to end; but AFF-09 means a silent failure is possible, and production has never run the path |
| **INVENTORY TRUTH** | **HARNESS-PROVEN** | No negative stock; no double decrement on replay; two buyers cannot take the last unit; oversell refused; stocked doses purchasable at zero parent; failed payment releases and consumes nothing |
| **PAYMENT / ORDER TRUTH** | **HARNESS-PROVEN · real processor NOT VERIFIED** | One payment → exactly one paid order; replay → no duplicate order, commission or decrement; a failed payment leaves a `canceled` order and no stock consumed |
| **FULFILMENT TRUTH** | **NOT VERIFIED** | No label bought, no carrier event seen. LIVE-035 shows one real label already unattributed |
| **COMMUNICATION TRUTH** | **NOT VERIFIED** | Email disabled throughout; not one message observed |
| **ADMIN TRUTH** | **PARTIAL — DATABASE-PROVEN, screens NOT VERIFIED** | Rollups agree with raw SQL; no screen was seen; ADM-02 and ADM-05 are open questions |
| **ACCOUNTING TRUTH** | **DATABASE-PROVEN at order level** | All six paid orders reconcile to the cent. Profit/COGS reporting NOT VERIFIED |
| **AUTHORIZATION TRUTH** | **PROVEN** | 35 unauthenticated GETs all refused; no cost or margin data in the public API; client cannot set price, payment status, inventory or commission |
| **FAILURE TRUTH** | **MIXED — one FAILED** | Payment failure recovers safely and tells the truth; operational alerts are well built and fire; **commission accrual fails silently (AFF-09)** |

---

## 7. IS THE COMBINED SYSTEM OPERATIONAL RIGHT NOW?

These are two different claims and they get two different answers.

**The live storefront is operational.** A stranger can arrive, pass the age gate
on any device, browse 36 correctly-priced products, read the policies, select a
dose, build a cart that survives refresh, back/forward, a second tab and a
restart, apply an ambassador code, see a correct discount above $100, and reach
a fully-populated checkout with correct shipping for the US and Canada. That is
BROWSER-PROVEN across 66 URLs and 5 viewports, with no 5xx and no uncaught
errors.

**The complete transactional system is NOT proven operational.** Everything past
the pay button — real card, real processor callback, real production order, real
inventory decrement, real confirmation email, real label — **remains NOT
VERIFIED.** It was proven on a harness this session, and the harness is not the
store.

Three facts stop me going further:

1. **Zero referral orders and zero commissions have ever existed in production**,
   against 75 real referral clicks.
2. **A real customer made three payment attempts this afternoon and completed
   none.**
3. **The one path that pays ambassadors has no alarm on it.**

The harness working does not convert any of those into a pass, and I have not
converted them.


---

## 8. THE FIX — AFF-03 CLOSED

**Committed on `claude/vanta-labs-live-inspection-h1eh4f` after the inspection,
at the owner's instruction, and merged to `main`.**

### What was wrong, restated precisely

A customer arriving from an ambassador's link with a basket under the $100
programme minimum was told they had a discount, given none, and then **refused at
the pay button**. `quote-order.ts` threw; `create-session` returned HTTP 400; no
order was created. It is the only path a referred customer takes — nobody types
a code — and production carried **75 referral clicks and 0 referral orders**.

### The decision, and why

The central question was whether a below-minimum referred order should be
**refused** or **allowed at full price with the attribution kept**. The codebase
answers it in six places:

1. `payment-webhook.ts:714-716` computes a minimum-specific `ineligible_reason`
   that **no checkout-originated order could ever produce** — dead code that only
   makes sense if such orders were meant to exist.
2. `payment-webhook.ts:719-721` treats below-minimum as a pricing outcome
   (`commissionPercent = 0`), not an error. It does not throw or skip.
3. The `referral_orders` row is written **unconditionally**.
4. `payment-webhook.ts:687` calls its own eligibility check *"defence in depth"* —
   which presumes a first line that lets the order through.
5. `commission-accrual-repair.ts:34` exists so that *"'no row' never means
   'considered and refused'"* — meaningless if refused orders never become orders.
6. **Thirty lines above the throw**, `quote-order.ts:541-546` drops a *stale*
   referral rather than throwing, on the stated grounds that **"a stale referral
   must never hard-block a legitimate sale."**

A perfectly valid code that merely arrived with a small basket has at least as
good a claim. The minimum is a **commission** rule, not a **sale** rule.

### What changed

| File | Change |
|---|---|
| **`src/lib/referral-qualification.ts`** *(new)* | `referralQualifies()`, `referralShortfall()`, `referralStatusLine()`. One rule, used by the cart preview, `quote-order.ts` **and** `payment-webhook.ts`. Compares in **cents**, and a corrupt minimum resolves to *no* minimum rather than silently stripping every ambassador's discount. |
| `src/lib/quote-order.ts` | The throw is gone. The referral stays attached for **attribution** and is inert for **pricing**: `referralAccepted` / `referralPercent` and the profit guard's `guardCommissionPercent` are all gated on qualification. Self-referral still throws. |
| `src/lib/payment-webhook.ts` | Uses the same shared rule instead of its own inline comparison. Behaviourally a no-op for every reachable input; it is there so the two cannot drift. |
| `src/lib/quote-order.ts` *(second pass)* | Store credit and points are now suppressed by a referral discount **being given**, not by a code being attached — `!referralQualifiesForDiscount` in place of `!referral`. See "The review found a P0 in the first pass" below. |
| `src/components/cart-context.tsx` | Exposes `referralMinimumOrder`, `referralMeetsMinimum`, `referralAmountToQualify`, and — after review — the finished sentence itself (`referralStatusText`) plus `referralNeedsMoreToQualify`, both from `referralCartStatus()`. |
| `cart-client.tsx`, `cart-drawer.tsx`, `checkout/page.tsx` | All three render one string from context. They previously hand-copied six arguments each into `referralStatusLine()`; that is the drift shape `resolveCartDiscount` was extracted to end, and it had already produced a defect (below). |

**Coupon exclusivity is deliberately still keyed on the code being attached.**
Unlike credit and points, a coupon is something the shopper actively chooses to
enter, and the cart clears one when the other is applied; relaxing it is a
product decision, not a correctness fix.

### What the customer sees now

| Basket | Before | After |
|---|---|---|
| $39.99 with a referral link | "Ambassador Xavier Martinez • **15% customer discount**", no discount applied, **HTTP 400 at the pay button** | "Explicit Fifteen · **15% off orders of $100.00 or more — add $60.01 to unlock it**", amber, no discount, **order goes through** |
| $110.37 with a referral link | correct | unchanged — "15% customer discount", `−$8.40`, total $116.97 |
| 4 vials, Buy-3-Get-1 running | "15% customer discount" — **directly beneath the notice saying referral discounts are paused** | "Explicit Fifteen · **referral code applied**" — no discount claimed, no unreachable advice |
| ambassador row with a null name | the literal text `null` (would have been; the old JSX rendered nothing) | "**Your ambassador** · 15% customer discount" |

"orders **of** $100.00 **or more**", not "over": `referralQualifies` rounds both
sides to cents and compares with `>=`, so a basket of exactly $100.00 qualifies.
"Over" described a threshold the module deliberately does not have.

Verified in the browser on all three surfaces (cart page, cart drawer, checkout
panel) at 390×844 and 1440×900, in all three basket states. All three surfaces
render **the identical string** in every state. At 390px the drawer's wrapped
sentence and its "Remove" button were measured for collision: none
(`flex-shrink-0` was added to the button in the same pass). With the bundle
running the drawer replaces the whole codes section with "Buy 3, Get 1 Free —
active · Your lowest-priced eligible item is free. Referral discounts pause while
this promotion applies." — which the other two surfaces now agree with instead of
contradicting.

### Evidence

**Tests — 4,147 pass, 0 fail, 78 skipped, `tsc` clean, eslint 0 errors.**

- `referral-qualification.test.ts` — 41 tests. **Every one was watched failing**
  before the code existed, and then again against a deliberately *wrong* stub, so
  the negative assertions got a genuine red rather than a missing-export error.
- `commission-eligibility.test.ts` — the test that asserted HTTP 400 and zero
  orders was **replaced**, deliberately, with the invariant that actually
  matters. Three new tests:
  - below the minimum → **200, `discount_amount = 0`, `referral_code` kept**
  - exactly **on** the minimum → discount applies
  - a thin-margin below-minimum cart is **not** refused by the profit guard
- `ambassador-regression.test.ts` — a **source-text** assertion
  (`expect(webhook).toContain("qualifyingSubtotal < ...")`) was replaced with a
  behavioural test in the e2e file, because the refactor moved the string while
  the behaviour was untouched. That is the placebo pattern this audit exists to
  catch, found in the act.

**Mutation controls — each new test watched killing a real mutant:**

| Mutant | Test that caught it |
|---|---|
| gate the webhook on `commissionableSubtotal` instead of `qualifyingSubtotal` | "a discount that drops the commissionable subtotal below the minimum still earns" |
| apply the referral discount below the minimum | "allows a cart below the minimum…" (`expected 10 to be +0`) |
| revert **both** profit-guard gates | "does not charge the profit guard…" (`Promotion unavailable on this order.`) |

That last one matters: **reverting only one of the two guard gates survived the
entire 241-test checkout suite**, because `profit-engine.ts:244` multiplies the
commission rate by `referralAccepted`. The window was then *measured*, not
guessed — with the guard wrongly charged, a $99.99 referred cart is refused once
unit cost passes **$80**; correctly gated, not until **$105**. Every
below-minimum referred cart costing between those figures was being refused
outright while the identical cart *without* a code went through.

**Harness, end to end** — a real production build against a local Postgres, paid
by signing the real `payment.succeeded` webhook:

| Case | subtotal | discount | `referral_code` | commission | `ineligible_reason` |
|---|---|---|---|---|---|
| qualifying | 110.37 | **8.40** | `EXPLICIT15` | **15.30** @ 15% | — |
| **below minimum** | 39.99 | **0.00** | `EXPLICIT15` | **0.00** | "below the 100.00 minimum qualifying order." |
| unapproved code | 110.37 | 0.00 | **NULL** | — | — |

The previously-unreachable branch at `payment-webhook.ts:715` is now live and
doing exactly what it was written to do.

### The review found a P0 in the first pass — the store credit divergence

The first pass was reviewed by an adversarial panel before merge, and the panel
was right about the most important thing.

**What the first pass did.** It relaxed the client — `cart-context.tsx` and the
checkout panel stopped suppressing store credit and points on
`referralDetails` and started suppressing on `referralMeetsMinimum` — and left
the server on `if (!referral)`. The commit's own comment claimed the two sides
matched. **They did not**, and the comment described the code as it had been
before the same commit edited it.

**What that costs.** A signed-in shopper with store credit or points arrives on
an ambassador's link with a small basket:

- client: the referral is inert, so the credit applies → `expectedTotal` = $30
- server: a code is attached, so the credit is zeroed → `expectedTotal` = $80
- `quote-order.ts` sees the client claiming *less* than the server computes,
  which is exactly what the underpayment guard exists to reject →
  **HTTP 400, "Altered total detected"**

The error even tells her to refresh the page, and refreshing changes nothing.
That is the same class of failure this fix exists to remove, moved to a different
customer. On the express lane, which sends no `expectedTotal` and therefore has
no guard, the same divergence charges the wallet **$50 more than the drawer
showed**.

**The fix.** Both gates in `quote-order.ts` now read
`!referralQualifiesForDiscount`. The exclusivity rule is unchanged in substance —
nothing stacks with a referral discount — but it is now expressed as *a discount
being given* rather than *a code being attached*, which is what it always meant.
An inert code costs the shopper nothing.

Proved by two tests driving the real `quoteOrder` against the in-memory database
(`commission-eligibility.test.ts`): a below-minimum referred order redeems the
shopper's points, and — the mutation control, without which deleting the gate
outright would also pass — a **qualifying** referral still refuses to stack them.

This closes what was recorded as OPEN-01 below.

### Two more the review caught, both in the sentence itself

- **The cart claimed a discount underneath the text saying it could not be
  given.** Buy-3-Get-1 suppresses the referral outright in `promoDiscount`, and
  not one of the three surfaces knew: with the promo running the cart read
  "15% customer discount", and below the minimum it read "add $60.01 to unlock
  it" — advice that adding $60.01 could not act on. The whole status is now
  derived once by `referralCartStatus()`, which takes the bundle amount as an
  input; the three surfaces render the string it returns.
- **A null `ambassador_name` would have rendered the literal word "null".**
  `referral-client.ts` returns the column straight from the RPC and it is
  nullable. Falls back to "Your ambassador".

### The second review found the fix was half of itself

The committed fix was put through a second adversarial panel — four independent
lenses, every finding then given to three refuters — and the panel found that
the rule the commit *states* had only been half implemented.

**The rule.** Store credit and points never stack with a referral discount.
The commit says it gates on "a referral discount BEING GIVEN, not a code being
attached".

**What it actually gated on.** `referralQualifiesForDiscount` — *is the basket
over $100*. That is not the same question. The referral has to WIN against
every other candidate in `resolveCustomerDiscount`, and it loses to four things:

| the referral loses to | how |
|---|---|
| a commission-only ambassador | `customer_discount_percent = 0` — the module's own comment calls this legitimate |
| Buy-3-Get-1 | `!isBundle && hasReferral` suppresses the bucket outright |
| **quantity-bundle pricing** | `compete()` — and this is DEFAULT catalogue pricing, not an opt-in promo |
| membership / bulk / personal | simply worth more |

The quantity-bundle case needs no special basket. Two units of a $100 item bake
$10 of bundle savings into the subtotal, and a 5% ambassador's $10 competes to
**exactly $0.00**. Five vials at $59.99 against a 10% ambassador: $36.00 of
bundle savings, referral worth $30.00, competed to **$0.00**.

In every one of those the shopper cleared the minimum, was told "N% customer
discount" on three surfaces, was charged a total containing none of it, **and
had her whole store-credit balance withheld to pay for it** — up to $50 more
than the identical cart with no ambassador link at all, on the card lane and
the express lane alike, with client and server agreeing so nothing surfaced.
The ambassador still earned her commission, so her own link made her audience
worse off.

**The fix.** One predicate, read off the resolved winner rather than re-derived:

- server — `customerDiscount.components.includes("referral") && amount > 0`
- client — `bestDiscount?.type === "referral" && discountAmount > 0`

It gates store credit, points, and what the sentence is allowed to claim. The
client derivation had to move below `resolveCartDiscount` to see the winner.
`blockedByPromotion` is gone: "the referral did not win" subsumes it.

**The arithmetic moved too.** `store-credit-redemption.ts` (new) holds the
credit and points maths in **cents**, and all three callers — cart context,
checkout panel, `quote-order.ts` — call it. They were three hand-written copies,
two of them comparing in dollars while the server compared in cents.

### Two tests that proved nothing, found by mutation

The same panel mutated the source and ran the suite. Two gaps:

- **Reverting the server's store-credit gate left all 4,147 tests green.** The
  points half was covered; the credit half was not, and no test anywhere passed
  a referral code into `quoteOrder` alongside a store-credit balance.
- **Reverting both client gates left the suite green too.** Nothing renders
  `CartProvider`, so nothing could see them.

Both are now covered by behaviour:

- `referral-exclusivity.test.ts` (new) drives the real `quoteOrder` through all
  five states — below the minimum, 0% ambassador, Buy-3-Get-1, membership
  winning, and the referral genuinely winning — and asserts the invariant
  directly: **a referred basket that earns no referral discount is charged
  exactly what the same basket with no code at all is charged.**
- `store-credit-redemption.test.ts` (new) covers the shared arithmetic.
- `cart-server-discount-parity.test.ts` now checks *who won*, not only how much,
  across all 22 scenarios — using the exact expressions the client and the
  server each use.

**Mutation controls, watched:** reverting the gate to `referralQualifiesForDiscount`
(the first repair) turns 3 tests red; reverting it to `Boolean(referral)` (the
original) turns 7 red across two files.

Also fixed: the apply confirmation ("Referral code saved — 15% off unlocks at
$100.00. Add $31.00 to qualify.") is a one-shot string quoting a basket-dependent
figure, and `updateQuantity`/`removeItem` did not clear it — so stepping a cart
down left "Referral code applied — 15% off." in emerald directly above "add
$31.00 to unlock it" in amber. And the comment introducing the change asserted
the *opposite* of what the change did, which on a live store's money path is a
trap rather than a nit.

### A note on verifying this repo

One review lens reported the branch red when the rest of the evidence said
green. It was right: a warm `node_modules/.vite` cache served a stale transform
of `quote-order.ts`, which flipped the profit-guard test in and out of failure
with no source change. The final numbers below were taken after
`rm -rf node_modules/.vite`.

**Final: 4,198 tests pass, 0 fail, 78 skipped, `tsc` clean, eslint 0 errors** —
cold cache, whole suite.

---

## 9. WHAT THE FIX LEAVES OPEN

Recorded because they are real, and because scoping them out of a payment-path
change that goes straight to `main` was a deliberate decision, not an oversight.

### OPEN-01 — CLOSED during review

A below-minimum code no longer suppresses store credit or points; see "The
review found a P0 in the first pass" in §8. It was recorded here as a P2
follow-up, the review showed it was a P0 in the diff itself, and it was fixed
before merge. **Coupon exclusivity is unchanged** and still keys on the code
being attached — a coupon is entered deliberately and the cart clears one when
the other is applied, so relaxing it is a product decision rather than a
correctness fix.

### OPEN-02 — below-minimum orders will appear in the admin FRAUD REVIEW queue

**Severity:** P3 · noise
**Status:** CONFIRMED by code read

`admin-ambassadors.ts:45` builds the fraud-review list as
`fraud_flag || ineligible_reason || payment_status === "manual_review"`. Every
below-minimum referred order now carries an `ineligible_reason`, so every one of
them lands in a queue meant for fraud.

The queue already mixed eligibility with fraud ("Ambassador is not active",
"Commissions are paused"), so this is a change of volume, not of kind — and the
volume will be high, because most first baskets are under $100. Excluding the
below-minimum reason specifically would fix it, but that is a judgement call
about an admin surface this session never saw.

### OPEN-03 — a stale client minimum still fails with "Altered total detected"

**Severity:** P2 · pre-existing, unchanged by this fix
**Status:** CONFIRMED by code read

`cart-context.tsx` fetches `referralMinimumOrder` once on mount and returns
early on `if (!response.ok)`, leaving the client on the built-in default of 100.
The server reads the stored value. If the owner sets the minimum to 150 and a
shopper's `/api/catalog/promotions` call fails — or their tab predates the
change — a $120 basket qualifies on the client and not on the server, the
client's `expectedTotal` comes in low, and the underpayment guard refuses the
order.

The refusal is correct; the **message** is not. It reads like a fraud accusation
and tells the shopper to refresh, which does not help. Special-casing the message
when `referral && !referralQualifiesForDiscount`, or returning the qualification
state in the quote so the client can reconcile, would close it.

### OPEN-04 — CLOSED during the second review

The sentence no longer claims a discount that is not being given, in any of the
four ways the referral can lose; see "The second review found the fix was half
of itself" in §8. What remains is the smaller half of the original note: "add
$4.96 to unlock it" can still be unreachable by adding $4.96, because adding a
unit can cross into a deeper bundle tier and *lower* the subtotal (9 × $12.00 →
$95.04; 10 × $12.00 → $96.00). Self-correcting on the next render, but wrong at
the moment it is read.

### OPEN-05 — ineligible `referral_orders` rows stay `pending` forever

**Severity:** P3 · unbounded growth
**Status:** CONFIRMED by code read

Every below-minimum referred order now writes a `referral_orders` row with a
zero commission and an `ineligible_reason`, and nothing ever moves it off
`payment_status = 'pending'`. `partner-portal.ts:331` selects **all** pending
rows with no limit to compute what an ambassador is owed. The rows contribute
$0, so no figure is wrong today, but the query grows without bound and the
portal's "pending" count will read as money in flight when it is not. A
`ineligible_reason is null` filter is behaviour-preserving.

### OPEN-06 — the referral programme master switch still hard-blocks the pay button

**Severity:** P2 · pre-existing, unchanged by this fix
**Status:** CONFIRMED by code read

`quote-order.ts:538` throws "The referral program is currently unavailable.
Remove the code to continue." when the admin turns the programme off in the
Control Center. The client never learns: `validateReferralCodeClient` reads the
ambassadors table directly, and `/api/catalog/promotions` sends
`referralDiscountPercent` and `referralMinimumOrder` but never `enabled`. So
every link already in the wild keeps showing "15% customer discount", keeps
applying it, and every one of those shoppers is refused at the pay button — the
identical shape to the defect this fix closes, triggered by the switch instead
of the minimum.

Dropping the referral instead of throwing does **not** fix it on its own: the
server's total would then be higher than the client's, and the underpayment
guard refuses the order anyway. The client has to be told, which means the
`enabled` flag on `/api/catalog/promotions`, state for it in cart context, and a
decision about tabs already open. That is its own diff. The switch is currently
**on**, so nothing is failing today.

### Still true, and unchanged by this fix

- **AFF-09** — a failed commission accrual is still invisible: both lanes catch
  and `console.error`, with no `Sentry.captureException` anywhere on the path.
  **This is the single highest-value remaining fix in the affiliate system.**
- **AFF-10** — `harness-prod-parity-constraints.sql:51` still creates the old
  narrow `pc_ro_ps`, so any rebuilt harness still fails every accrual.
- **AFF-06 / LIVE-016 / LIVE-017** — the partner pages still advertise $22,638 in
  commissions paid, and still contradict themselves on the commission rate.
- **LIVE-033** — the customer who made three payment attempts is still
  undiagnosed, **and this fix does not address it.** Checked directly: all three
  orders carry `referral_code = NULL` and `ambassador_id = NULL`, with
  merchandise subtotals of $79.98, $84.98 and $84.98. So although every one of
  them is under the $100 minimum, none carried a code and none could have hit
  AFF-03. Their failure is at or after the hosted payment step and remains the
  most urgent open item.
