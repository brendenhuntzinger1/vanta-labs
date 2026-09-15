# Omnisend Marketing System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed Omnisend the contacts, consent, catalogue and events it needs, give its emails a way through the account wall, mint per-contact codes, and hand marketing ownership to Omnisend behind one switch — then build every flow, template, segment and form in the Omnisend account as disabled drafts.

**Architecture:** A `server-only` module tree under `src/lib/marketing/omnisend/` mirrors the ad-platform legs: a gated transport, pure payload builders with pinned field names, a fail-open ledger, thin hooks called from the existing lifecycle points, and cron sweeps as backstops. Omnisend assets are created through the Omnisend API from a checked-in build script so they can be re-created or diffed.

**Tech Stack:** Next.js 16 App Router, Supabase (service role), Vitest, Omnisend Public API `2026-03-15`, Web Crypto for edge-safe tokens.

**Spec:** `website/docs/superpowers/specs/2026-09-15-omnisend-marketing-system-design.md`

## Global Constraints

- Every network send passes `serverAdsReportingAllowed()` **before** `OMNISEND_API_KEY` is read (spec §4, `client.ts`).
- Header `Omnisend-Version: 2026-03-15`; origin `api`; event versions: `viewed product` v4, `placed order` / `paid for order` / `order fulfilled` / `order canceled` / `order refunded` v2, cart and checkout `""` (spec §5.2).
- Email identifiers are lowercased before sending; phones are E.164 (spec §5.1).
- Consent mapping is exactly the table in spec §3.2; never widen.
- No module under `src/components` or any client file may hand Omnisend an email address (`omnisend-source.test.ts` invariant).
- Copy: no emoji, no exclamation marks, research-use-only, canonical `trust-claims.ts` sentences verbatim.
- Nothing merges to `main`; every Omnisend automation, form and campaign is created disabled or draft.
- Commit after every task; run `npx vitest run <suite>` before each commit and the full suite before the PR.

---

## File structure

```
src/lib/marketing/omnisend/
  config.ts            pure: omnisendConfigured(), omnisendOwnsMarketing(), OMNISEND_API_VERSION
  client.ts            server-only: omnisendRequest() with the gate, timeout, never-throw contract
  link-token.ts        pure (Web Crypto): signOmnisendLink(email), verifyOmnisendLink(token, email?)
  codes.ts             server-only: ensureContactCode(kind, email) -> {code, endsAt} via coupons
  contacts.ts          pure buildContactPayload() + server-only upsertOmnisendContact(email)
  events.ts            pure builders + sendOmnisendEvent()
  ledger.ts            omnisendLedger(entityId) claim/record/release (fail-open)
  orders.ts            loadOrderForOmnisend(orderId) -> OmnisendOrder (row + items + slugs/categories)
  hooks.ts             onMarketingConsentChanged, onSmsConsentChanged, onCartTracked, onCheckoutStarted,
                       onProductViewed, onOrderPaid, onOrderFulfilled, onOrderCancelled, onOrderRefunded
  catalog-sync.ts      syncOmnisendCatalog()
  sweeps.ts            sweepUnsentOmnisendOrders(), reconcileOmnisendContacts()
  ownership.ts         marketingSendBlockedByOmnisend(): string | null
src/app/api/email/omnisend-link/route.ts
src/app/api/admin/omnisend/sync/route.ts
src/lib/sql/omnisend-sync.sql
scripts/omnisend/build-account.mjs   (Omnisend asset build, idempotent by name)
scripts/omnisend/assets/*.json       (templates, automations, segments, form as data)
```

---

### Task 1: Config, transport and ledger

**Files:**
- Create: `src/lib/sql/omnisend-sync.sql`, `src/lib/marketing/omnisend/config.ts`, `src/lib/marketing/omnisend/client.ts`, `src/lib/marketing/omnisend/ledger.ts`
- Test: `src/lib/marketing/omnisend/client.test.ts`, `src/lib/marketing/omnisend/ledger-source.test.ts`
- Modify: `.env.example` (add `OMNISEND_API_KEY=`, `OMNISEND_MARKETING_OWNER=`)

**Interfaces:**
- Produces: `omnisendConfigured(env = process.env): { configured: boolean; reason: string | null }`;
  `omnisendOwnsMarketing(env = process.env): boolean`;
  `omnisendRequest<T>(input: { method: "GET"|"POST"|"PUT"|"PATCH"; path: string; body?: unknown }): Promise<{ ok: boolean; status: number; body: T | null; error: string | null }>`;
  `omnisendLedger(entityId: string): { claimSend(eventName, eventId): Promise<boolean>; recordSend(eventName, eventId, delivered, error): Promise<void>; releaseSend(eventName): Promise<void> }`.

