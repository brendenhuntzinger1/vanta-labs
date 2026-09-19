# Vanta Labs — customer experience certification, 2026-09-19

> Companion to `CERTIFICATION-2026-09-19.md`, which certified the *system*.
> This one certifies the *shop*: can an ordinary person walk in and use the
> whole business without finding a hole. Everything below was produced by
> driving the site, not by reading it.

**Owner decision honoured throughout: Apple Pay works.** It is treated here as
an existing checkout method, smoke-checked only. Its historical implementation
debate is not reopened, nothing about it was changed, and no stashed express
branch was touched.

---

## 0. What kind of evidence each claim rests on

Every finding below is tagged, because the difference matters and the previous
pass proved it: four separate "defects" in this audit turned out to be the
harness or the test, not the shop.

| Tag | Meaning |
|---|---|
| **PLAYWRIGHT** | A browser did it, on the local harness, as a person. |
| **PRODUCTION** | Observed against `www.vantalabsresearch.com`, read-only. |
| **DATABASE** | Queried against production Postgres, read-only. |
| **SOURCE** | Read from the repository. Never presented as customer-tested. |
| **HARNESS LIMIT** | Could not be proven here, and why. |

---

## 1. Baseline

| | |
|---|---|
| `origin/main` | `7ccbee89add352cefe91d84e68f07c089acc98ef` |
| Deployed SHA | `7ccbee89add352cefe91d84e68f07c089acc98ef` |
| Deployment | `dpl_FMEUsKtfYPFsfox3hr1bGrCKTC7Q` |
| Production == main | **YES** |
| Certification branch | `claude/certification` (this work, not yet deployed) |

**Feature flags, read from source:** `EXPRESS_OFFER_PARITY` and
`NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED` govern the express lane. Per the owner's
decision these are left exactly as they are and are not re-litigated here.

**Automation ownership, verified live not assumed (§26):** all **nine** Omnisend
automations remain `isEnabled: false` — VL · Welcome offer, Sunset, Win-back,
Replenishment, Post-purchase, Browse abandonment, Abandoned checkout,
Abandoned cart, Welcome. Last modified 2026-09-16/17; nothing has changed since
the previous audit. Every one carries
`sendingThresholds: {email: "subscribed", sms: "subscribed"}`, and every SMS
block carries `isStopKeywordIncluded: true`. **So there is no double-send risk
today: Omnisend sends nothing and the in-house system owns every live flow.**

> **Worth knowing before you enable any of them.** Five of the nine
> (Welcome offer, Win-back, Abandoned checkout, Abandoned cart, Welcome) contain
> `sendSms` blocks. Enabling those couples the email flow to the SMS channel.
> With zero consented SMS contacts nothing would actually send, but the coupling
> is there and should be a deliberate choice rather than a surprise.

---

## 2. The harness this was driven on

Two things had to be fixed before any coverage claim meant anything, and both
are worth recording because either would have produced a confident, false
certification.

**The harness catalogue was a 16-product seed; production has 34 live products
and 46 doses.** "Every live product covered" against that seed would have
certified a shop that does not exist. The production catalogue — products, doses,
prices, stock, images — was loaded into the local harness and the four
harness-only fixtures disabled, so the browser now walks the real shop:
**34 live products, 46 doses, matching production exactly.**

**The harness runs over HTTPS**, per the project runbook: `tls-proxy` on 3443 and
`gotrue-tls-proxy` on 54443, because the session cookie is `Secure` and the
browser's Supabase client would otherwise be mixed content. Driving plain http
produces failures that look like broken auth and are not.

---

## 3. The matrix

`scripts/qa-cx-matrix.mjs` (apparatus) and `scripts/qa-cx-run.mjs` (the people).
A scenario is a **person with a state, a device and an intent**.

Two design decisions carry the weight:

- **The catalogue is discovered at run time** from the database the app is
  serving. Add a product tomorrow and it is covered without editing the file.
- **The prize table is parsed from `prize-table.ts`**, and the run **refuses to
  start** unless it reads exactly sixteen wedges. A certification built on a
  stale copy of the wheel certifies a wheel nobody is spinning.

**All sixteen wedges are exercised as the customer who won them** — the offer row
the real draw writes is minted, and the journey from that point is entirely real
(same server code, same quote, same till). The draw itself is a separate
scenario. Nothing touches randomness.

