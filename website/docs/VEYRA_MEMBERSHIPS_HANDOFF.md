# Veyra recurring memberships — state + remaining build

Written 2026-08-02. Items 3 and 4 are landed on `claude/veyra-memberships`.
Read this before touching membership billing.

## Why memberships never transacted

Not a missing provider. **The membership signup captures no card at all.**

```ts
export interface StartMembershipSignupInput {
  userId: string; tierId: string; billingCycle: "monthly" | "annual";
}
```

`billing-provider.ts` only ever had `noop` (fails honestly) and `mock` (fake
success). The whole state machine — subscribe / pause / skip / resume / renew /
past-due — is real and working. It has nothing to charge with.

## Landed

| | |
|---|---|
| `src/lib/veyra-membership.ts` | `startVeyraMembership()` — one `POST /api/v1/membership` that does first charge + vault + membership row + Veyra cron enrollment. Plus `isAmexBrand()`. **Not imported anywhere yet — on purpose.** |
| `src/lib/sql/veyra-memberships.sql` | `customer_memberships.veyra_membership_id` + partial unique index. **Applied to `mlpimwgkwuqpsvsrlpqv` 2026-08-02** (`column_ok=true`, 0 Veyra rows, 1 local row). |
| `src/lib/membership-billing.ts` | `.is("veyra_membership_id", null)` on **all five** sweep queries. |

### The rule that must not be broken

Veyra owns the renewal schedule once a membership exists — it charges, retries
and duns. `runMembershipBillingSweep()` must never see those rows. If both
sides bill, **every member is charged twice a month.** Same double-fire shape as
the EVO confirm-backfill leak (2026-08-01): a second system acting on rows it
does not own.

The guard engages only when `veyra_membership_id` is populated. **Whatever calls
`startVeyraMembership()` MUST persist the returned id.** Forgetting that is the
double-charge.

## The remaining build — bigger than it looks

`/api/v1/membership` needs a `token_intent_id`. This storefront cannot produce one.

- No BT SDK in `package.json`.
- The only BT code is `express-apple-pay-button.tsx`, which posts Apple's
  encrypted payload to `api.basistheory.com/apple-pay` — a wallet path, not card.
- The card lane mounts Veyra's hosted iframe
  (`src/app/checkout/pay/[orderId]/VeyraCheckout.tsx` → `https://veyragate.com/v1/checkout.js`,
  `Veyra.mount(el, { sessionId })`). Card data never touches this origin, and the
  iframe charges a one-time session — it does not hand back a token intent.

Refined and Evo both have first-party BT hosted fields; that is how they mint a
token intent. Vanta does not.

### ✅ PORT IT FROM EVO — do not design a new one

An earlier draft of this doc called the remaining work "a new card-data path…
do not shortcut it." **That was wrong and it overstated the risk.** A proven,
live, SAQ-A-compliant implementation already exists two repos over. Port it,
exactly as `express-apple-pay-button.tsx` was ported from Evo's
`WalletButton.jsx` on 2026-08-01.

Source of truth — `C:\Users\jakob\Documents\evolabs-lemon-release`:

| File | Lines | What it gives you |
|---|---|---|
| `components/VeyraCardPanel.jsx` | 985 | The whole card capture. Fetches the session's BT public key from `/api/checkout/veyra-config`, mounts ONE combined BT `<CardElement>`, calls `tokenIntents.create()` → `token_intent_id`. PAN / MM-YY / CVC live only inside the `js.basistheory.com` iframe; the host never reads them. No Stripe.js. |
| `lib/membership/veyra.js` | 145 | Membership-side Veyra calls. |
| `pages/api/membership/subscribe.js` | 207 | The server route that ties signup → token intent → membership. |

Dependency: `@basis-theory/basis-theory-react`
(`BasisTheoryProvider`, `CardElement`, `useBasisTheory`).

Translation needed, same as the Apple Pay port: Evo is Next.js **pages** router
in JS; Vanta is **App Router + TypeScript**. Port the logic, keep the SAQ-A
boundary byte-for-byte — never move PAN handling out of the BT iframe.

The real reason this was not finished on 2026-08-02 was the assisting session
running out of context mid-task, NOT the risk profile. Treat it as a port.

### Steps

1. **API key scopes.** Vanta's live `vg_sk_live_p…` has 20 scopes but NOT
   `memberships:read` / `memberships:write`. Endpoint rejects every call without
   them. Same gap Refined hit. Run against veyragate prod:
   ```sql
   update veyragate_api_keys
   set permissions = array_cat(permissions, array['memberships:read','memberships:write']),
       updated_at = now()
   where merchant_id = 'cb2d82b0-42ab-4ca3-a0d2-88a3a9af2fd6'
     and revoked_at is null
     and not (permissions @> array['memberships:write']);
   ```
2. **Charge-model gate.** Merchant is `destination_charge_without_on_behalf_of`;
   the endpoint hard-gates on `destination_charge_with_obo` and 400s otherwise.
   `tier_override_charge_model` is NULL (inheriting). **Owner decision — this
   changes routing for ALL charges, not just memberships.**
3. **Card capture — PORT `VeyraCardPanel.jsx`** (see the table above). Do not
   write a new one. The BT public key is session-scoped and fetched at runtime —
   never hardcode one, and never let a PAN reach this origin.
4. **AMEX before tokenize.** Call `isAmexBrand()` at the form, BEFORE
   tokenizing. Rebills are no-CVC and AMEX CNP hard-declines, so an AMEX member
   signs up fine then fails every renewal. Refined checks AFTER tokenize, which
   vaults the card then rejects it — do not copy that.
5. **Thread it through.** Add `tokenIntentId` to `StartMembershipSignupInput`;
   when present, call `startVeyraMembership()` instead of
   `billingProvider.chargeCard()` (`membership-billing.ts` ~:464) and write
   `veyra_membership_id` on the upsert. Leave the `noop`/`mock` path intact for
   local rows.

### Field traps (have bitten every storefront on this lane)

- `interval: "annual"` — NOT `"yearly"`
- `postal_code` — NOT `zip`
- `exp_month` / `exp_year` — NOT `expiration_month` / `expiration_year`

### Inherited defaults (no flag needed)

`tier_override_membership_recurring_mode` is NULL → inherits `masked_one_time`,
the Evo model. A masked tier_3 merchant gets memberships by inheritance.

## Verify before declaring it done

Nothing has ever charged on this merchant end-to-end — `orders` is 10 rows, all
`pending_payment`, `payment_id` NULL on every one. Prove ONE real card charge
before trusting a recurring lane built on top of it. Then confirm month 2
actually bills, and that the local sweep did **not** also bill it.
