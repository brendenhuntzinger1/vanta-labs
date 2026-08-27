# Google Ads as a fourth channel — conversion tracking infrastructure

**Date:** 2026-08-27
**Status:** Design approved, awaiting implementation plan
**Scope:** Tracking and reporting infrastructure only. Campaign creation is explicitly out of scope.

---

## 1. What this is, and what it is not

Vanta Labs runs three audited advertising channels — TikTok, Snap and Reddit — each
with a consent-gated browser pixel, a server-verified purchase path, and a row on the
admin tracking-health board. Google is absent entirely. This spec adds it as a
first-class fourth channel.

**This spec does not cover, and implementation must not produce:** campaigns, ad
groups, keywords, ad copy, landing-page variants, or any mechanism whose purpose is to
change what Google's reviewers see. Campaign activation is a separate stage, taken only
after the Google Ads account exists and we know what Google permits for these products
and these landing pages. Nothing in this document should be read as preparation for
working around policy enforcement.

The ordering is deliberate. Conversion data is what a bidding system eventually depends
on; if it is wrong, every campaign built on it is wrong in a way that is expensive and
slow to detect. Tracking is proven first.

---

## 2. Two findings from the repository that change the design

The design was reviewed against the code rather than against the code's comments. Two
things turned out to differ from what a reader would reasonably assume.

### 2.1 The send-ledger is keyed on the order alone, not on the order and platform

`src/lib/sql/ads-purchase-idempotency.sql` defines:

```sql
create table if not exists public.ad_purchase_events_sent (
  order_id text primary key,
  ...
  platform text not null default 'tiktok',
```

`order_id` is the primary key, and `platform` is an ordinary column. So there is exactly
one ledger row per order, shared by every channel. In
`src/app/api/ads/purchase-event/[orderId]/route.ts` that single row is read once into
`alreadySent`, which then gates **both** the Reddit send and the TikTok send — but the
row is only ever *written* inside the TikTok block, with `onConflict: "order_id"`.

Two consequences exist today, before Google is involved:

- With Reddit credentials configured and TikTok's absent, no ledger row is ever written.
  Reddit's permanent idempotency silently does not apply; only Reddit's own dedup window
  protects it.
- Whichever platform writes the row first marks the order as sent *for every platform*.

Adding a fourth channel to this shared gate would make the requirement "one paid order
produces exactly one logical Google purchase conversion" impossible to satisfy
honestly — Google's send would be suppressed by TikTok's, or would suppress it.

**Resolution.** Migrate the ledger to a composite key `(order_id, platform)` and read
`alreadySent` per platform. This is a schema change to an applied production table, so
it is specified conservatively in §7. It is not scope creep: it is the minimum change
that makes the approved fail-closed duplicate guarantee true rather than aspirational.

### 2.2 `PaidOrder` carries no currency, shipping, tax or discount fields

The canonical order shape (`src/lib/ads/tiktok-events.ts:213`) is:

```ts
export type PaidOrder = {
  orderId: string;
  isPaid: boolean;
  amountPaid: number;   // "The settled figure, not a recomputed sum."
  items: { slug?; productId?; productName?; quantity?; unitPrice? }[];
};
```

There is no `currency`, no `shipping`, no `tax`, no `discount`. Currency is a per-channel
constant (`SNAP_CURRENCY = "USD"`). The requirement that Google's reported discounts,
shipping and tax reconcile with canonical paid-order data cannot be met by reading fields
that do not exist, and the standing rule — *never invent a number, never create a second
pricing calculation* — forbids deriving them.

**Resolution.** Google's `purchase.value` is `order.amountPaid`: the settled total, the
same figure TikTok, Snap and Reddit report and the same figure on the customer's card
statement. It is inclusive of shipping, tax and discounts by construction, because it is
what actually settled. Google's optional `shipping` and `tax` parameters are **not sent**,
because sending them would require either extending the order read or computing them
here, and a wrong breakdown is worse than an absent one. Reconciliation is therefore
exact at the total, which is the number bidding uses.

Extending `PaidOrder` with true settled shipping/tax columns is a reasonable future
change. It is listed as an open question in §10, not smuggled in here.

---

## 3. Architecture

Google becomes a peer of the existing three. No existing channel is refactored to
accommodate it, with the single narrowly-scoped exception in §6.

### New files

| File | Purpose |
|---|---|
| `src/lib/ads/google-events.ts` | Pure event builders. No DOM, no network, no env. |
| `src/lib/ads/google-conversion-id.ts` | Sole home of the `AW-` literal, mirroring `reddit-pixel-id.ts`. |
| `src/components/google-pixel.tsx` | Consent-gated gtag loader, mounted once in the root layout. |
| `src/lib/ads/google-conversions.ts` | `server-only`. Enhanced Conversions leg. Dark until credentialed. |
| `src/lib/ads/google-matching.ts` | Google's normalisation rules, built on `advanced-matching.ts`. |
| `src/lib/ads/google-health.ts` / `google-health-browser.ts` | The six health states of §5. |