**222 scenarios executed. 222 PASS. 0 FAIL. 0 not safely testable.**

| | |
|---|---|
| Live products | **34** |
| PDP coverage | **34 / 34** |
| Cart coverage | **34 / 34** |
| Live doses exercised | **46** |
| Wheel wedges exercised | **16 / 16** |
| Devices | phone 390×844, desktop 1280×900 |

| Group | Pass | Fail |
|---|---|---|
| a11y | 4 | 0 |
| account | 2 | 0 |
| affiliate | 2 | 0 |
| cart | 10 | 0 |
| cart-all | 34 | 0 |
| catalog | 1 | 0 |
| checkout | 6 | 0 |
| compliance | 3 | 0 |
| confused | 7 | 0 |
| desktop | 4 | 0 |
| gate | 19 | 0 |
| home | 4 | 0 |
| in-app | 4 | 0 |
| mobile | 6 | 0 |
| network | 4 | 0 |
| nowheel | 3 | 0 |
| pdp | 34 | 0 |
| security | 5 | 0 |
| variants | 36 | 0 |
| wheel | 2 | 0 |
| wheel-min | 6 | 0 |
| wheel-prize | 26 | 0 |

Every one of the sixteen wedges is exercised as the customer who won it, and the
two whose journey differs — the four-dose GLP wedges and the two-dose HGH wedge —
are exercised per dose. `wheel-min` covers the minimum-spend rules; `nowheel`
covers the shopper who never span.

### Per product

| Product | Doses | PDP | Variants | Cart | Mobile |
|---|---|---|---|---|---|
| 5-Amino-1MQ (`5-amino-1mq`) | 1 | PASS | n/a | PASS | via sweep |
| B12 (`b12`) | 1 | PASS | n/a | PASS | via sweep |
| BPC-157 (`bpc-157`) | 2 | PASS | PASS | PASS | via sweep |
| BPC-157 + TB-500 (`bpc-157-tb-500`) | 1 | PASS | n/a | PASS | via sweep |
| Cagrilintide (`cagrilintide`) | 1 | PASS | n/a | PASS | via sweep |
| CJC-1295 + Ipamorelin (`cjc-1295-ipamorelin`) | 1 | PASS | n/a | PASS | via sweep |
| CJC-1295 no DAC (`cjc-1295-no-dac`) | 1 | PASS | n/a | PASS | via sweep |
| DSIP (`dsip`) | 1 | PASS | n/a | PASS | via sweep |
| Epithalon (`epithalon`) | 1 | PASS | n/a | PASS | via sweep |
| GHK-Cu (`ghk-cu`) | 1 | PASS | n/a | PASS | via sweep |
| GHRP-2 (`ghrp-2`) | 1 | PASS | n/a | PASS | via sweep |
| GLOW (`glow`) | 1 | PASS | n/a | PASS | via sweep |
| GLP-1 (`glp-1`) | 4 | PASS | PASS | PASS | PASS |
| GLP-2 (`glp-2`) | 4 | PASS | PASS | PASS | via sweep |
| GLP-3 (`glp-3`) | 4 | PASS | PASS | PASS | via sweep |
| HCG (`hcg`) | 1 | PASS | n/a | PASS | via sweep |
| HGH GH-191 (`hgh-gh-191`) | 2 | PASS | PASS | PASS | via sweep |
| IGF-1 LR3 (`igf-1-lr3`) | 1 | PASS | n/a | PASS | via sweep |
| Kisspeptin (`kisspeptin`) | 1 | PASS | n/a | PASS | via sweep |
| KLOW (`klow`) | 1 | PASS | n/a | PASS | via sweep |
| KPV (`kpv`) | 1 | PASS | n/a | PASS | via sweep |
| L-Carnitine (`l-carnitine`) | 1 | PASS | n/a | PASS | via sweep |
| LIPO-C (`lipo-c`) | 1 | PASS | n/a | PASS | via sweep |
| MOTS-C (`mots-c`) | 1 | PASS | n/a | PASS | via sweep |
| MT-2 (`mt-2-melanotan-ii`) | 1 | PASS | n/a | PASS | via sweep |
| NAD+ (`nad`) | 2 | PASS | PASS | PASS | via sweep |
| PT-141 (`pt-141`) | 1 | PASS | n/a | PASS | via sweep |
| Recon water (0.9% Benzyl Alcohol) (`recon-water`) | 1 | PASS | n/a | PASS | via sweep |
| Selank (`selank`) | 1 | PASS | n/a | PASS | via sweep |
| Semax (`semax`) | 1 | PASS | n/a | PASS | via sweep |
| SNAP-8 (`snap-8`) | 1 | PASS | n/a | PASS | via sweep |
| SS-31 (`ss-31`) | 1 | PASS | n/a | PASS | via sweep |
| Tesamorelin (`tesamorelin`) | 1 | PASS | n/a | PASS | via sweep |
| Thymosin Alpha-1 (`thymosin-alpha-1`) | 1 | PASS | n/a | PASS | via sweep |

