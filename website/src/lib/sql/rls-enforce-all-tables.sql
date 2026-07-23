-- Deny-by-default Row Level Security for every public table.
--
-- WHY: NEXT_PUBLIC_SUPABASE_ANON_KEY ships to the browser and Supabase
-- PostgREST is internet-facing, so ANY public table without RLS enabled is
-- world-readable/writable with that key. This application reads and writes all
-- business data through server routes using the service-role key
-- (src/lib/supabase-server.ts), and the service_role Postgres role has the
-- BYPASSRLS attribute — so enabling RLS here NEVER affects the app's own
-- server code. It only slams the door on direct anon/authenticated access.
--
-- Enabling RLS on a table that has no policy makes it deny-by-default: the
-- anon and authenticated roles see zero rows and can write nothing. Tables that
-- already carry user-scoped policies (orders, customer_addresses, partner_*,
-- etc. from their own migrations) keep those policies untouched — this file
-- only guarantees the RLS switch is ON everywhere.
--
-- BEHAVIOR NOTE: the admin control center's live auto-refresh subscribes to
-- `admin_audit_logs` realtime with the anon key. Once RLS is enabled there,
-- that anon subscription receives no rows (which is correct — audit logs must
-- not be anon-readable); the dashboard still loads and can be refreshed
-- normally. No storefront or checkout path depends on anon table reads.
--
-- Idempotent: `enable row level security` is a no-op when already enabled.
-- Run this after all other migrations. Verify afterward with the query at the
-- bottom (Supabase SQL editor) — it must return zero rows.

do $$
declare
  target text;
  tables text[] := array[
    -- Highly sensitive (credentials, sessions, PII, money)
    'admin_credentials', 'admin_sessions', 'admin_login_attempts', 'admin_audit_logs',
    'orders', 'order_items', 'order_shipments', 'payment_events', 'payouts',
    'partner_payouts', 'fulfillment_payouts', 'commissions', 'commission_tier_rules',
    'customer_addresses', 'customer_preferences', 'customer_memberships',
    'store_credit_ledger', 'points_ledger', 'promotional_point_events',
    -- Operational
    'products', 'product_doses', 'product_images', 'product_subscriptions',
    'inventory_items', 'coupons', 'membership_tiers', 'membership_billing_events',
    'ambassadors', 'partners', 'partner_clicks', 'partner_program_stats',
    'referrals', 'referral_orders',
    'abandoned_carts', 'abandoned_cart_emails', 'back_in_stock_requests',
    'wishlist_items', 'email_send_log', 'email_suppressions', 'notification_queue',
    'fulfillment_orders', 'fulfillment_events', 'website_analytics_events'
  ];
begin
  foreach target in array tables loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = target
    ) then
      execute format('alter table public.%I enable row level security;', target);
    end if;
  end loop;
end $$;

-- Verification (run manually in the Supabase SQL editor; expect zero rows):
--   select tablename
--   from pg_tables
--   where schemaname = 'public'
--     and rowsecurity = false;