Plus a test file per module, and `src/lib/sql/ads-purchase-ledger-per-platform.sql` for §7.

### Data flow for a purchase

```
paid order in Supabase
        │
        ▼
/api/ads/purchase-event/[orderId]   ← the ONE place that decides a purchase happened
        │   reads payment_status + amount_paid; builds one PaidOrder
        ├─► buildPurchase()        → TikTok    (unchanged)
        ├─► buildSnapPurchase()    → Snap      (unchanged)
        ├─► buildRedditPurchase()  → Reddit    (unchanged)
        └─► buildGooglePurchase()  → Google    (new)
                │
                ├─► returned to the browser → gtag('event', 'conversion', …)
                └─► sendGoogleConversion()  → Enhanced Conversions API
                        both carry transaction_id = order.orderId
```

The browser never decides whether an order was paid. It asks the route, and the route
reads the backend's own `payment_status`. There is no path by which reaching a
confirmation URL produces a conversion — this is the existing rule and Google inherits
it unchanged by being built from the same `paidOrder` object, read once.

---

## 4. Tracking requirements

### 4.1 Funnel

Five events: `page_view`, `view_item`, `add_to_cart`, `begin_checkout`, `purchase`.

Product identity is the **catalogue slug**, resolved by the existing
`resolveContentId`. Reporting a product as `bpc-157` on one platform and a database id
on another makes cross-channel comparison impossible for no benefit. A line resolving to
neither slug nor product id is dropped; a product *name* is never used as an identifier.

### 4.2 Purchase gating

`buildGooglePurchase(order: PaidOrder)` returns `null` unless **both**:

- `order.isPaid === true` — the backend's own state, not the caller's opinion; and
- `money(order.amountPaid)` is positive.

A pending, failed, abandoned, cancelled or manual-but-unpaid order yields `null`. A
zero-value purchase yields `null`: it is either a bug or a fully-discounted order, and
Google must not learn revenue from either.

### 4.3 Deterministic shared identity

Browser and server legs both send `transaction_id = order.orderId`. It is derived from
the thing it describes — never random, never a timestamp. Google deduplicates on
`transaction_id` within its own window; the ledger of §7 makes it permanent beyond that
window.

### 4.4 Duplicate scenarios that must be tested

Each of these must produce **exactly one logical Google purchase conversion**, and each
gets a named test:

| Scenario | Expected behaviour |
|---|---|
| Duplicate webhook delivery | Second send suppressed by the per-platform ledger row. |
| Confirmation page refreshed | Same `transaction_id`; ledger already written; no second send. |
| Back / forward navigation | As above. This is the scenario that actually fired in production on 2026-08-25 (27 seconds apart) and motivated the ledger. |
| Two tabs on the confirmation page | Both resolve to one order; one ledger row wins. |
| Confirmation link re-opened after 49 hours | Ledger is permanent; Google's own window has closed but the send does not repeat. |
| Declined → retry → success | Only the settled order is paid. Earlier attempts yield `null`. |
| Abandoned checkout | `begin_checkout` may fire; `purchase` never does. |
| Repeated `?inspect=1` calls | Admin-gated, reports what *would* be sent, sends nothing, writes no ledger row. |

---

## 5. Privacy, consent and fail-closed behaviour

### 5.1 Browser

`GooglePixel` renders `null` — no script tag, no network request to
`googletagmanager.com`, no cookie — when **any** of these hold:

- `NEXT_PUBLIC_GOOGLE_ADS_ID` is unset or does not match `/^AW-\d+$/`;
- `vl_cookie_consent` in `localStorage` is anything other than `"accepted"`;
- `browserAdsReportingAllowed()` refuses.

Absence of a recorded "yes" is a no, including when storage throws (private mode, some
in-app browsers). Declining is a real no-track path, not a suppressed-reporting path.

The gtag snippet is Google's own, unmodified, so it can be diffed against what the Google
Ads console generates. Its config object carries **no identity fields**. The root layout
does not know who the visitor is, and the placeholder-shaped fields Google's template
offers are the exact mechanism by which a raw address reaches a third party on every page
load.

### 5.2 Server

`sendGoogleConversion` returns a not-configured result, having sent nothing, unless all of
`GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_CLIENT_ID`,
`GOOGLE_ADS_CLIENT_SECRET` and `GOOGLE_ADS_REFRESH_TOKEN` are present and non-empty.
Partial configuration is a refusal, never a best-effort attempt — an incomplete
credential set must never produce a partially-identified conversion.