"Mobile: via sweep" means the product was covered at 390×844 by the visual crawl
below rather than by a dedicated phone scenario; GLP-1, the four-dose product a
customer is most likely to get wrong, has its own.

---

## 3a. The visual crawl

The behaviour matrix asks whether the shop *works*. This asks whether it looks
finished, which is the question a customer answers first — and a page can return
200, price correctly and add to the basket while a heading wraps into a button or
the phone layout scrolls sideways.

`scripts/qa-visual-qc.mjs` walks **53 routes at 390×844 and 1280×900 — 106 page
loads** — screenshots every one full-page, and measures what an assertion about
text cannot see: sideways scroll and the element causing it, controls rendered
outside the viewport, any control whose own centre is covered by something else
(asked of the browser with `elementFromPoint`, not guessed from overlap), tap
targets against WCAG 2.2 AA, images that resolved to nothing, text clipped by its
own container, and the number of distinct type sizes in use. It watches the wire
at the same time: console errors, page errors, failed requests, React hydration
mismatches, and any request fired more than twice.

**Result: 0 major, 0 minor.** No sideways scroll on any route at either width. No
hydration mismatch, no uncaught error, no failed request that was not this
harness. Everything it did find is in §4, fixed or explained.

Harness artifacts are **named, not counted**. This harness points
`NEXT_PUBLIC_SUPABASE_URL` at a local TLS proxy, so `next/image`'s
`remotePatterns` — narrowed deliberately against SSRF — refuse the real storage
host and every product photo answers 400. That is the guard working; production
serves the same images 200. Likewise `ERR_ABORTED`: a crawler that screenshots
and moves on after 1.5s cancels every prefetch and stream still in flight, which
a customer who reads the page does not.


---

## 4. Findings

Nothing in this section is a guess. Each item says how it was established and,
where it was fixed, what the browser said afterwards.

### F-1 · The harness was certifying a different shop — **FIXED**

`inventory.tracking_enabled` has been **true** on production since 2026-08-25.
The local harness carried four control rows and had it unset, which defaults to
**false** — `inventory-settings.ts` fails open so an unreadable setting can never
make the whole catalogue unpurchasable.

With tracking off, `resolveStockStatus` returns "In Stock" for every row. So
**MOTS-C — zero units, correctly refused on production — was addable in the
harness**, and a browser scenario asserting "reaches the cart" passed for the
wrong reason. Every stock claim made against that harness was answering a
different question from the shop.

`scripts/harness-seed-controls.sql` now mirrors production's customer-facing
settings — stock tracking, shipping thresholds ($15 flat / $200 free, $25 / $400
North America), referral percentages, welcome offer (off), promotions (all BXGY
disabled), payment methods — and `setup-local-harness.sh` applies it and then
asserts tracking is on. **No secret is seeded**: production also stores an API
key, an SMTP password, a fulfilment key and a webhook secret in that table, none
of which belong in a repository and none of which the harness needs.
— **DATABASE + PLAYWRIGHT**

### F-2 · Two browser checks were clicking the wrong product — **FIXED**

Exposed the moment tracking went on. `addToCartFromPdp` and the PDP probe both
scanned the whole document for an enabled "Add to Cart", and **every product page
carries a Related Products rail full of live ones for other items**. For an
in-stock product the page's own control comes first and the search was right by
luck; for an out-of-stock product that control is disabled, the search fell
through to the rail, and the run reported MOTS-C as *addable* and then as
*ADDED* — having clicked a different product entirely.

The page was correct throughout: both its controls are gated on `isOutOfStock`
and read "Currently Unavailable" / "Unavailable". They now carry `data-vl-cta`
so a check can address them, and the assertions run in both directions — in
stock **must** be addable, out of stock **must** be refused.
— **PLAYWRIGHT**

