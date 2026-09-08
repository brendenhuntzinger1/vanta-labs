# Abandoned-cart recovery: audit and redesign

Written 2026-09-07. Evidence is from production (`mlpimwgkwuqpsvsrlpqv`) and the
code as shipped on `main`.

## The number that started this

Real customers only — the owner's own test carts (`btunchi88@`,
`brendenhuntzinger1@vantalabsresearch.com`) excluded:

| Status | Carts | Value | Emails | Clicks |
|---|---|---|---|---|
| active | 13 | $3,007.71 | 23 | **0** |
| expired | 4 | $687.94 | 16 | **1** |
| recovered | 2 | $304.93 | 2 | **0** |

**41 emails, one click, zero click-attributed recoveries.** Both recoveries
happened without email engagement: Neil Hidalgo bought after *zero* emails were
sent; Abrianna Jacobi received two, opened neither, and bought anyway.

Open rate is not a usable counter-signal. Heath Greve's t12h "open" is stamped
seven seconds after the send; Nikki R's t30m and t12h are stamped at the same
millisecond. Those are Gmail/Apple image prefetches, not reads.

So the programme has no demonstrated incremental effect, and richer discounts
bolted onto it would mostly have subsidised customers who were going to buy
anyway.

---

## Findings

### F-1 (P0). A customer who clicks a recovery email can land in a cart that cannot check out

The failure chain, each link verified in the code:

1. `GET /api/cart/restore` returns `cart.items` **verbatim from the
   `abandoned_carts` snapshot**. It does not reconcile against the catalogue.
2. `POST /api/cart/validate` checks *inventory*, not existence, and states its
   policy explicitly: *"A row we cannot find is left alone rather than zeroed —
   an unknown line is a lookup gap, not a sold-out product."* The dead line
   survives.
3. `quoteOrder` (quote-order.ts:557) throws `Invalid product id: <slug>` for a
   line whose slug has no product row — and that throw fails **the entire
   quote**, not just the line.

So the shopper is walked from the email into a cart that refuses to check out,
with an error naming a slug, and no way to self-serve past it.

This is live. `bacteriostatic-water` has no `products` row (only `bac-water`
does), and two active carts hold it right now: Eli ($59.98) and Eloá Rossetti
($227.46). Both were repaired by hand on 2026-09-06 and **both reverted** when
the shopper's browser next wrote the cart — the repair holds only until the
client posts the stale slug again, which proves the write path is still
producing it.

The recovery email is the one thing that reliably drives these shoppers back to
that cart. Fixing the offers without fixing this would spend money to deliver
customers to a dead end.

### F-2 (P0). Cart-recovery clicks are not attributed at all

`marketing-source.ts` is a good, deliberate module: one primary channel per
order, ranked `offer_redeemed > click > recovery_coupon > referral_code >
ad_touch > organic`. But the `click` tier reads only the **automation** and
**campaign** cookies. Cart recovery appears solely at the `recovery_coupon`
tier — i.e. an order is credited to cart recovery *only if it used a `SAVE-`
code*.

Stages 1–3 carry no coupon. A shopper who clicks the t30m email and checks out
ten minutes later is recorded as **organic**. The programme therefore cannot
demonstrate incremental value even when it works, and today's "2 recovered"
figure counts a customer who received no email at all.

### F-3. Two of the four emails are the same email

- t30m — subject *"We kept your cart"*, body *"You left these in your cart. We
  have held them for you, at the same price."*
- t12h — subject *"Your cart is still saved"*, body *"A quick note that your
  cart is still saved."*

Same message, same CTA label ("Return to my cart"), no new information, no
reason to act. One of four touches is spent restating the previous one.

### F-4. The cart in the email is a text list

`cartItemsHtml` renders `name × quantity` and nothing else — no product image,
no per-line price, no thumbnail. On a store whose recovery carts average ~$230
and run to $520, an image-free list is the single largest CRO gap in the
message. The catalogue already holds `image`, `price_cents`, `purity_result`,
`batch_number`, `lab_name`, `coa_url` server-side, all safe to render.

### F-5. Nothing addresses the actual objection

