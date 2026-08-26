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

_(walk continues)_

---

## 3. COVERAGE COUNTS

_(final tally at the end)_