### F-3 · `products.stock_status` is a stale copy — **HARDENED, no behaviour change**

Three of the thirty-four live products disagree with their own doses: **DSIP**
and **SS-31** store "Out of Stock" while their doses hold 19 and 18 sellable
units; **MOTS-C** stores "In Stock" with none. All forty-six doses are
internally consistent — 45 declaring `track_inventory`, 0 null quantities,
exactly one tracked dose at zero, 0 stocked-but-labelled-out, 0
empty-but-labelled-in.

**No customer saw the stale copy.** Every live product has an enabled default
dose, and `defaultDose?.stockStatus ?? row.stock_status` reaches the column only
when the dose's own status is nullish, which a mapped dose never is. The
storefront already agreed with the shelf.

It agreed by accident of `??` ordering rather than by rule, so the rule is now
stated outright: with a dose present the headline **is** that dose's
already-resolved status; the column is read only for a product with no dose at
all. An earlier draft of this change also hardened `resolveStockStatus` against
the store-wide flag — **that half was reverted.** The flag is the documented
rollback if stored counts ever strand the catalogue and it has to keep working
for every row, including the 45 that count themselves.

**The three product rows are still stale.** They are inert for display and
correcting them is a data edit to production, which is the owner's to make.
— **DATABASE + SOURCE**

### F-4 · The footer sat under the fixed CTA bar on a phone — **FIXED**

At 390×844, scrolled to the very end, the last two footer lines were permanently
underneath the bottom bar — the copyright, and on `/checkout` and every product
page the **`support@vantalabsresearch.com` link**, a live mailto a customer
scrolls to the bottom to find and could not tap at any scroll position. Measured
on `/checkout` (146px bar), every PDP (82px) and every account page (65px).

The footer now reserves `10rem` below `lg`, where those bars render. The surplus
under a 65px bar is dark space below the last line of a dark footer.
— **PLAYWRIGHT**

### F-5 · Tap targets below the standard — **FIXED**

Measured at 390×844 against WCAG 2.2 AA (2.5.8), which sets 24×24 CSS px — not
the 44px platform guideline, which is AAA.

| Control | Was | Now |
|---|---|---|
| Header account / cart / menu | 40×40 | 44×44 |
| Offer bar "···" (the only route to the other offers) | 32×32 | 44×44 |
| Account "View all →" / "Shop all →" / "All →" ×4 | 28×16 and 28×24 | 44 tall, row height unchanged |
| `/sms` Privacy Policy · Terms | 37×18 | 24 tall, paragraph reflows identically |

The account links use `min-h-11` with `-my-2.5`, so the hit box is 44px while
the margin box stays 24px and the four heading rows are pixel-identical. The
site footer's own links stay at 24px: that is a deliberate, documented choice
that **meets AA**, and the inline legal links are expressly exempt from 2.5.8
anyway — the padding there is a courtesy, not a correction.
— **PLAYWRIGHT**

### F-6 · Three components read `/api/offer/status` at mount — **REPORTED, not changed**

`/cart` mounts the cart page, the cart drawer and the spin prize bar, and each
reads the endpoint for itself with `cache: "no-store"` — a prize won on another
device has to appear immediately, so none of them may read a cache. Three
requests, bounded by the number of components; a render loop would climb without
limit and this does not.

Worth collapsing behind one shared read. **Not done here**: it is a refactor of
the reward-display path across three files, and reward ownership is exactly what
this pass was told not to destabilise. — **PLAYWRIGHT**

### F-7 · `/api/catalog/promotions/eligibility` is rate limited per IP — **OWNER ITEM**

10 requests per 10 minutes per IP, deliberately: the endpoint takes an arbitrary
email and at 30/minute was a usable existence oracle (AUTH-4). A real shopper
fires it **once per hard page load**, and the App Router keeps the cart provider
mounted across soft navigations, so an ordinary session costs one or two. The
429s in this crawl are the crawl's own — 106 cold loads from one address in a
few minutes.

**The case that is not the crawl:** several shoppers behind one address — a
mobile carrier's CGNAT, an office — share that bucket. A throttled cart falls
open to the store-wide list, which is the safe direction *today* because every
BXGY promotion is disabled and none carries a per-customer limit, so the
endpoint returns an empty list regardless. **Before enabling a promotion with a
per-customer limit**, key the limit by session rather than by IP, or raise it:
otherwise a throttled cart could preview a promotion the server drops, and
payment-service refuses the order with "Altered total detected".
— **SOURCE + PLAYWRIGHT**