These are first-time buyers of research compounds at a $250 median. Their
hesitation is *is this real, is it tested, will it arrive*. Only t24h touches
that, and it does so as a newsletter (*"Before you order: testing, shipping,
support"*) with no purchase intent.

### F-6. The offer ladder is upside-down against the live promotion

t72h carries 5% and nothing else. Buy 2 Get 1 is live through Sep 14 with
`stackWithCoupon: false`, and the store applies exactly one discount, greatest
wins. B2G1 is worth 25–33% on a qualifying cart, so **the recovery coupon is
worth $0 on precisely the largest carts** and only bites on single-unit ones.
Measured: 10% is worth $0 to Heath and to Nikki.

A free product does not have this problem — `quoteOrder` adds the gift line
independently of the discount slot, so it lands whether or not a promotion is
running.

### F-7. No segmentation

Every cart gets the same four emails regardless of value, customer history,
whether an incentive would change the decision, or whether the shopper has
abandoned before. Robin Lagrama has been through two full sequences — eight
emails, eight opens, one click, no purchase — and would receive an identical
third.

### F-8. Measurement stops at open/click rate

`getCartRecoveryStats` is careful about revenue (net, ledger-based, excludes
orders credited elsewhere) but the funnel it reports is sent → opened → clicked
→ recovered. There is no restored-cart count, no checkout-start count, no
incentive cost, and no gross profit — so "did this pay for itself" is not
answerable, and open rate (contaminated, per above) is doing work it cannot do.

### What is already good, and is being kept

- `reserveAndSendStage`'s claim-first-then-mint ordering (defect C-06) and the
  unique index on `(abandoned_cart_id, stage)`.
- The frequency guard, the week-long sequence cooldown, `quietFamilyFor`.
- Suppression checked before claim and before mint, re-checked each sweep.
- `recoveryEmailItems` rendering names from the catalogue, never from the
  client-posted beacon.
- `marketing-source.ts`'s one-channel-per-order discipline.
- The `customer_offers` entitlement system and its `issueCustomerOffer` /
  `reserveCustomerOffer` locking.
- `renderLayout`'s email shell: 520px, viewport meta, preheader span, tables.

None of that is being rebuilt.

---

## F-0 (the biggest one, found in the browser). The recovery link lands on a sign-in page

Reproduced against the local harness on 2026-09-07:

```
/api/email/track/click?...   -> 307  (public: the click IS recorded)
/cart/restore?id=<uuid>      -> 307  /account/login?next=%2Fcart%2Frestore%3Fid%3D...
/cart                        -> 307  /account/login?next=%2Fcart
```

`src/lib/access-policy.ts` makes the whole store account-only by default: a path
is reachable without a session only if it is on a short named list, and neither
`/cart` nor `/cart/restore` is. `/api/email` **is** on that list, so the click
tracker answers, stamps `clicked_at`, and redirects the shopper — into the wall.

This explains the data exactly. Clicks are recorded; conversions from them are
zero. Many of these shoppers are guests who only ever typed an email into the
checkout field, so they have no account to sign in to at all.

**This is a deliberate owner decision**, stated in that file with its SEO cost
spelled out, so it has NOT been changed here. But it caps cart-recovery
conversion at approximately zero, and no offer, subject line or template fixes
it. The narrow fix, if the owner wants it, is to treat `/cart/restore?id=<uuid>`
as self-authenticating — the same principle the codebase already applies to "an
unguessable order id" in `SELF_AUTHENTICATING_PREFIXES`. That is a security
decision and belongs to the owner, not to this change.

---

## The new sequence

The clock is unchanged: windows from last cart activity, one stage per cart per
sweep, a stage whose window closes is gone for good.

| Stage | Window | Job | Carries |
|---|---|---|---|
| 1 · t30m | 1–12h | Recall | Nothing |
| 2 · t12h | 12–24h | Proof / objection | Nothing |
| 3 · t24h | 24–72h | Add value | Free BAC Water |
| 4 · t72h | 72–96h | Last chance | Free BAC Water + 10% code |

**Why a gift before a percentage, and why a gift at all.** The store applies one
discount per order, greatest saving wins. A percentage therefore competes with
the live promotion and can lose outright — with Buy 2 Get 1 running, 10% was
measured worth exactly $0 on Heath's cart and on Nikki's, the two largest. A
free-product line is added by `quoteOrder` independently of the discount slot,
so the vial is worth its full $14.99 whatever else is running, and it costs one
vial of COGS against roughly $25 for 10% of a $250 basket.

**Why nothing on stages 1 and 2.** An incentive on the first reminder is an
incentive for having been interrupted, and it teaches the fastest lesson a store
can teach: abandon the cart and wait.

**Segmentation** (`cart-recovery-offers.ts`, pure and tested). No incentive to a
buyer inside their own 30-day reorder cycle; one gift per address per 30 days,
scoped so a cart's own stage-4 re-mint is not mistaken for a second gift; no
gift below a $35 cart. The message still goes in every case — only the incentive
is withheld.

## Emails

Each has one job now; stages 1 and 2 used to be the same message twice.

- Cart rows carry the product image, quantity and line price, all from the
  catalogue. Previously `name × quantity` as text.
- Stage 2 leads with the COA library and the batch number of the cart's
  highest-value line — rendered only when the catalogue actually holds one. A
  blanket "everything is tested" is false the moment one product has no report.
- Subjects name the product or the gift instead of the store.
- Stage 4 says "we use whichever saves you more, this code or any sale running",
  which is true in every case; promising the percentage outright is false
  precisely on the largest carts.

## Measurement

`getCartRecoveryFunnel()` reports sent → clicked → **restored** → purchases →
revenue → COGS → incentive cost → gross profit, split into **attributed** and
**self-serve** recoveries. Open rate is still reported but named
`openedUnreliable`. Two new nullable columns back it: `abandoned_carts.
restored_at` and `abandoned_cart_emails.variant`.

## A/B testing

`cart-recovery-experiments.ts`: variant assigned deterministically from the cart
id, stable across the whole sequence, recorded on the send row. Only the subject
and preheader vary — one axis at a time. Live on stages 1 and 3.

---

# Part two: the guest recovery grant (2026-09-08)

## Root cause of the guest-recovery failure

Three facts, each verified:

1. `access-policy.ts` makes the store **account-only by default** — a path is
   reachable without a session only if it is on a short named list.
2. `/api/email` **is** on that list (an unsubscribe link must work for anyone),
   so `/api/email/track/click` answered, stamped `clicked_at`, and redirected.
3. `/cart/restore`, `/cart` and `/checkout` are **not** on that list.

So the tracker recorded the click and then handed the shopper
`/account/login?next=/cart/restore?id=…`. Most recovery recipients are guests
who typed an email into the checkout field and never created an account, so
there was no account to sign into. **Clicks were recordable; conversions were
structurally impossible.** That is the exact shape of the production data: one
click in 41 sends, and no click-attributed recovery ever.

## Security design of the recovery credential

    v1.<cartId>.<expiresAtMs>.<hmac-sha256, truncated to 32 hex>

signed over `cart_recovery_grant:v1:<cartId>:<expiresAtMs>`.

| Requirement | How |
|---|---|
| High entropy / signed | HMAC-SHA256 over a namespaced payload, secret from `UNSUBSCRIBE_SECRET` (falls back to the service-role key) |
| Expiration | 14 days, **inside the signature** so a client cannot extend it; also refused if stamped further out than the TTL allows |
| Server-side validation | `verifyGuestRecoveryGrant`, timing-safe, null for every failure with no reason attached |
| Scoped to one cart | The cart id is inside the signature, **and** `/api/cart/restore` refuses a grant that names a different cart than the one requested |
| No other customer's cart | Repointing the id breaks the signature; a valid grant for cart B returns the same 404 as an unknown cart, so it is not an enumeration oracle |
| No general session | It sets no identity and no user id. The middleware consults it **only** for paths on a closed allowlist |
| No account/order/admin data | `/account/*`, `/api/account/*`, `/admin`, `/vault`, `/products` and `/` are all outside the allowlist and stay shut |
| Safe when tampered/expired/reused | Every failure is indistinguishable from "no grant", which lands on the ordinary sign-in wall. Repeat clicks are idempotent |
| Cart already converted | Items still restore; **no recovery code is armed**, because the cart is no longer active |

**Delivery.** The click route mints the grant (it already resolves the cart from
the reservation), sets it as an httpOnly `vl_cart_grant` cookie, *and* appends
it as `k=` on the redirect. Both, because corporate link rewriters (Outlook
SafeLinks and its kind) follow the redirect server-side and hand the browser
only the final URL — those recipients never receive the `Set-Cookie`. The
parameter is accepted on `/cart/restore` and `/api/cart/restore` **only**, is
exchanged there for the cookie, and is stripped from the address bar; `/cart`
and `/checkout` accept the cookie alone, so the token cannot be passed around
as a URL for the rest of the journey.

**Why not the raw UUID.** A database key appears in admin screens, logs, support
threads and CSV exports, and it never expires. Treating it as authentication
would mean anyone who ever saw one could open that cart for ever. The id stays
an identifier; the capability is a separate, expiring, unforgeable thing.

## Source fix for the bad BAC slug

The reconciliation at restore was treating a symptom. The **source** is that a
cart lives in `localStorage` and outlives a rename: every browser that had added
the vial before production moved `bacteriostatic-water` → `bac-water` kept
re-posting the old slug to the tracking beacon and into `abandoned_carts`. That
is why two hand-repaired carts both reverted within a day.

`sanitizeCartItems` — the function that reads the persisted cart — now maps each
stored slug through `canonicalCartSlug()`, and migrates the stored line `key`
with it. The stale value stops being written. Reconciliation stays as defence in
depth for carts stored before this shipped and for any future rename.

## RLS verification

The guest journey's data access is **entirely server-side through
`supabaseAdmin`** (service-role key), which bypasses RLS. The only browser-side
Supabase client is lazily loaded for referral-code validation and is not part of
this path. Verified against production with the live anon key:

| Table | anon read |
|---|---|
| abandoned_carts, abandoned_cart_emails, customer_offers, coupons, orders, order_items, products, admin_audit_logs | **HTTP 401 `42501`** — every one |

Security advisors after the migration: all `rls_enabled_no_policy` at INFO,
which is the intended deny-all posture (RLS on, no policies, no anon grants).
The two new columns sit on tables already in that state. The one WARN
(leaked-password protection) is pre-existing and unrelated.

**The grant cannot widen any of this**: it is an application-layer capability
checked in middleware, and it never reaches Postgres.

## What was driven end to end, and what was not

Driven in a real browser as a **guest with no session** (verified: `/products`
still redirected that browser to sign-in throughout):

| Step | Evidence |
|---|---|
| sent | `abandoned_cart_emails` row, `variant=a` |
| clicked | tracker stamped `clicked_at`, minted the grant, set the cookie, appended `k=` |
| restored | `restored_at` stamped; renamed slug repaired; dead line dropped with a notice; `k=` stripped from the address bar |
| checkout | `/cart` and `/checkout` reachable, $174.96 quote, desktop and 390×844 |
| purchase | `create-session` 200, order created, **`marketing_source_kind=cart_recovery`, `basis=click`, `ref=`the cart id** |
| self-serve control | a second guest with the recovery cookie cleared → `kind=(null)`, so the two never mix |

`basis=click` is the point: that order carried **no coupon**, and before this
change it would have been filed `organic`.

`scripts/qa-guest-recovery.mjs` runs the adversarial cases as a suite —
**34 checks, all passing**: no-grant wall, valid grant, cross-cart grant,
repointed id, flipped signature, expired grant, the bare UUID, the converted
cart, repeated clicks, the allowlist, and the restore stamp.

**Covered by unit tests rather than the browser**, because the harness cannot
mint a real GoTrue session: B2G1 alongside the gift, percentage-vs-promotion
competition, membership pricing and referral attribution
(`offer-gift-promotion`, `offer-percent-competition`, `member-pricing`,
`discount-*` — 100 tests). Their engine is the same `quoteOrder` the browser
run exercised.

## Harness/production parity fixed along the way

`setup-local-harness.sh` applied an explicit file list that was missing
`cart-recovery-stage-overrides`, `cart-recovery-measurement` and
`marketing-attribution` — so the harness had no `marketing_source_*` columns at
all and the attribution leg could not have been verified on it. All three are
now in the list.
