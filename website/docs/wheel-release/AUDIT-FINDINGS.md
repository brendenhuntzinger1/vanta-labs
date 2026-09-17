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

### 6. The templates use the homepage vial, and no product photography

Every image-bearing Omnisend template uses one hero — the GHK-Cu home-page
poster, the exact graphic you said not to use. **No template uses per-product
imagery at all**, so a cart email about GLOW shows a GHK-Cu vial. The product
images are already synced by `catalog-payload.ts`; the templates simply never
reference them.

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
- **The Omnisend product catalogue is empty in production**, so any recommender
  grid would render "Product / $0.00".
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
