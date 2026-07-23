# Vanta Labs — Platform Audit & Hardening Report

**Date:** 2026-07-23
**Scope:** Full engineering, security, business-logic, compliance, and UX audit of the
`website/` Next.js 16 + Supabase e-commerce platform (331 files, ~38k LOC).

This report is the QA checklist. Every item is marked **✅ Fixed & verified**,
**📋 Documented** (ready-to-apply patch below; deferred because it changes the
live payment/DB path and must be verified against a staging database first — the
store's stability comes first), or **✅ Verified correct** (audited, no change
needed).

---

## 1. Verification gates (this branch)

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` (type-check) | ✅ clean |
| `npm run lint` (ESLint) | ✅ clean |
| `npm test` (Vitest) | ✅ **60 passed** (was 45; +15 new passcode tests) |
| `npm run build` (production build) | ✅ compiled successfully, exit 0 |

The audit itself was run as five parallel deep passes (security, business/money
math, checkout/order/inventory reliability, email, compliance/UX). Because this
environment has no live Supabase or payment processor, flows that require a real
database/processor are reasoned through the code and, where they change money or
order state, are shipped only when self-contained and left as documented patches
otherwise. Nothing here is claimed "tested" that was not actually exercised.

---

## 2. Shipped this pass

### Security

- **✅ Admin second factor (6-digit passcode).** *Explicitly requested.* After a
  correct username + password at `/vault`, the admin must now enter a 6-digit
  passcode before any session is issued. Per-account passcode (scrypt salt+hash,
  same scheme as passwords) with an `ADMIN_ACCESS_CODE` env fallback so a fresh
  deployment is never locked out. A wrong passcode counts toward the existing
  lockout, and every failure returns one generic message so an attacker can't
  tell which of the three factors was correct.
  - New: `src/lib/admin-passcode.ts` (+ `admin-passcode.test.ts`, 15 tests),
    `src/lib/sql/admin-passcode-2fa.sql`.
  - Wired: `admin-auth.ts`, `api/admin/auth/login/route.ts`, `vault/page.tsx`,
    `admin-team.ts`, `api/admin/team/[username]/route.ts`, `admin-team-client.tsx`
    (**Set/Change passcode** action + status column), `create-admin-credential.mjs`
    (optional 4th arg), `.env.example`, `DEPLOY.md`.

- **✅ Deny-by-default RLS on all 42 public tables.** The `NEXT_PUBLIC` anon key
  ships to browsers and PostgREST is internet-facing, so any table without RLS
  was world-readable — including `admin_credentials` (password hashes) and
  customer PII. Every data path in this app uses the service-role key (which
  bypasses RLS), and the anon client only does Supabase Auth + one
  `security definer` RPC, so enabling RLS everywhere is safe.
  - New: `src/lib/sql/rls-enforce-all-tables.sql`; also appended to
    `deploy-run-once.sql` (CHUNK 4) and `schema-complete-sync.sql`.
  - Note: the admin control-center's realtime auto-refresh subscribed to
    `admin_audit_logs` with the anon key; it will no longer receive live events
    (correct — audit logs must not be anon-readable). The dashboard still loads
    and refreshes normally.

- **✅ Role-gated all product mutation routes.** Create/update/delete/import/
  reorder/duplicate and image upload were gated on *session only*, so a lowest-
  tier `staff` admin could change prices, delete the catalog, and edit inventory
  — bypassing the manager-only inventory gate. Added `canManageProducts` (manager+)
  to all of them. Image upload also gained a strict content-type allow-list and an
  8 MB cap.
  - `admin-roles.ts`, `api/admin/products/**`, `api/admin/upload-image/route.ts`.

### Money integrity (ambassador-critical)

- **✅ Ambassador payouts: amount is now derived from real commissions, and
  duplicate payouts are prevented.** `markCommissionsPaid` previously trusted an
  admin-supplied `amount` decoupled from the actual commissions (an admin could
  flip $500 of commissions to "paid" while recording a $50 payout), and had no
  concurrency guard (a double-click paid twice). Now the amount is the summed
  `approved_for_payout` commissions, and the rows are claimed with a
  status-guarded conditional update (`.eq("payment_status","approved_for_payout")
  .select()`) so a concurrent second call claims zero rows and inserts no
  duplicate payout.
  - `partner-portal.ts`, `api/admin/partners/[partnerId]/route.ts`.

- **✅ `update_status` can no longer bypass refund reversal.** Setting
  `payment_status` to `paid`/`refunded`/`partially_refunded` through the order
  status form only changed the column and silently skipped commission/points/
  store-credit reversal. Those transitions are now rejected and directed to the
  proper payment-verification / refund actions.
  - `api/admin/orders/[orderId]/route.ts`.

- **✅ Refunds now return the points the customer *spent*.** A full refund clawed
  back *earned* points and store credit but never re-credited *redeemed* points,
  so a refunded customer permanently lost the points they'd spent. Added
  idempotent `restoreRedeemedPoints`, wired into both refund paths (admin route +
  payment webhook).
  - `membership.ts`, `api/admin/orders/[orderId]/route.ts`, `payment-webhook.ts`.

- **✅ Payment webhook won't resurrect a refunded order.** A late/replayed
  `payment.succeeded` (new `event_id`) arriving after a refund would flip the
  order back to `paid` and re-award commission/points/coupon/email/3PL. Added a
  terminal-state guard that records the event and stops.
  - `payment-webhook.ts`.

### Compliance / UX

- **✅ Removed unsubstantiated superlative** "USA's Purest Source" from the
  product page (FTC substantiation risk) → "Research Use Only".
- **✅ Renamed "Dosage" → "Vial Size"** on product pages and admin, since
  "Dosage" implies human administration and undercuts the research-use-only
  posture. (`product-detail-client.tsx`, `admin/products/page.tsx`.)

---

## 3. Full findings inventory

### A. Security

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| S1 | CRITICAL | RLS not enabled on all tables → anon key can read password hashes & PII | ✅ Fixed |
| S2 | HIGH | Product mutation routes gated on session only, not role | ✅ Fixed |
| S3 | MEDIUM | No rate limiting on public POSTs (coupons/validate, welcome-offer, back-in-stock, partner/apply) | 📋 Documented |
| S4 | MEDIUM | In-memory rate limiter (contact, reorder) is per-instance, resets on cold start | 📋 Documented |
| S5 | MEDIUM | `admin/metrics` has no role check (any admin tier sees revenue) | 📋 Documented |
| S6 | LOW | `upload-image` trusted client MIME only | ✅ Fixed (allow-list + size cap) |
| S7 | LOW | `analytics/track` unauthenticated, uncapped (table bloat/DoS) | 📋 Documented |
| — | — | Webhook signatures, secret separation, CSRF, IDOR, open-redirect, admin login hashing/lockout | ✅ Verified correct |

### B. Checkout / order / inventory reliability

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| R1 | CRITICAL | Inventory is never decremented on sale; oversell guard is a static read → unbounded overselling | 📋 Documented (patch below) |
| R2 | HIGH | Webhook accepts out-of-order events; refunded order can flip back to paid | ✅ Fixed (terminal-state guard) |
| R3 | HIGH | Card webhook "paid" side-effects have no atomic per-order claim (distinct event_ids double-award) | 📋 Documented (patch below) |
| R4 | HIGH | No checkout idempotency → refresh/retry/double-submit creates duplicate orders | 📋 Documented (patch below) |
| R5 | HIGH | Order + order_items inserted without a transaction → partial failure orphans an order | 📋 Documented |
| R6 | MED/HIGH | Points & store credit can be double-spent across concurrent pending orders | 📋 Documented |
| R7 | MED/HIGH | `update_status` set arbitrary payment_status, bypassing reversal | ✅ Fixed |
| R8 | MEDIUM | `submit-payment` has no ownership auth; re-sends emails on every call | 📋 Documented |
| R9 | MEDIUM | Price increase between add-to-cart and checkout → hard "Altered total" error instead of reprice | 📋 Documented |
| — | — | Server re-prices authoritatively (client cart price never trusted); refund can't exceed total or double-refund; `finalizeManualPayment` atomic claim | ✅ Verified correct |

### C. Business logic / money math

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| M1 | HIGH | Partner payout amount admin-supplied + no duplicate-payout guard | ✅ Fixed |
| M2 | HIGH | Card webhook overwrites order totals from payload → zeroes commission | 📋 Documented |
| M3 | HIGH | Membership tier change: no proration, stale next-billing amount; card annual auto-renews monthly | 📋 Documented |
| M4 | MED/HIGH | Redeemed loyalty points never returned on refund | ✅ Fixed |
| M5 | MEDIUM | Store credit frozen at checkout vs capped at payment → unbacked discount if balance dropped | 📋 Documented |
| M6 | MEDIUM | Coupon redemption limit exceeded under concurrency (cap only checked at validate) | 📋 Documented |
| M7 | MEDIUM | Money is float-dollars-with-rounding, not integer cents (systemic, latent) | 📋 Documented |
| M8 | LOW | `bundleDiscountedLineTotal` double-rounds | 📋 Documented |
| M9 | LOW | Dead `createReferralOrderRecord` computes commission on full total incl. shipping/tax | 📋 Documented |
| M10 | LOW | Coupon "minimum order" not implemented | 📋 Documented |
| M11 | LOW | Commission tier fallback grants lowest tier below its threshold | 📋 Documented |
| — | — | Single "greatest discount wins" (no stacking); totals never go negative; store-credit/points integer-cents | ✅ Verified correct |

### D. Email

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| E1 | HIGH | Account-verification & password-reset use Supabase's default mailer; branded templates are dead → emails may silently not send if only the in-app provider is configured | 📋 Documented |
| E2 | MEDIUM | Support email hardcoded in every email footer; diverges from the admin-editable setting | 📋 Documented |
| E3 | LOW | Dead marketing templates (product launch, birthday, monthly benefits) | 📋 Documented |
| E4 | LOW | Membership welcome sent as *marketing* (suppressible) | 📋 Documented |
| — | — | Graceful send failure (never crashes a request), dedup on order/commission/shipping, transactional vs marketing unsubscribe separation | ✅ Verified correct |

### E. Compliance

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| L1 | MEDIUM | "Dosage" label implies human use | ✅ Fixed |
| L2 | MEDIUM | "USA's Purest Source" unsubstantiated superlative | ✅ Fixed |
| L3 | MEDIUM | Membership signup auto-bills a stored "request" when a processor connects (negative-option / card-rule risk) | 📋 Documented |
| L4 | LOW | Cookie "Decline" is cosmetic; analytics load either way (EU/UK risk) | 📋 Documented |
| L5 | LOW | Age gate wraps legal pages too; client-side only | 📋 Documented |
| — | — | All 6 policies present & wired, age gate, cookie banner, RUO disclaimers, checkout acknowledgements | ✅ Verified correct |

### F. UX

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| U1 | MEDIUM | Auth pages use old `SiteHeader`; rest of site uses `SiteHeaderV2` | 📋 Documented |
| U2 | LOW | Global chrome (age gate, footer, cookie banner) leaks into admin/legal | 📋 Documented |
| U3 | LOW | Support email hardcoded in site footer, diverges from settings | 📋 Documented |
| — | — | Products page loading/empty/error states, checkout field validation + submit guard, legal links resolve | ✅ Verified correct |

---

## 4. Top remaining recommendations (ready-to-apply patches)

These are ranked and deferred **only** because they change the live payment/DB
path and must be verified against a staging database before going near real
orders. Do them in this order.

### R1 — Inventory atomic decrement (stop overselling)

Add an atomic decrement RPC and call it at the paid moment; treat a 0-row result
as out-of-stock. This is the single biggest reliability gap.

```sql
-- migration
create or replace function public.decrement_inventory(p_product_id uuid, p_qty int)
returns boolean language plpgsql security definer as $$
declare updated int;
begin
  update public.products
     set inventory_quantity = inventory_quantity - p_qty
   where id = p_product_id and inventory_quantity >= p_qty;
  get diagnostics updated = row_count;
  return updated > 0;   -- false = insufficient stock
end $$;
```

Call it in the paid transition (`finalizeManualPayment` and the webhook paid
block), summing quantity per product across lines; on `false`, flag the order for
review rather than silently overselling.

### R3 — Atomic "paid" claim on the card webhook path

Mirror `finalizeManualPayment`'s pattern: gate the paid side-effects on a
conditional single-row update
`update orders set payment_status='paid' where order_id=$1 and payment_status <> 'paid' returning *`
and run points/commission/coupon/email **only** when a row was claimed.

### R4 / R5 — Checkout idempotency + transactional order creation

Add an `orders.idempotency_key` column; have the client generate one UUID per
checkout attempt and send it; upsert/dedupe on it server-side. Insert `orders`
and `order_items` inside one RPC/transaction so a partial failure can't orphan an
order.

### M2 — Stop the webhook overwriting stored order totals

For an existing order, read `subtotal/discount/shipping/amount_paid` from the
stored row (as `finalizeManualPayment` does) instead of the webhook payload's
top-level fields, and compute commission/points from the persisted order.

### M3 — Membership proration + annual renewal cadence

On tier change, set `next_billing_amount_cents` to the new tier's cycle price;
branch the renewal sweep on `billing_cycle` so annual re-bills the annual amount
at +365 days instead of silently converting to monthly.

### M6 — Coupon over-redemption race

Enforce `max_redemptions` inside the atomic `redeem_coupon` RPC
(`update ... where redemptions_count < max_redemptions returning`) and void the
discount when it returns no row.

### E1 — Verify/reset email deliverability

Either configure Supabase Auth custom SMTP + templates, or add explicit
verify/reset routes that call `sendEmail()` with the existing branded templates.
Document the dependency in `DEPLOY.md` so signup/reset can't silently fail.

### S3/S4 — Shared rate limiting

Back the public POST limiters (coupons/validate, welcome-offer, back-in-stock,
partner/apply, contact, reorder) with a shared store (a Supabase table or Redis)
keyed on IP+identifier, so limits survive cold starts and coordinate across
instances.

### Lower priority

- **M5** store-credit reconcile at charge time · **R8** ownership auth on
  `submit-payment` · **R9** reprice-prompt instead of hard error · **L3**
  membership re-consent at first real charge · **U1** unify auth pages onto
  `SiteHeaderV2` · **E2/U3** thread support email from settings into email/footer
  · **S5** role-gate `admin/metrics` · **E3** wire or delete dead templates.

---

## 5. Admin second-factor — operator guide

1. **Turn it on** one of two ways:
   - Global: set `ADMIN_ACCESS_CODE` (6 digits) in Vercel env — applies to every
     admin.
   - Per-admin (takes precedence): **Admin → Team → Set passcode**, or
     `node scripts/create-admin-credential.mjs <user> <password> <role> <passcode>`.
2. **Log in** at `/vault` with username + password + the 6-digit passcode.
3. If neither is set, login falls back to username + password (no lockout);
   set one to enforce the second factor.
4. Wrong passcodes count toward the existing 6-attempt / 15-minute lockout.