### F-8 · Photography — **OWNER SUPPLY, unchanged**

Four of thirty-four live products have no image at all and fall back to the
Vanta Labs mark: **BPC-157, GLP-2, GLP-3, Recon water**. Fourteen of forty-six
dose variants have none: BPC-157 (1 of 2), GLP-1 (3 of 4 — 10/20/30mg), GLP-2
(4 of 4), GLP-3 (3 of 4), HGH GH-191 (36iu), NAD+ (1000mg), Recon water (1 of 1).

The fallback renders correctly everywhere it appears — the crawl found no broken
element, only the deliberate placeholder. **Recon water is a wheel prize**, so a
winner is shown a placeholder for the thing they just won. Nothing was generated
or substituted; these are photographs the owner supplies. — **DATABASE + PLAYWRIGHT**

---

## 5. Things that looked like defects and were not

Recorded so this is auditable rather than merely quotable. **Every one of these
would have shipped to the owner as a defect had it not been checked.**

**The gate is broken — `/` returns 200.** That probe hit `vantalabs.co`, a
Squarespace "Coming Soon" page that is not the store. The real host is
`www.vantalabsresearch.com`, where `/` is 307. — **PRODUCTION**

**Every product image is broken.** The harness's Next image optimizer returns
`400 "url" parameter is not allowed` for every product photo. That is
`next.config.ts` deriving `images.remotePatterns` from
`NEXT_PUBLIC_SUPABASE_URL` — a deliberate anti-SSRF narrowing — and this
harness points that variable at the local gotrue proxy, so the optimizer
correctly refuses the real storage host. **Production serves the same image
`200`** (23,107 bytes). The guard was doing its job. — **PRODUCTION**

**Two doses of one product merge into a single cart line.** They do not. The
"Most Popular" dose button's text is `"10mg★ Most Popular"`, and the test's
exact-match picker never selected it, so the first dose was added twice. The
cart was right all along: lines are keyed `slug::variantId`, and two doses make
two lines. — **PLAYWRIGHT**

**The cart is empty after every add.** The helper read a `GET /api/cart` that
does not exist. The cart lives in `localStorage` under `vanta-labs-cart`; the
server sees it only at quote and checkout. — **SOURCE + PLAYWRIGHT**

**The affiliate link sets no referral cookie.** Production sets
`vl_referral_code=DREW; Secure; SameSite=lax; Max-Age=2592000` correctly. `DREW`
simply does not exist in the harness database, and `/r/[code]` deliberately
plants no attribution for a code it cannot resolve. — **PRODUCTION**

**The affiliate hop is a broken redirect.** `/r/[code]` redirects to
`new URL(safeNext, url.origin)` — same-origin by construction, which is the
open-redirect guard a widely-shared public link needs. Behind the harness TLS
proxy the origin Next sees is the plain-http backend, so the browser is sent to
an `https` URL on an http port. Production: `307 →
https://www.vantalabsresearch.com/products`. — **PRODUCTION**

**The portal is missing its 21+ attestation.** It says *"I confirm I am 21 years
of age or older"*; the test's regex looked for three other phrasings. The page
was right. — **PLAYWRIGHT**

**Percent and free-shipping wedges cannot be minted.** `customer_offers_quantity_shape`
refuses a `quantity` without a `product_slug` — the database declining to hold
"one of nothing". The minter was wrong, not the schema. — **DATABASE**

**A stale `products.stock_status` is being shown to customers.** It is stale on
three rows and it is not being shown. Production runs with inventory tracking
**on**, every live product has an enabled default dose, and the dose's own
resolved status shadows the column. The first draft of this pass asserted the
opposite and hardened two code paths on that basis; half of it was reverted and
the rest restated. Getting this wrong in the store's favour would have been the
easier report to write. — **DATABASE + SOURCE**

**The MOTS-C product page offers an enabled Add to Cart while saying
"Out of Stock".** The enabled buttons were on the **Related Products** rail —
other, in-stock items. The page's own control was disabled and read "Currently
Unavailable" throughout. The check was scanning the whole document. — **PLAYWRIGHT**

