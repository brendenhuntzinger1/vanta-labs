# Vanta Labs — System Source of Truth (Phase 1)

Research-peptide ecommerce. Next.js 16 (App Router) + Supabase Postgres. Server
code uses the Supabase **service-role key** everywhere (`supabase-server.ts`),
so **route/lib code is the real authorization boundary**; RLS is a deny-by-default
backstop. This document maps how the system works today and ends with a
consolidated findings register that drives Phases 2–6.

**Baseline health (measured):** TypeScript 0 errors · 257/257 tests pass (31 files)
· build green. This is a mature codebase with a real centralized profit engine,
ledger, webhook idempotency, admin 2FA, and RLS — not a broken prototype.

---

## A. HOW IT WORKS

### A1. User types
- **Guest / logged-out visitor** — can browse catalog, COAs, articles; can build a
  cart; **cannot check out** (sign-in required server-side).
- **Customer (registered)** — checkout, order history, addresses, wishlist,
  membership, points, referral code, reorder.
- **Member** — a customer with an active `customer_memberships` tier (perks:
  member pricing %, free-shipping perk, points multiplier).
- **Ambassador / Partner** — approved `partners`+`ambassadors` row; custom
  referral code, personal discount, commission, tiers, payouts, dashboard.
- **Admin** — 3 RBAC roles: `staff < manager < super_admin`. Separate hardened
  session (2FA passcode). Capabilities gate each admin action.

### A2. Pages (customer)
Homepage, `/products` (listing/search/filter), `/products/[slug]` (PDP),
`/cart`, `/cart/restore`, `/checkout`, `/order-confirmation/[orderId]`,
`/pay/[orderId]` (manual-payment resubmit), auth (`/account/login`,
forgot/reset), account dashboard (orders, points, referral, membership),
addresses, wishlist, settings, ambassador tab, `/membership` + subscribe,
`/research` (articles), `/coa-library`, `/legal/[slug]`, `/contact`,
`/ambassador` + `/partner/*` (program), `/r/[code]` (referral redirect),
`/vault` (hidden staff entry), `/login` (partner/admin), `/maintenance`.

### A3. Pages (admin) — all behind admin session
Dashboard/metrics, orders (+detail), customers, products, inventory, coupons,
promotions, membership, partners/ambassadors (+detail), payments (+settings),
payouts, reconciliation, revenue, fulfillment, cart-recovery, content,
policies, team, account, audit-log.

### A4. API routes (~90) — auth posture
- `/api/admin/*` — admin session + per-action RBAC capability (`canManage*`).
- `/api/account/*` — customer session; ownership enforced by `.eq("user_id", user.id)`.
- `/api/partner/*` — customer session mapped to an **approved** partner by
  `auth_user_id` (client never supplies partnerId). `program-stats` is public.
- `/api/checkout/create-session` — **requires customer session** (no guest).
- `/api/checkout/submit-payment`, `/api/cart/restore` — unauthenticated
  capability URLs (order UUID).
