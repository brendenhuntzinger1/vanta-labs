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
| card processing surcharge | $2.43 |
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

_(walk continues)_

---

## 3. COVERAGE COUNTS

_(final tally at the end)_