- [ ] Step 1: Write `client.test.ts` — for each refusal reason (`VERCEL_ENV=preview`, `NODE_ENV=test`, `CI=true`) stub fetch and assert zero calls and `error` containing `ads reporting disabled`; with production env and no key assert zero calls and `error === "OMNISEND_API_KEY not set"`; with production env and key assert one call to `https://api.omnisend.com/api/contacts` carrying headers `Authorization: Omnisend-API-Key tok`, `Omnisend-Version: 2026-03-15`, `Content-Type: application/json`; a 500 answers `{ok:false,status:500}` without throwing; a thrown fetch answers `{ok:false,status:0,error}`.
- [ ] Step 2: Run, expect failure (module missing).
- [ ] Step 3: Implement `config.ts`, `client.ts` (gate → key → fetch with 10s `AbortController`, JSON parse guarded) and `ledger.ts` copying the `metaLedger` triad against `omnisend_events_sent` with `onConflict: "entity_id,event_name"`, `23505 → false`, any other error → `true`.
- [ ] Step 4: Write `ledger-source.test.ts` pinning `.from("omnisend_events_sent").insert(`, `=== "23505") return false`, `catch { return true; }` inside `claimSend`, and `.eq("delivered", false)` inside `releaseSend`.
- [ ] Step 5: Write the SQL: `omnisend_events_sent(entity_id text not null, event_name text not null, event_id text not null, delivered boolean not null default false, attempts integer not null default 1, first_sent_at timestamptz not null default now(), last_error text, primary key (entity_id, event_name))` and `omnisend_sync_state(key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now())`, both `enable row level security`, no policies.
- [ ] Step 6: Run both suites green; commit `Omnisend: gated transport, config and event ledger`.

### Task 2: Per-contact link token and the click route

**Files:**
- Create: `src/lib/marketing/omnisend/link-token.ts`, `src/app/api/email/omnisend-link/route.ts`
- Test: `src/lib/marketing/omnisend/link-token.test.ts`, `src/lib/marketing/omnisend/omnisend-link-route-source.test.ts`

**Interfaces:**
- Produces: `OMNISEND_LINK_TTL_MS = 30 days`; `signOmnisendLink(email: string, now = Date.now()): Promise<string | null>` → `v1.<expiresAtMs>.<32 hex>` signed over `omnisend_link:v1:<email>:<expiresAtMs>`; `verifyOmnisendLink(token: string, email: string, now = Date.now()): Promise<{ expiresAtMs: number } | null>`; `omnisendLinkUrl(path: string, utm: { campaign: string; medium: "email"|"sms"; content?: string }): string` returning `${siteUrl}/api/email/omnisend-link?t=[[contact.custom_properties.vl_link]]&e=[[contact.email]]&to=<encoded path>&utm_source=omnisend&utm_medium=...&utm_campaign=...`.
- Consumes: `emailLinkLanding`, `setEmailLinkGrantCookie` from `@/lib/email/recipient-attestation`; `resolveSitePath` from `@/lib/email/cta-path`; `withUtm` from `@/lib/email/utm`.

- [ ] Step 1: Tests: round-trip sign/verify; a token for `a@x.com` does not verify for `b@x.com`; expired refused; a token longer than 128 chars refused; the cart grant `v1.<n>.<hex>` shape does not verify (namespace disjoint); `omnisendLinkUrl("/products/bpc-157", {campaign:"welcome", medium:"email"})` contains `to=%2Fproducts%2Fbpc-157` and the two personalisation tags verbatim.
- [ ] Step 2: Implement with Web Crypto exactly as `link-grant.ts` (same secret source, `constantTimeEqual`).
- [ ] Step 3: Route `GET`: read `t`, `e` (lowercased), `to`, `utm_*`; `destination = resolveSitePath(to, siteUrl, "/products")` with UTM re-applied; if `verifyOmnisendLink` fails → 302 to `/account/login?next=<path>`; else `landing = await emailLinkLanding({ email, destination })`; response 302 to `landing.destination`; if `landing.grant` set the grant cookie; always set `vl_omnisend` cookie `{campaign, at}` (7 days, httpOnly, lax). Every failure path still redirects.
- [ ] Step 4: Source test pins: `verifyOmnisendLink(` before any `redirect(`, `resolveSitePath(`, `emailLinkLanding(`, `setEmailLinkGrantCookie(`, and that no `searchParams.get("to")` value reaches `NextResponse.redirect` without `resolveSitePath`.
- [ ] Step 5: Green; commit `Omnisend: per-contact link token and click route`.

