# Audit findings

Eleven parallel auditors went over consent compliance, who gets 15%, the
discount handoff, double opt-in, STOP/HELP, failure recovery, marketing
controls, flow mapping, template design, message overlap and the launch
handoff. They produced 106 findings, 24 of them at blocker severity.

**I did not take them at face value.** Audit findings routinely confuse "built"
with "wired up" with "actually enabled", and this system is almost entirely
dark. What follows separates what I reproduced myself from what I did not.

**None of it blocks the wheel campaign.** The wheel touches none of these
paths. Everything below is about the SMS and Omnisend launch.

---

## Confirmed — I reproduced each of these directly

### 1. Every SMS consent write fails silently in production

Four auditors found this independently, and it is the most serious thing here.

Production's `sms_subscribers` is keyed on **`phone_e164`** and has **no
`email` column**:

```
phone_e164, user_id, status, verified_at, verify_attempts, last_verify_at,
marketing_consent, marketing_consent_at, transactional_consent,
transactional_consent_at, double_optin_confirmed_at, consent_source,
disclosure_version, opted_out_at, opt_out_keyword, resubscribed_at,
resubscribe_count, line_type, carrier, timezone, created_at, updated_at
```

`src/lib/sms-consent.ts` selects it (`:72`), filters on it (`:165`) and inserts
it (`:217`). Every one of those fails with PostgREST 42703. The module is
documented as "never throws" and catches its own errors, so:

- `readByPhone` returns null
- `recordSmsConsent` returns false — **no consent row is written**
- `recordSmsOptOut` returns "failed" — **a STOP records nothing**

A carrier dispute would be answered with an empty table. **This must be fixed
before any SMS launch.** Note also that production's schema already carries
`double_optin_confirmed_at` and `verify_attempts` — it was designed for a
confirmation step the code does not implement.

### 2. There is no inbound SMS handler anywhere

`src/app/api/webhooks/` contains exactly three routes: `payment`, `email`,
`shippo`. There is no endpoint a carrier or Omnisend could POST an inbound
message to, no STOP/START/HELP keyword parser, and nothing that writes a
customer reply.

Keyword handling is therefore entirely Omnisend's and the carrier's, and **an
opt-out taken there never reaches the store's own suppression**. Combined with
finding 1, the store cannot record an opt-out by any route at all.

Your requirement was "STOP must suppress marketing, HELP must work, and
ordinary customer replies need a monitored inbox." None of the three is met
today.

### 3. The 15% code can be minted with no phone number at all

`PATCH /api/account/preferences` with `{"smsMarketing": true}` calls
`grantWelcomeOfferForConsent(address)` using only the signed-in email. The
store then holds a 15% first-order coupon for someone with **no phone number,
no `sms_subscribers` row, no `disclosure_version` and no `consent_source`**.

This path is also not behind the SMS kill switch.

### 4. Non-wheel gifts DO stack with the welcome code

I measured this rather than reading it. Same basket, same gift, only the
`offer_key` changed:

| offer_key | gift only | gift + 15% code | stacks? |
|---|--:|--:|---|
| `spin:winback_2026q4` | $134.99, vial | $116.99, **no vial** | no — code wins |
| `cart_recovery_bac_water` | $134.99, vial | **$116.99 AND the vial** | **yes** |
| `winback_60_free_ghkcu` | $134.99, vial | **$116.99 AND the vial** | **yes** |

The one-benefit rule in `quote-order.ts` is gated on the key starting with
`spin:`. Every other gift skips the conflict block entirely.

**Severity, honestly: dormant today.** Production has no welcome-source coupon
— 351 `cart_recovery` coupons and 42 unsourced, and zero `omnisend_welcome` or
`welcome_offer`. There is no welcome code for anyone to type, so nothing is
stacking right now. It becomes real the moment the SMS welcome offer ships.

### 5. No Omnisend tables exist in production

`omnisend_ledger`, `omnisend_sync_state` and the event ledger are absent. The
ledger fails **open**, so the duplicate-send and cart-event debounce protections
would not exist if `OMNISEND_API_KEY` were set before the migration ran. Inert
today because no key is set.

