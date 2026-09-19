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

<!--MATRIX_RESULTS-->

---

## 4. Findings

<!--FINDINGS-->

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

<!--VERDICT-->