### Task 3: Codes and contacts

**Files:**
- Create: `src/lib/marketing/omnisend/codes.ts`, `src/lib/marketing/omnisend/contacts.ts`
- Test: `src/lib/marketing/omnisend/contacts.test.ts`, `src/lib/marketing/omnisend/codes-source.test.ts`

**Interfaces:**
- Produces: `CONTACT_CODE_OFFERS = { welcome: { percent: 10, ttlHours: 14*24, source: "omnisend_welcome" }, winback: { percent: 15, ttlHours: 14*24, source: "omnisend_winback" }, recovery: { percent: 10, ttlHours: 72, source: "omnisend_recovery" } }`; `ensureContactCode(kind, email): Promise<{ code: string; endsAt: string } | null>` (returns the live code if one exists for the address and source, else mints one via the same insert shape as `mintCartRecoveryCoupon` with `is_private: true`);
  `buildContactPayload(input: ContactFacts): OmnisendContactPayload` (pure) where `ContactFacts = { email; firstName?; lastName?; phone?; countryCode?; state?; city?; postalCode?; emailConsent: { status: "subscribed"|"unsubscribed"|"nonSubscribed"; changedAt: string; source?: string }; smsConsent?: { status; changedAt; source? } | null; attested: boolean; orders: number; totalSpent: number; firstOrderAt?; lastOrderAt?; referralCode?; link: { token: string; endsAt: string }; codes: Partial<Record<"welcome"|"winback"|"recovery", { code: string; endsAt: string }>> }`;
  `collectContactFacts(email): Promise<ContactFacts | null>` (server-only: consented audience membership via `marketing_subscribers` + `customer_preferences` + `email_suppressions`, orders aggregate, attestation via `recipientHasAttested`);
  `upsertOmnisendContact(email, opts?: { mintWelcome?: boolean }): Promise<boolean>`.

- [ ] Step 1: `contacts.test.ts` pins the payload exactly: identifiers array shape, `channels.email.status`, `statusChangedAt`, `consent.source`, phone identifier only when phone present, `tags` contain `source: website` and `customer` iff `orders > 0`, custom properties named `vl_link`, `vl_link_ends`, `vl_attested`, `vl_orders`, `vl_total_spent`, `vl_first_order_at`, `vl_last_order_at`, `vl_referral_code`, `vl_welcome_code`, `vl_welcome_ends`, `vl_winback_code`, `vl_winback_ends`, `vl_recovery_code`, `vl_recovery_ends`; lowercasing; a suppressed address is `unsubscribed` even if the subscriber row is active; SMS `subscribed` only with a phone.
- [ ] Step 2: Implement; `codes-source.test.ts` pins `assigned_email`, `max_redemptions: 1`, `is_private: true`, `source: "omnisend_` and that the live-code lookup filters `active`, `ends_at > now`, `redemptions_count < max_redemptions`.
- [ ] Step 3: Green; commit `Omnisend: contact payload, consent mapping and per-contact codes`.

### Task 4: Events and orders

**Files:**
- Create: `src/lib/marketing/omnisend/events.ts`, `src/lib/marketing/omnisend/orders.ts`
- Test: `src/lib/marketing/omnisend/events.test.ts`

**Interfaces:**
- Produces: builders `buildViewedProduct`, `buildCartEvent(name: "added product to cart"|"started checkout", …)`, `buildOrderEvent(name: "placed order"|"paid for order"|"order fulfilled"|"order canceled"|"order refunded", order: OmnisendOrder, email)`; `sendOmnisendEvent(event): Promise<{ ok; status; error }>`; `loadOrderForOmnisend(orderId): Promise<OmnisendOrder | null>` selecting `order_id, order_number, payment_status, fulfillment_status, amount_paid, subtotal, shipping_amount, discount_amount, tax_amount, currency, coupon_code, customer_email, customer_name, customer_user_id, phone, shipping_address, shipping_address_2, city, state, postal_code, country, paid_at, created_at, shipped_at, delivered_at, tracking_number, shipping_carrier, order_type, replacement_of, refund_amount, order_items(product_id, product_name, quantity, unit_price)` and resolving `products(id, slug, category, image_url)`.
- Consumes: `signOmnisendLink` for per-contact `productURL` and `abandonedCheckoutURL`.

- [ ] Step 1: `events.test.ts` pins every field name from spec §5.2 against fixed inputs, `eventVersion` per event, `origin: "api"`, deterministic `eventID`s, prices from the order row not the browser, replacement/membership orders yield `null`, and that `contact.email` is lowercased.
- [ ] Step 2: Implement; commit `Omnisend: event builders and order loader`.