- `/api/webhooks/payment|fulfillment` — HMAC signature.
- `/api/cron/sweep` — `CRON_SECRET` bearer.
- Public reads: catalog/*, coupons/featured, coa-records, health.
- Rate-limited: coupons/validate, contact, back-in-stock, partner/apply,
  partner/referral-code(+check), analytics/track.

### A5. Database (core tables)
`orders` (natural key `order_id text unique`; money `numeric(12,2)`;
`payment_status`, `fulfillment_status`, `ambassador_id`, `paid_side_effects_at`
idempotency claim), `order_items` (FK→orders ON DELETE CASCADE),
`payment_events` (`event_id` PK = idempotency key), `products`/`product_doses`/
`product_images`, `inventory_items`, `coupons`, `customer_memberships`/
`membership_tiers`, `partners`+`ambassadors` (dual mirror), `referral_orders`
(authoritative commission ledger) + `commissions` (mirror), `partner_payouts`+
`payouts`, `commission_tier_rules`, `store_credit_ledger`, `points_ledger`,
`customer_addresses`/`wishlist_items`/`customer_preferences`,
`admin_credentials`/`admin_sessions`/`admin_audit_logs`, `rate_limit_hits`,
`website_analytics_events`, `back_in_stock_requests`, `email_send_log`.
RLS enabled deny-by-default across all tables (`rls-enforce-all-tables.sql`).

### A6. External services
Supabase (DB/auth), payment processor (abstracted; **live provider inert — no
real card capture yet**; mock blocked in prod), email (Resend/SendGrid/SMTP),
fulfillment 3PL (optional; disabled → everything shows "In Stock"), Cloudflare
Turnstile (auth CAPTCHA, verified by Supabase). No SMS/Twilio wired.

### A7. Money model (server-authoritative)
The client computes **previews only**; the server recomputes everything in
`payment-service.ts createCheckoutSession` using the shared `profit-engine.ts`
rulebook. The only client-submitted money value is `expectedTotal`, used **only**
as an underpayment tripwire (client can never lower the charge).
- **Prices/costs** re-resolved from DB per line (dose or product).
- **Discounts** — one best discount wins (`resolveCustomerDiscount`): bundle
  bucket vs referral % vs membership % vs bulk vs personal vs coupon; coupon may
  stack on top only if `allowCouponStacking`.
- **Auto promo** — cheapest-of-every-4 free (Buy-3-Get-1).
- **Shipping** — `calculateShipping(subtotal,…)` evaluated on **pre-discount**
  subtotal; free ≥ $250 (intl $600) or via member/bulk perk.
- **Handling fee** — always $0 (intentionally).
- **Card processing fee** — added on card method only.
- **Tax** — on post-discount merchandise.
- **Store credit / points** — applied after totals, capped to live balance.
- **Profit guard** — `computeProfit` blocks any order below the configured floor
  (default break-even). Commission is priced at the **effective (max) tier %**.
- **Commission** — recomputed at settlement (`payment-webhook`) on
  `commissionableSubtotal = subtotal − discount` (excl. shipping/tax/fee).

### A8. Order statuses
`payment_status`: `pending_payment` → `awaiting_verification` (manual proof) →
`paid` | `payment_rejected`/`payment_failed` | `canceled` → `refunded` |
`partially_refunded`. Event→status via `getOrderStatusForEventType`.
`fulfillment_status`: `pending` → `awaiting_fulfillment` (on paid) →
`processing`/`shipped`/`delivered`/`fulfilled`/`partially_fulfilled`/`cancelled`.
Illegal money transitions blocked in the webhook and admin PATCH.

### A9. Admin permissions (RBAC)
`canManageRefunds/Coupons/Inventory/Products/Settings/Membership/CartRecovery/
ViewProfit/ViewAuditLog` = manager+; `canManageTeam` = super_admin only;
unknown role → least-privilege `staff`. Admin sessions re-check `is_active`
every request and purge sessions for deactivated admins.

### A10. Notifications / email
Order confirmation, manual-payment received/verified/rejected, refund, shipment/
tracking, abandoned-cart recovery, ambassador approval/rejection/payout,
membership billing, back-in-stock, welcome offer, unsubscribe (HMAC). Multi-
provider with a retry queue swept by cron.

### A11. Where money or inventory can go wrong (watch-points)
1. Profit guard omits real outbound **shipping cost** → thin-margin/free-ship
   orders can finalize at a small cash loss. **(F1)**
2. **Partial refund** recorded as full `refund_amount` + status `refunded`
   → reconciliation/net-revenue wrong. **(F2)**
3. **Disabled ambassador** still paid already-approved commissions. **(A1)**
4. **Refund after payout** never auto-claws-back paid commission. **(A2)**
5. **Referral clicks don't convert** — cookie set at `/r` but never read at
   checkout; only manually-typed codes attribute. **(A3)**
6. **Duplicate-account self-referral** earns commission (flag-only heuristic). **(A4)**
7. Tier threshold compares an **order count** to a "sales" ($) field. **(A6)**
8. Store-credit/points redemption **bypass the profit guard**. **(F4)**
9. Payout mirror-ledger (`commissions`) can **drift** from `referral_orders`. **(A8)**
10. Inventory decremented on paid; restored on refund/cancel via atomic
    exactly-once claim (this part is sound).

---

## B. CONSOLIDATED FINDINGS REGISTER

Severity: 🔴 High · 🟠 Medium · 🟡 Low · ⚪ Info. Status set as phases proceed.
Verified = read the code and confirmed the defect.

### Financial engine (Phase 3)
| ID | Sev | Finding | Location | Status |
|----|-----|---------|----------|--------|
| F1 | 🟠 | Profit guard passes `shippingCost:0`; real outbound shipping never in loss check | payment-service.ts:506 | Verified |
| F2 | 🟠 | Partial refund recorded as full `refund_amount` + status `refunded` (no partial event mapping) | payment-webhook.ts:1316-1324; :35-51 | Verified |
| F3 | 🟠 | Client hard-codes referral discount at 10%; server honors admin %; divergence breaks preview / trips tamper guard | cart-context.tsx:136,554 | Verified |
| F4 | 🟠 | Store-credit + points applied after the profit guard (bypass loss check) | payment-service.ts:519-549 | Verified |
| F5 | 🟡 | Coupon stacking is server-only; client preview shows higher total | profit-engine.ts:170 vs cart-context.tsx:580 | Verified |
| F6 | 🟡 | Duplicated money formulas (Buy-3-Get-1, coupon, ~9 `round` copies) — drift risk | multiple | Verified |
| F7 | 🟡 | Dead `bundleReferralPercent` field; comments overstate behavior | profit-engine.ts | Verified |

### Customer experience (Phase 2)
| ID | Sev | Finding | Location | Status |
|----|-----|---------|----------|--------|
| C1 | 🔴 | Age gate promises guest checkout ("just your email"); checkout hard-requires an account | age-gate.tsx:139 vs create-session:32-40 | Verified |
| C2 | 🟠 | Membership monthly consent text says "includes 5% processing fee"; price/code add none | membership-subscribe-client.tsx:126 vs :21-24 | Verified |
| C3 | 🟠 | Membership CTA sends `?redirect=`; login only reads `?next=` → user dumped on homepage | membership subscribe:23 vs account-auth-form:63 | Verified |
| C4 | 🟠 | "Order total changed" dead-end when server applies fewer discounts than stale preview; no inline recovery | payment-service.ts:557; create-session:84 | Verified |
| C5 | 🟠 | Cart line totals use DEFAULT bundle config while subtotal uses server config → rows don't sum under non-default config | cart-drawer.tsx:172; cart-client.tsx:90; checkout:812 | Verified |
| C6 | 🟡 | Empty-cart flash before localStorage hydration (no `isHydrated` gate) | cart-context.tsx:154 | Verified |
| C7 | 🟡 | Wishlist/addresses loaders un-`catch`ed → whole route crashes on transient DB error | wishlist/page.tsx:14; addresses/page.tsx:13 | Verified |
| C8 | 🟡 | Featured-coupon banner only on /products & PDP, copy-only (no one-tap apply) | products-client.tsx:167; product-detail:249 | Verified |
| C9 | 🟡 | Stock UI inert while fulfillment disabled (In-Stock filter, OOS badge, back-in-stock all dead) | catalog.ts:17-22 | Verified |
| C10 | ⚪ | Order-confirmation/pay pages expose order PII to anyone with the UUID (by design) | order-confirmation:18; pay:11 | Verified |

### Ambassador system (Phase 4)
| ID | Sev | Finding | Location | Status |
|----|-----|---------|----------|--------|
| A1 | 🔴 | Disabled ambassadors still paid already-approved commissions (no status check at payout) | partner-portal.ts:1462-1466, 711-718 | Verified |
| A2 | 🟠 | No clawback after payout: refund/chargeback post-payment only flags manual_review | payment-webhook.ts:56-61, 668-675 | Verified |
| A3 | 🟠 | Cookie attribution dead: `/r` sets `vl_referral_code`, checkout never reads it | r/[code]:60; payment-service.ts:356 | Verified |
| A4 | 🟠 | Duplicate-account self-referral not blocked (only same email/auth id) | payment-service.ts:388-393 | Verified |
| A5 | 🟠 | Chargebacks share partial-refund proration → residual commission on full chargeback | payment-webhook.ts:45-47, 1281-1284 | Verified |
| A6 | 🟠 | Tier `min_monthly_sales` compared to an **order count**, not dollars | ambassador-commission.ts:115,158 | Verified |
| A7 | 🟠 | Application preferred-code bypasses reserved-word/profanity + full uniqueness | partner-portal.ts:410-421 | Verified |
| A8 | 🟠 | Payout flips `commissions` mirror by partner_id+status, not claimed ids → ledger drift | partner-portal.ts:1527-1535 | Verified |
| A9 | 🟠 | `clearFraudFlag` leaves `payment_status="manual_review"` stuck → money never payable | admin-ambassadors.ts:93-96 | Verified |
| A10 | 🟠 | `GET /api/admin/ambassadors/fraud` missing `canManageRefunds` gate (PII to any admin role) | fraud/route.ts:14-22 | Verified |
| A11 | 🟡 | No audit row for payout-method change / fraud-flag clear / self code change | partner-portal.ts:662; admin-ambassadors.ts:78 | Verified |
| A12 | 🟡 | Program stats padded with admin baseline (don't reconcile with ledger) — intentional marketing | partner-portal.ts:594-604 | Verified |
| A13 | 🟡 | recentOrders can mislabel a paid order as pending | partner-portal.ts:871 | Verified |
| A14 | 🟡 | Dead `createReferralOrderRecord` computes commission on gross total (footgun + wrong-base test) | referral-service.ts:29,88 | Verified |

### Backend / security (Phase 6)
| ID | Sev | Finding | Location | Status |
|----|-----|---------|----------|--------|
| S1 | 🟠 | Webhook signs body only; `event_id` outside signature + no timestamp/nonce → replay (mitigated by order-level guards) | webhooks/payment/route.ts:9,20 | Verified |
| S2 | 🟠 | Fulfillment webhook has no event-level idempotency at route (relies on downstream) | webhooks/fulfillment/route.ts | Needs check |
| S3 | 🟠 | `checkout/submit-payment` unauthenticated, no rate limit, file-upload + email surface | submit-payment/route.ts:21-40 | Verified |
| S4 | 🟡 | No schema-validation library; request bodies hand-cast with `as {…}` | admin write routes | Verified |
| S5 | 🟡 | `analytics/track` rate-limit keyed on client-supplied sessionId (bypassable) | analytics/track:87 | Verified |
| S6 | 🟡 | `cron/sweep` secret compared with `!==` (not constant-time) | cron/sweep:23 | Verified |
| S7 | ⚪ | Service-role-only DB path: one forgotten in-route check = unmitigated (no RLS second layer) | architectural | Noted |

---

*Phase 1 complete. Phases 2–6 will verify-before-fix each item above, preserve
working behavior, and re-run the full suite after every change.*