**Every product card has a button sitting on top of a link.** The wishlist heart
is deliberately positioned over the card, sits above it, and works. Overlap is a
design decision; being *underneath* something is the defect. The probe now asks
`elementFromPoint` who receives the click rather than comparing rectangles. — **PLAYWRIGHT**

**The header search input is covered by a button.** The search is *closed*: an
8px-wide input with `aria-hidden` and `tabindex="-1"`, behind the icon that opens
it. That is the collapsed state, not a broken one. — **PLAYWRIGHT**

**Every link on `/products` is unclickable.** An offer modal was open, and a
modal's backdrop makes everything behind it inert on purpose. — **PLAYWRIGHT**

**The skip link is clipped and rendered off-screen on all 106 loads.** It is
parked at `-9999px` in a 1×1 box and becomes visible on focus. That *is* the
pattern — and it is this audit's own accessibility fix being reported as a
defect by this audit's own crawler. — **PLAYWRIGHT**

**The site footer's links fail the tap-target standard.** They are 24px, which
**meets** WCAG 2.2 AA (2.5.8, 24×24 CSS px) and says so in its own comment. The
44px figure is iOS HIG / WCAG AAA. Grading against the wrong line reported a
deliberate, conforming decision as a fault on every page. — **PLAYWRIGHT**

**253 console errors and 96 aborted requests.** The console errors are Chromium
echoing the *same* image-optimizer 400s already counted as network events —
double-counting one artifact. The aborts are a crawler screenshotting and moving
on after 1.5s, which cancels every prefetch and stream in flight. A customer who
reads the page for two seconds sees neither. — **PLAYWRIGHT**

**A 10%-off `JOURNEY10` offer is advertised sitewide.** That coupon exists only
in the harness, alongside three other QA fixtures. Production advertises **no**
public coupon: its only active codes are single-use `SAVE-…` cart-recovery
grants, and `publicCoupons()` excludes any row with an `assigned_email` in SQL
rather than in JS, precisely so a code minted for one shopper never reaches a
browser even as data. — **DATABASE**

---

## 6. §34 — the postage/margin order, root-caused

`VL-E8F4D52F` was carried as "margin overstated by the label cost". That was
wrong, and wrong in the store's favour to report.

**Root cause.** Of 16 shipped orders, 15 carry an actual cost from Shippo. The
exception's row explains itself: `shippo_transaction_id` NULL,
`label_purchased_at` NULL, `shipped_at` NULL, **tracking number present**. It was
shipped by hand with a carrier number pasted in. `actual_shipping_cost_cents` is
written only by `recordActualShippingCost`, which only runs off a label
**purchase** — so there was never a figure to write, and no sweep can repair it
because there is no transaction to ask about.

**Classification: isolated historical omission with a structural cause, not an
ongoing defect.** 15/15 label-bought orders since have captured their cost.

**Real exposure.** The engine does not book a missing cost as zero. It
substitutes the configured `$6.00` estimate and flags
`profitStatus: "estimated"`. Against a comparable-order actual range of
`$5.48–$11.50` (median ≈ `$7.10`), that is **≈ $1.10 understated on one order**,
labelled as an estimate.

**Detection added.** `admin-profit-shipped-without-a-label.test.ts` (4 tests)
pins the overlay decision that protects the whole class. Nothing pinned it
before — `order-profit.test.ts` covers the pure function's handling of an
estimate it is *handed*, and `admin-profit-schema-contract.test.ts` builds a
NULL overlay and never asserts what comes out. Rewriting three lines as
`(overlay?.actualShippingCostCents ?? 0) / 100` would have booked full margin on
every hand-shipped parcel with the suite still green.

**Scan of all shipped orders: 1 affected, 15 clean.** — **DATABASE**

---

## 7. Photography — the real picture

Settles the long-open item, measured rather than estimated. — **DATABASE**

**4 of 34 live products have no image at all:**

| Product | Price | Note |
|---|---|---|
| BPC-157 | $39.99 | |
| GLP-2 | $49.99 | |
| GLP-3 | $49.99 | |
| Recon water | $14.99 | **also a wheel prize** |

**14 of 46 dose variants have no image:** BPC-157 (1 of 2), GLP-1 (3 of 4 —
10/20/30mg), GLP-2 (4 of 4), GLP-3 (3 of 4), HGH GH-191 (1 of 2 — 36iu),
NAD+ (1 of 2 — 1000mg), Recon water (1 of 1).