### 6. The hero is the homepage vial — but the product slots are real, and empty

**I got this partly wrong in my first pass and the adversarial verifier caught
it.** Correcting rather than quietly fixing:

What is true: the one *authored* hero image is the GHK-Cu home-page poster —
verified byte-identical to `public/images/hero-vial-poster.jpg` at 960×960 and
37,579 bytes. That is the graphic the brief said not to use, and it is used.

What I said and got wrong: *"no template uses per-product imagery at all."*
That is false. **20 of 34 templates carry three role-tagged `product_image`
blocks each — 60 authored product slots** (`scripts/omnisend/lib.mjs:209`,
built by `productSection()`), which Omnisend fills with a real catalogue
photograph per recipient at send time. Only 12 of 34 templates carry no image
block. My grep missed them because the mechanism lives in the `productSection`
helper, not as a hardcoded `imageUrl` in `templates.mjs`.

The real problem is different, and worse in a quieter way: **the Omnisend
product catalogue has never been synced.** A live read returns
`get_products → []` and `get_product_categories → []`, and rendering the live
`welcome-1` template back from the account returns, three times over:

```
<img alt="Product" src="https://preview.soundestlink.com/images/empty_image.png">
<p>Product</p>   $0.00   [VIEW]
```

So the seven product-recommender templates preview as **"Product / $0.00"**
against a grey placeholder. Not unfillable — unfilled. `syncOmnisendCatalog()`
exists, is registered on an admin route and on the sweep, and has 46 active
products to map. It has simply never been run.

Two smaller things worth carrying into the redesign:

- `isProductImagesFitted: true` (`lib.mjs:229`) **is silently dropped by
  Omnisend** — it is not in the current product-section schema. Reading the live
  templates back proves it: the sibling key `isOutOfStockHidden` survives and
  this one does not. The flag is inert.
- The catalogue photographs are **928×1152 portrait on a light-grey seamless**
  (measured border luminance ≈195/255) and the email background is `#0a0a0a`.
  Light product shots on a near-black field is a real composition problem for
  the redesign, not a bug.

### 7. Two Omnisend welcome flows never stop on purchase

`VL · Welcome` and `VL · Welcome offer` have `exitConditions: []`. Every other
flow exits correctly. Someone who subscribes and buys the next day still gets
*"Your welcome code: 15% off a first order"* on day three. All nine flows are
disabled, so this is pre-launch work, not a live incident.

---

## Reported by the audit, NOT independently verified

Plausible and consistent with what I saw, but I did not reproduce them. Treat
as leads, not facts:

- **No global "pause all marketing".** Reported as seven switches across five
  screens plus one env var and the Omnisend dashboard. The `OMNISEND_MARKETING_OWNER`
  switch stands the *store* down but does not stop Omnisend.
- **The SMS kill switch has no admin UI.** Readable and honoured in code, but
  changeable only by a direct database write.
- **Failed Omnisend syncs surface on no admin screen** — only in Vercel logs.
- **No interlock between the three switches.** Enabling the Omnisend flows while
  `OMNISEND_MARKETING_OWNER` is unset means both systems send at once.
- **`benefitChoice` is returned by the quote API and rendered by nothing.**
  (I did confirm no client sends it, so the choice is dormant — consistent with
  the checkout-choice work being paused.)

The adversarial verification stage was still running when this was written; its
verdicts are not reflected here.

---

## What this means

**For tomorrow's wheel campaign: nothing.** It uses the Resend campaign sender,
the spin tables and the existing offer machinery. It does not read
`sms_subscribers`, does not call Omnisend, and does not involve a welcome code.

**For the SMS launch: findings 1, 2 and 3 are hard blockers.** A consent system
that records nothing, cannot process a STOP, and hands out discounts to
phone-less accounts is not something to point a carrier review at. Fixing the
schema mismatch is one migration; the inbound handler is real work.

**For the Omnisend cutover: findings 5, 6 and 7**, plus the migration
verification already listed in `OMNISEND-MAPPING.md`.
