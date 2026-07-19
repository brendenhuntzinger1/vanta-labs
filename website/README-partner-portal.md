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

## 3) Auth + role model

- Supabase Auth is used for partner/admin signup and login.
- Set role as `admin` or `partner` in `app_metadata.role` for users.
- A secure session cookie (`vl_session_token`) is established through `POST /api/auth/session`.

## 4) Partner onboarding flow

1. Visitor opens `/partner` landing page.
2. Visitor creates account from landing page application section.
3. `POST /api/partner/apply` creates partner record with status `pending`.
4. User is redirected to `/partner/pending`.
5. Admin approves in `/admin/partners`.
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
3. Approve partner from `/admin/partners`.
4. Open referral link `/r/<code>` in private browser.
5. Add product to cart and complete checkout.
6. Trigger payment webhook `payment.succeeded`.
7. Confirm records in:
   - `public.referrals` (click)
   - `public.orders` (attributed order)
   - `public.commissions` (pending commission)
8. Mark commissions paid in admin and confirm `public.payouts` row is created.
