# Partner Program Setup

This project now includes a premium public Partner Program landing page plus private partner/admin dashboards backed by Supabase.

## 1) Environment

Ensure these env vars are set:

- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## 2) Database migrations

Run these SQL files in order from Supabase SQL Editor:

1. `src/lib/sql/orders-schema.sql`
2. `src/lib/sql/orders-rls.sql`
3. `src/lib/sql/affiliate-program-schema.sql`
4. `src/lib/sql/affiliate-program-rls.sql`
5. `src/lib/sql/partner-portal-schema.sql`
6. `src/lib/sql/partner-portal-rls.sql`
7. `src/lib/sql/partner-system-repair.sql` — **required, not optional.** This is the
   only migration that creates `public.products`, `public.product_images`,
   `public.product_doses`, `public.website_analytics_events`, the base
   `public.ambassadors` table, and the admin-login tables
   (`public.admin_credentials`, `public.admin_sessions`,
   `public.admin_login_attempts`). Without it the storefront catalog, site
   analytics, referral codes, and `/admin` login will not work. It is
   idempotent (`if not exists` / `if exists` guards throughout) and safe to
   run after the files above, and safe to rerun.
8. `src/lib/sql/referral-code-rpc.sql` — **required.** Creates the
   `validate_referral_code` function the cart page calls (via
   `supabase.rpc`) to preview a referral discount before checkout. Without
   it, referral-code checkouts fail with "Altered total detected" because
   the cart shows a total that doesn't include the discount the server
   applies.
9. `src/lib/sql/admin-rbac-refunds.sql` — **required.** Adds
   `admin_credentials.role` (`staff` | `manager` | `super_admin`, see
   `src/lib/admin-roles.ts`) and `orders.refund_amount` /
   `orders.refunded_at` for partial-refund tracking. Existing admin rows
   default to `staff` on this migration — promote at least one account to
   `super_admin` afterward (see §2a) so someone can grant roles to others
   from `/admin/team`.
10. `src/lib/sql/coupon-checkout-columns.sql` — **required.** Adds
    `orders.coupon_code` so coupon redemptions can be tracked and reported
    on.
11. `src/lib/sql/order-shipment-management.sql` — **required.** Adds a
    unique constraint on `order_shipments.order_id` so the admin order
    detail page can upsert one shipment record (carrier, tracking,
    estimated delivery) per order.
12. `src/lib/sql/inventory-thresholds.sql` — **required.** Adds
    `low_stock_threshold` to `products` and `product_doses` so
    `/admin/inventory` can flag lines that need restocking.
13. `src/lib/sql/customer-accounts.sql` — **required.** Adds an RLS policy
    letting a signed-in customer read their own `orders`/`order_items` rows
    by email, plus `customer_addresses`, `wishlist_items`, and
    `customer_preferences` tables (all owner-scoped via `auth.uid()`) for
    `/account`.
14. `src/lib/sql/membership-rewards.sql` — **required.** Adds
    `membership_tiers` (seeded with Research Member / Plus / Elite),
    `customer_memberships`, `points_ledger`, `promotional_point_events`, and
    `birthday`/`referral_code`/`referred_by_code` columns on
    `customer_preferences` for the Membership & Rewards program (see §10).
15. `src/lib/sql/ambassador-commission-rules.sql` — **required.** Adds
    `commission_tier_rules` (seeded 10% / 12.5% at 20 monthly sales / 15% at
    50 monthly sales), `commission_percent_locked` on `partners`/
    `ambassadors`, and `tier_name`/`ineligible_reason`/`fraud_flag`/
    `fraud_reason` columns on `referral_orders`/`commissions` for automatic
    performance-tier commissions and fraud review (see §11).

Optional follow-up hardening (run after the above, in Supabase SQL Editor,
only if you want to apply the latest Supabase Performance/Security Advisor
recommendations):

- `src/lib/sql/supabase-performance-advisor-upgrade.sql`
- `src/lib/sql/supabase-performance-advisor-final.sql`
- `src/lib/sql/supabase-performance-advisor-verification.sql` (read-only checks)
- `src/lib/sql/supabase-advisor-remaining-fixes.sql`

## 2a) Create the first admin login

