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

Templates live in `src/lib/email/templates.ts`. Two are built but not
wired into a live flow yet, since the flows they belong to don't exist in
the app yet:
- **Email verification** — Supabase Auth's own built-in confirmation email
  is what actually runs today (configured in the Supabase Dashboard under
  Authentication → Email Templates, not in this codebase). This template is
  ready if you later build a custom verification flow instead.
- **Password reset** — there's no forgot-password page in the app yet (no
  customer-account system exists). This template is ready for when that's
  built.

## 3) Auth + role model

- Supabase Auth is used for partner/admin signup and login.
- Set role as `admin` or `partner` in `app_metadata.role` for users.
- A secure session cookie (`vl_session_token`) is established through `POST /api/auth/session`.

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
- Commission percentage updates
- Mark commissions as paid
- Search/filter
- CSV export via `/api/admin/partners/export-payouts`
- Audit logs written to `admin_audit_logs`

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