### Task 5: Catalogue sync

**Files:**
- Create: `src/lib/marketing/omnisend/catalog-sync.ts`
- Test: `src/lib/marketing/omnisend/catalog-sync.test.ts`

**Interfaces:**
- Produces: `buildOmnisendProduct(product: Product, siteUrl: string): OmnisendProduct` (pure) and `syncOmnisendCatalog(): Promise<{ products: number; categories: number; batches: number; skipped: string | null }>`; category id = `slugify(category)`.

- [ ] Step 1: Test pins `id = slug`, `url`, `status` mapping (`In Stock`→`inStock`, `Limited`→`inStock`, `Reserved`→`inStock`, `Out of Stock`→`outOfStock`), price parsing from the formatted `"$42.99"` strings, `strikeThroughPrice` from `compareAtPrice`, variants from doses with `${slug}#${dose.id}`, single default variant when no doses, images absolute and placeholder-resolved, description ≤ 1000 chars, `categoryIDs` slugified.
- [ ] Step 2: Implement with `post_batches` (`PUT`, 100 items) after ensuring categories via `POST /api/product-categories` (409/duplicate tolerated); commit `Omnisend: catalogue sync`.

### Task 6: Hooks and wiring for consent, cart, checkout and product views

**Files:**
- Create: `src/lib/marketing/omnisend/hooks.ts`
- Modify: `src/lib/marketing-broadcast.ts` (`recordMarketingOptIn`), `src/app/api/auth/signup/route.ts` (`recordSignupMarketingConsent`), `src/app/api/account/preferences/route.ts`, `src/app/api/auth/session/route.ts` (OAuth consent), `src/lib/cart-recovery.ts` (`trackCart`, `markCheckoutStarted`), `src/app/products/[slug]/page.tsx` (beside `recordProductView`)
- Test: `src/lib/marketing/omnisend/hooks-wiring-source.test.ts`

**Interfaces:**
- Produces: every hook `async (…): Promise<void>` that returns immediately when `!omnisendConfigured().configured`, wraps its body in try/catch, and logs with the `[omnisend]` prefix.

- [ ] Step 1: Source test pins each call site: `onMarketingConsentChanged(` in the four consent paths, `onCartTracked(` after the `abandoned_carts` write in `trackCart`, `onCheckoutStarted(` in `markCheckoutStarted`, `onProductViewed(` next to `recordProductView(` in the product page, and that all are invoked inside `after(` or awaited in a try block that cannot fail the caller.
- [ ] Step 2: Implement and wire; `onCheckoutStarted` mints the recovery code when `ensureNoRecentPurchase(email, 30d)`; commit `Omnisend: consent, cart, checkout and product-view hooks`.

### Task 7: Order hooks, backstop sweep and cron registration

**Files:**
- Modify: `src/lib/payment-webhook.ts` (inside the `runSideEffects` block next to `scheduleShippoSync(orderId)`, and in `finalizeManualPayment` after the `paid_side_effects_at` latch succeeds), `src/lib/shippo/service.ts` (`notifyCustomer`, after `kind` resolves), `src/app/api/admin/orders/[orderId]/route.ts` (cancel after `setOrderFulfillmentStatus` ok; refund after `updateCommissionOnRefund`), `src/app/api/cron/sweep/route.ts` (jobs `omnisendOrderBackstop`, `omnisendCatalogSync`, `omnisendContactsReconcile`)
- Create: `src/lib/marketing/omnisend/sweeps.ts`
- Test: `src/lib/marketing/omnisend/sweeps.test.ts` (pure `ordersNeedingOmnisendEvents`), `src/lib/marketing/omnisend/order-hooks-source.test.ts`

- [ ] Step 1: Tests: `ordersNeedingOmnisendEvents` mirrors `ordersNeedingMetaPurchase` (paid, within 7 days, not delivered in ledger for `paid for order`); source test pins the two paid lanes both call `onOrderPaid(orderId)` and that `notifyCustomer` calls `onOrderFulfilled` only when `kind` is non-null.
- [ ] Step 2: Implement `onOrderPaid` = upsert contact (tag `customer`) + `placed order` + `paid for order` via ledger; `onOrderFulfilled` = `order fulfilled` once per order (ledger key `order fulfilled`); cancel/refund likewise. Register the three cron jobs with comments on idempotency. Commit `Omnisend: order events in both paid lanes, fulfilment, cancellation, refunds, and the backstop sweep`.