Its credential check is **independent** of TikTok's and Reddit's. This is not a
stylistic choice: nesting Reddit's gate inside TikTok's was a real silent single point of
failure, documented in the route, and Google must not reintroduce it.

### 5.3 Identity

Email and phone are normalised and hashed **server-side** via `advanced-matching.ts`,
using Google's canonicalisation (lowercase, trim, strip dots and `+` suffixes for Gmail;
E.164 for phone). The builder accepts a SHA-256 digest and nothing else: a value that is
not 64 hex characters is dropped rather than sent. This is `hashedOnly`'s posture from
`snap-events.ts`, and its point is structural — a raw address cannot reach Google by
mistake, only by deleting the guard, which a test asserts is impossible.

### 5.4 Secrets

No Google credential is ever prefixed `NEXT_PUBLIC_`. The existing
`findClientExposedSecrets` helper (`tracking-health-server.ts`, already driving
`single-data-source.test.ts`) is extended with the Google secret names rather than
reimplemented, so one helper stays the single answer to "did a secret reach the browser". Delivery diagnostics are built
from a fixed field set — a token or customer identifier cannot reach `console`, Sentry
breadcrumbs or the audit log, because the describe function has no field to carry it.

---

## 6. Environment isolation

Every Google path — browser and server — passes through the existing deny-by-default
gate in `ads-environment.ts`. A caller must present a production environment; an unset
`VERCEL_ENV` refuses, because "we could not tell" and "this is production" must never be
the same answer. There is deliberately no override, and Google does not add one.

To report from a non-production deployment, point `NEXT_PUBLIC_GOOGLE_ADS_ID` at a test
conversion action. Do not defeat the environment check.

**Mutation controls.** Tests must prove the guard is load-bearing, not decorative: for
each of the browser and server legs, a test that fails if the
`browserAdsReportingAllowed` / `serverAdsReportingAllowed` call is deleted, and a test
asserting `preview`, `development` and unset environments all refuse. A guard nobody
tests the removal of is a guard that quietly stops working.

**Narrow correction.** The header comment in `ads-environment.ts` states "there is no
Meta/Facebook pixel in this codebase, and no Snap Conversions API server leg. This gate
is the chokepoint any future one must pass through." Google is now such a future one; the
comment gets one clause, not a rewrite.

**`HealthTier`.** Currently `"CODE" | "PRODUCTION" | "TIKTOK"`. That third member already
misdescribes Snap and Reddit rows. It becomes `"CODE" | "PRODUCTION" | "PLATFORM"` with
the platform named in the row's own `detail`. Eleven occurrences, all inside
`tracking-health.ts`. The refactor is mechanical and stops there: existing TikTok, Snap
and Reddit rows must render identical labels, statuses and details before and after,
proven by the existing `tracking-health.test.ts` passing unmodified except for the tier
literal.

---

## 7. The ledger migration

A new additive migration, `ads-purchase-ledger-per-platform.sql`, following the existing
file's conventions (RLS on, zero policies, service_role only, no FK into commerce):

- Add a composite unique constraint on `(order_id, platform)`.
- Drop the bare `order_id` primary key in favour of it.
- Backfill: existing rows already carry `platform` defaulting to `'tiktok'`, which is
  historically accurate — those sends were TikTok's.
- Route change: read `alreadySent` per platform; write a ledger row inside **each**
  platform's block with `onConflict: "order_id,platform"`, not only TikTok's.

This fixes the Reddit gap described in §2.1 as a side effect. That is a correction to an
existing defect, not a redesign of Reddit, and Reddit's own tests must pass unchanged.

If the migration is not yet applied, the route degrades exactly as it does today: the
lookup throws, `alreadySent` stays false, and the send proceeds. An occasional duplicate
that Google itself collapses is a better failure than silently never reporting real
revenue.

---

## 8. Health and observability

Google's health rows distinguish six states, each with a distinct `detail` and a single
concrete `action`:

| State | Meaning |
|---|---|
| `NOT_CONFIGURED` | No `NEXT_PUBLIC_GOOGLE_ADS_ID`. Nothing is installed; this is not an error. |
| `BROWSER_CONFIGURED` | Conversion ID present, browser leg live, server leg not credentialed. |
| `SERVER_INCOMPLETE` | Some but not all server credentials present. Fail-closed; nothing sent. |
| `SUPPRESSED_BY_ENVIRONMENT` | Fully configured, but this is not production. Working as designed. |
| `HEALTHY` | Configured, in production, last send delivered. |
| `ERROR` | Configured, in production, last send rejected — carrying Google's own code. |

The board's existing discipline holds: a `CODE` row proves only what the repository
proves. Nothing is marked `PLATFORM`-verified without a response from Google in hand.