`/admin` authenticates against `public.admin_credentials`, which starts empty
— there is no default account. Create the first one with:

```bash
node scripts/create-admin-credential.mjs <username> <password> [role]
```

This hashes the password with the same scrypt scheme `src/lib/admin-auth.ts`
verifies against and upserts the row via the Supabase service role key. Re-run
it with the same username to rotate a password — omitting `role` on a rerun
leaves the account's existing role untouched. `role` is one of `staff` |
`manager` | `super_admin` (see `src/lib/admin-roles.ts`); a brand-new account
defaults to `super_admin` since this script is the only way to create the
first admin and someone needs full access to grant roles to everyone else
from `/admin/team`.

## 2b) Configure transactional email

Contact form notifications, order confirmations, shipping updates, and
ambassador emails (application received / approved / denied / referral code
assigned) all go through `src/lib/email/` — a provider-agnostic module, not
tied to any single vendor. Switch providers with **only an env var change**,
no code change:

Set `EMAIL_PROVIDER` to one of:

- `smtp` (default) — set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD`, and `SMTP_FROM`. This also covers **AWS SES**: SES
  exposes an SMTP endpoint with its own SMTP username/password (SES Console
  → Simple Mail Service → SMTP Settings) — point `SMTP_HOST` at that
  endpoint and use the SES SMTP credentials.
- `resend` — set `RESEND_API_KEY` and `EMAIL_FROM`.
- `sendgrid` — set `SENDGRID_API_KEY` and `EMAIL_FROM`.

**Until one of these is fully configured, no email actually sends.** Every
call site treats email as a non-critical side effect — the underlying
action (an order, an approval, a status change) always succeeds regardless,
and a failed/unconfigured send is logged, never silently claimed as
successful. Verify delivery by watching your provider's dashboard/logs
after triggering one of the flows in the test checklist below — this is not
something that can be verified without real provider credentials.

Templates live in `src/lib/email/templates.ts`. Two of them
(`emailVerificationTemplate`, `passwordResetTemplate`) are built but not
wired into a live flow, and stay that way even now that customer accounts
exist (`/account/login`, `/account/forgot-password`,
`/account/reset-password`): both flows use Supabase Auth's own built-in
emails (`supabase.auth.signUp` confirmation email and
`supabase.auth.resetPasswordForEmail`), configured in the Supabase
Dashboard under Authentication → Email Templates, not through this
codebase's email module. Building a custom verification/reset flow that
uses these two templates instead would mean replacing Supabase's own
token issuing and validation with your own — a larger change than adding
account pages on top of the mechanism Supabase already provides securely.

## 3) Auth + role model

- Supabase Auth is used for partner/admin/customer signup and login.
- Set role as `admin`, `partner`, or `customer` in `app_metadata.role` for users
  (`src/lib/auth-role.ts`). `/account/login` signs customers up with
  `role: "customer"` automatically.
- A secure session cookie (`vl_session_token`) is established through `POST /api/auth/session`.

### Customer accounts

- `/account/login` — combined sign up / sign in. New accounts go through
  Supabase's built-in email confirmation before the `vl_session_token`
  cookie is set (see §2b's note on email verification).
- `/account/forgot-password` + `/account/reset-password` — Supabase's
  built-in password recovery flow.
- `/account` (order history + reorder), `/account/addresses` (saved
  addresses), `/account/wishlist`, `/account/settings` (profile, password,
  email, notification preferences) all require a signed-in `customer` role
  and live under the `(dashboard)` route group in `src/app/account/`, which
  gates access centrally in its layout.
- Checkout remains guest-friendly; a signed-in customer's default saved
  address pre-fills the checkout form but nothing requires an account to
  buy.

## 4) Partner onboarding flow

1. Visitor opens `/partner` landing page.
2. Visitor creates account from landing page application section.
3. `POST /api/partner/apply` creates partner record with status `pending` and
   sends an "application received" email (see §2b for delivery setup).
4. User is redirected to `/partner/pending`, which shows status-specific
   copy (pending / info requested / rejected / disabled) fetched from
   `/api/partner/me`.
5. Admin reviews in `/admin/partners`: **Approve**, **Reject**, **Request
   Info** (status `info_requested`, no automatic email — the admin follows
   up directly), or **Disable**. Approve/Reject each send an email.
   Setting/changing a partner's referral code (via the Approve prompt or
   the same admin action) sends a separate "referral code assigned" email.
6. Approved users can access `/partner/dashboard`; non-approved users remain gated.

## 5) Referral tracking flow

- Partner referral link format: `/r/<REFERRAL_CODE>`
- Route captures click in `referrals` and `partner_clicks`, then stores `vl_referral_code` cookie
- Checkout automatically includes referral code from cookie when needed
- Successful payment webhook writes order + commission to `referral_orders` and `commissions`

## 6) Admin operations

`/admin/partners` includes:

- Approve/reject/disable partners
- Partner performance metrics
- Commission percentage updates (locks the partner out of automatic
  performance tiers - see below)
- Mark commissions as paid (blocked below the minimum payout threshold)
- Search/filter
- CSV export via `/api/admin/partners/export-payouts`
- Audit logs written to `admin_audit_logs`
- Commission tier rules editor (automatic commission-percent escalation by
  monthly qualifying sales)
- Fraud & review panel (self-referral blocks, repeat-address/email flags,
  refund-after-payout manual review)
- Top performers leaderboard
- Ambassador program settings: minimum qualifying order for a referral code
  ($100 default, admin-configurable), minimum payout threshold ($100
  default), commission hold/waiting period before a commission is eligible
  for payout (14 days default)

Commission rules, enforced automatically with no manual work required:

- Commission is calculated on the merchandise subtotal only (after any
  discount, before shipping) - never on shipping, service fees, or the
  order total.
- A referral code cannot be combined with Buy 3 Get 1 Free, a coupon code,
  or redeemed loyalty points - each is mutually exclusive with the others.
- Orders below the minimum qualifying order amount cannot apply a referral
  code at all.
- A shopper cannot refer themselves: checkout is blocked if the customer's
  email or signed-in account matches the referring ambassador's.
- Commissions only become payable after the configured hold/waiting period,
  and only for orders that are still paid (not refunded/canceled) at that
  point; a refund after payout is flagged for manual review instead of
  silently reversing paid-out money.

## 7) Canonical Supabase table locations

All canonical affiliate tables are in `public` schema:

- `public.partners`: partner identity, status, commission %, referral code
- `public.referrals`: click/conversion events and attribution metadata
- `public.commissions`: commission records per attributed order
- `public.orders`: order data with referral attribution (`ambassador_id`, `referral_code`)
- `public.payouts`: payout/payment history to partners
- `public.partner_program_stats`: configurable marketing stats shown on landing page

Manage from Supabase:

- Authentication users: Supabase Dashboard -> Authentication -> Users
- Partner statuses and commissions: Table Editor -> `public.partners`
- Referrals/clicks: Table Editor -> `public.referrals`
- Commission history: Table Editor -> `public.commissions`
- Payouts: Table Editor -> `public.payouts`
- Landing-page metrics overrides: Table Editor -> `public.partner_program_stats`

## 8) Optional baseline tables (included)

The schema also adds starter tables for:

- `inventory_items` (inventory tracking)
- `order_shipments` (shipping status)
- `coupons` (discount management)
- `notification_queue` (email/notification pipeline staging)

These are intentionally lightweight so they can be extended with your preferred fulfillment and notification providers.

## 9) End-to-end test checklist

1. Open `/partner` and create a partner account.
2. Confirm partner row exists in `public.partners` with `pending` status.
3. With email configured (§2b), confirm the "application received" email arrived.
4. Approve partner from `/admin/partners`; confirm the "approved" email arrived.
5. Open referral link `/r/<code>` in private browser.
6. Add product to cart and complete checkout.
7. Trigger payment webhook `payment.succeeded`.
8. Confirm records in:
   - `public.referrals` (click)
   - `public.orders` (attributed order)
   - `public.commissions` (pending commission)
9. Confirm the order-confirmation email arrived at the checkout email address.
10. From `/admin/orders/<orderId>`, update fulfillment status/tracking number and confirm a shipping-update email arrives; use "Resend confirmation" and confirm the order-confirmation email arrives again.
11. Mark commissions paid in admin and confirm `public.payouts` row is created.