### Task 8: Contacts reconcile, write-back and the admin sync route

**Files:**
- Modify: `src/lib/marketing/omnisend/sweeps.ts`
- Create: `src/app/api/admin/omnisend/sync/route.ts`
- Test: `src/lib/marketing/omnisend/reconcile.test.ts`

**Interfaces:**
- Produces: `reconcileOmnisendContacts(opts?: { dryRun?: boolean; limit?: number }): Promise<{ pushed: number; suppressed: number; smsOptOuts: number; formSubscribers: number; winbackCodes: number; dryRun: boolean }>`; `planWriteBack(contacts: OmnisendContactRead[], known: { suppressed: Set<string>; subscribers: Set<string> }): { suppress: string[]; smsOptOut: string[]; newSubscribers: string[] }` (pure).

- [ ] Step 1: Test `planWriteBack`: an Omnisend `unsubscribed` email not yet suppressed → `suppress`; an Omnisend `subscribed` email absent from both stores → `newSubscribers`; SMS `unsubscribed` → `smsOptOut`; nothing for already-known states.
- [ ] Step 2: Implement: page `GET /api/contacts?updatedAtFrom=<watermark>` (watermark in `omnisend_sync_state`), apply write-back, then page the consented audience and `POST /api/batches` contacts (100 per batch) refreshing `vl_link` and minting win-back codes for lapsed buyers. Admin route: `POST` gated by `verifyAdminSessionFromRequest` + `canManageEmailCampaigns`, body `{ what: "contacts"|"catalog", dryRun?: boolean }`. Commit `Omnisend: nightly reconcile with unsubscribe write-back and admin sync route`.

### Task 9: Ownership switch

**Files:**
- Create: `src/lib/marketing/omnisend/ownership.ts`
- Modify: `src/app/api/cron/lifecycle/route.ts` (wrap `cartRecovery`, `emailAutomations`, `emailCampaigns` runs), `src/app/api/admin/email/campaigns/[campaignId]/send/route.ts` (refuse with the message), `src/components/admin-email-client.tsx` (banner text when blocked, from a new field on the automations GET payload)
- Test: `src/lib/marketing/omnisend/ownership.test.ts`, `src/lib/marketing/omnisend/ownership-source.test.ts`

- [ ] Step 1: Tests: `marketingSendBlockedByOmnisend({ OMNISEND_MARKETING_OWNER: "true" })` returns `"marketing owned by omnisend"`, unset/`false`/`0` return `null`; source test pins the three lifecycle jobs consult it and the send route returns 409 with that message.
- [ ] Step 2: Implement; commit `Omnisend: single switch that hands marketing sends to Omnisend`.

### Task 10: Policies and invariants

**Files:**
- Modify: `src/lib/legal-content.ts` (privacy Omnisend paragraph, SMS section, cookie policy bullet), `src/lib/ads/omnisend-source.test.ts`, `.env.example`
- Test: `src/lib/marketing/omnisend/omnisend-sync-source.test.ts`

- [ ] Step 1: Update the policy wording per spec §9; update the existing test's expectations (`told about page views only` → the new sentence; keep `identifyContact` never called from client code).
- [ ] Step 2: New suite pins: transport reads the key only after the gate; every hook is `server-only`; no client file imports `@/lib/marketing/omnisend`; policies name email, phone, orders, cart and product views.
- [ ] Step 3: Run the full suite, eslint, tsc; commit `Omnisend: policies describe the server-side sync`.

### Task 11: Omnisend account build

**Files:**
- Create: `scripts/omnisend/build-account.mjs`, `scripts/omnisend/assets/{palette.json, layouts.json, templates/*.json, automations/*.json, segments.json, form.json, campaigns.json}`, `scripts/omnisend/README.md`

- [ ] Step 1: Upload images (logo, hero poster) → ids. Create universal layouts `VL Header`, `VL Footer`. Create every template from the palette, each with the required dynamic section per spec §6. Create segments (§7). Create automations (§6) referencing template ids, all left disabled. Create the form (§8) disabled. Create two campaign drafts. Record every created id in `scripts/omnisend/assets/created.json` so re-runs update instead of duplicating.
- [ ] Step 2: Send a test email of every template to the owner's address via `post_automations_id_blocks_block_id_test_email` / `post_campaigns_id_test_email`; commit the assets.

### Task 12: Verify and hand over

- [ ] Full `npx vitest run`, `npm run lint`, `npx tsc --noEmit`; harness browser check of `/api/email/omnisend-link` with an invalid and a valid token; push; open a **draft** PR; write the walkthrough checklist (spec §12).