---

## 9. Testing

TDD throughout — test first, watch it fail for the right reason, then implement.

**Unit.** `google-events.test.ts` covering all five builders, the paid gate, the
zero-value gate, slug resolution, and the digest-only identity guard.

**Mutation controls.** Per §6, plus a test that deleting the `isPaid` check fails, and a
test that replacing `transaction_id` with a random value fails.

**Reconciliation (release gate).** A known paid-order fixture with a fixed order id,
settled total and line items, asserted against the exact expected Google payload byte for
byte — then replayed through every duplicate scenario in §4.4, asserting one logical
conversion. This is the test that must pass before anything is called production-ready.

**Single-source.** Extend `single-data-source.test.ts` so the `AW-` literal appears in
exactly one file. A second copy is precisely the drift that test exists to catch.

**Regression.** The full existing ads suite, unmodified, plus typecheck, lint and a
production build.

**Browser.** Playwright against local dev at 390×844 and desktop: no request to
`googletagmanager.com` before consent; the script present after accepting; no request
after declining; and no request when the conversion ID is absent.

---

## 10. Open questions

1. **Shipping and tax breakdown.** Should `PaidOrder` gain settled `shipping` and `tax`
   columns so every channel can report them? Out of scope here; Google reports the
   settled total only (§2.2).
2. **Reconciliation job.** The server leg fires only when the customer opens the
   confirmation page. Closing that gap needs a job sweeping paid orders — a known,
   documented, pre-existing gap affecting all four channels equally.
3. **Compliance encoding.** Google's policy rules for this product category belong in
   `compliance.ts` before the campaign stage. Specified there, not here.

---

## 11. Owner checklist — creating Google Ads from nothing

Every step is yours; none can be done from this repository. Nothing below spends money.

**A. Account**
1. Create the Google Ads account at ads.google.com with the Vanta Labs business identity.
2. Complete billing setup and identity/business verification. Verification can take
   several business days and gates conversion tracking, so start it first.
3. **Do not create a campaign.** Google's onboarding funnels hard toward one; use the
   expert/skip path. An unlaunched account is fine.
4. Record the account's customer ID (`123-456-7890`).

**B. Conversion actions**
5. Tools → Conversions → create a **Website** conversion action per funnel event:
   Purchase, Begin checkout, Add to cart, View item.
6. For Purchase: category *Purchase*, value *Use different values for each conversion*,
   count *One*, and attribution per your preference. **Count = One** is what makes
   Google's own dedup agree with ours.
7. Record the conversion ID (`AW-XXXXXXXXX`) and each action's conversion label.

**C. Enhanced Conversions (server leg)**
8. Enable Enhanced Conversions for leads/web on the Purchase action, choosing the **API**
   method.
9. Apply for a Google Ads API developer token (API Center). Expect a basic-access
   application and a wait of days.
10. Create a Google Cloud project, enable the Google Ads API, create an OAuth client, and
    generate a refresh token for an account with access to the customer ID above.

**D. Domain and configuration**
11. Verify the site domain in Google Ads.
12. Confirm the consent banner's Google entry names the conversion cookie honestly.

**E. Environment variables**

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_GOOGLE_ADS_ID` | Vercel, production | `AW-…`. Public by design. |
| `NEXT_PUBLIC_GOOGLE_PURCHASE_LABEL` | Vercel, production | Conversion label. Public by design. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Vercel, production, secret | Never `NEXT_PUBLIC_`. |
| `GOOGLE_ADS_CUSTOMER_ID` | Vercel, production, secret | Digits only, no dashes. |
| `GOOGLE_ADS_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | Vercel, production, secret | OAuth triple. |

Set the two public variables when B completes; the secrets only when C completes. The
code is inert without them, so there is no wrong order and no rush.

**F. Verifying each connection without spending money**
13. Browser leg: load the site in production, accept consent, and confirm in Google Ads
    → Conversions that the tag reports *Recent activity*. Tag status alone costs nothing.
14. Server leg: once credentialed, use the admin `?inspect=1` path on a **real past paid
    order**. It reports the exact payload that would be sent and sends nothing.
15. Reconciliation: compare one known order's `amountPaid` against what Google records
    for that `transaction_id`. They must match to the cent.
16. Confirm the tracking-health board shows Google `HEALTHY` rather than
    `SUPPRESSED_BY_ENVIRONMENT`.

No test order is required, and no campaign is created at any point in this checklist.

---

## 12. Explicitly out of scope

Campaign creation, ad groups, keywords, ad copy, bidding strategy, budget, alternate
landing pages, and anything whose purpose is to change what a Google reviewer sees. No
production configuration change, no credential handling, no deployment, no ad spend.