Every image that *is* on file resolves through production's optimizer. This is a
content gap, not a software defect — but Recon water is a wheel prize, so a
winner is shown a placeholder for the thing they just won.

---

## 8. Abandoned cart — carried forward unchanged

The prior finding stands and is not re-derived here: this is a **marketing
performance** problem, not a software defect. The click tracker is proven alive
(campaigns record 8 clicks on 213 sends through the same route; recovery records
2 on 176). Recovery mail is opened at nearly double the campaign rate and
clicked at under a third of it.

**And the "recovered" figure attributes nothing.** Of 20 recovered carts, 10 were
never mailed at all before ordering, 0 clicked a recovery email, and 0 used the
restore link. Not one can be credited to the programme.

**Do not call raw recovered carts email-generated revenue.** The programme was
not changed.

---

## 9. Verdict

**PASS.**

### What was run

| | |
|---|---|
| Customer scenarios | **222 executed, 222 PASS, 0 FAIL, 0 not safely testable** |
| Live products — PDP | **34 / 34** |
| Live products — cart | **34 / 34** |
| Live doses | **46**, every one priced and added as itself |
| Wheel wedges | **16 / 16**, each as the customer who won it |
| Visual crawl | **53 routes × 2 devices = 106 loads — 0 major, 0 minor** |
| Unit / integration suite | **776 files, 11,892 tests passed**, 11 skipped, **0 failed** |
| Typecheck | `tsc --noEmit` — **clean** |
| Lint | **0 errors** (54 pre-existing warnings) |
| Production build | **succeeds** |

### What was fixed in this pass

The harness was made to match the shop (F-1), two browser checks were made to
click the right product (F-2), the dose was made the stated authority for stock
rather than the incidental one (F-3), the footer was lifted off the phone CTA bar
so the support link is reachable (F-4), and five sets of tap targets were brought
to standard (F-5). Four accessibility fixes from the previous pass — one `main`
landmark on `/spin`, a skip link that moves focus, reduced-motion that removes
the animation and nothing else, and `aria-pressed` on the dose and quantity
pickers — are verified to have changed **no** product selection, price, wheel
result, reward ownership, minimum or checkout behaviour: the wheel-prize group is
26/26 and the checkout group 6/6 with them in place.

### What was deliberately not touched

- **Apple Pay.** The owner's decision stands: it works. Smoke-checked as an
  existing method, architecture unchanged, no stashed express branch merged.
- **The wheel.** Sixteen wedges, the same economics, the same campaign. It was
  not replaced with a 15% offer.
- **Omnisend.** All nine automations verified still `isEnabled: false` and left
  that way. Five of them contain `sendSms` blocks — enabling those couples email
  to SMS, and should be a deliberate choice rather than a surprise.
- **`/sms`, consent behaviour, Privacy, Terms, the gate.** No copy or behaviour
  changed. The only edit anywhere near them is 3px of vertical padding on two
  inline legal links, which changes no text and reflows nothing. Twilio remains
  an external owner/provider item.
- **Abandoned cart.** Not redesigned. The finding stands: the software path
  works and measured click-attributed recovery is zero.
- **`VL-E8F4D52F`.** Not altered. It is a hand-shipped parcel with no label
  purchase, so there was never a cost to write; the engine books the configured
  $6.00 estimate and flags it as an estimate. Exposure ≈ $1.10 on one order.
- **Production data.** Nothing was written. The three stale `products.stock_status`
  rows are the owner's to correct in admin.

### What needs the owner

1. **Photography** — 4 products and 14 dose variants have none and show the
   Vanta Labs mark. Recon water is among them and is a wheel prize. Nothing was
   generated or substituted.
2. **Three stale product rows** — DSIP and SS-31 read "Out of Stock" over 19 and
   18 sellable units; MOTS-C reads "In Stock" with none. Inert for display, but
   worth correcting so the admin view tells the truth.
3. **Before enabling a per-customer-limited promotion**, re-key the
   eligibility rate limit by session rather than by IP (F-7).
4. **SMS** — Twilio 10DLC remains blocked pending the current rejection reason.
   There is no consented audience, so nothing is waiting to send.

### The bar this meets

No remaining customer-critical, pricing, reward, inventory, fulfilment, consent
or security issue was found. Every claim above is tagged with how it was
established, and the eleven things that looked like defects and were not are
recorded in §5 rather than quietly dropped — including three that this audit's
own instruments manufactured.
