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

_(walk continues)_

---

## 3. COVERAGE COUNTS

_(final tally at the end)_
