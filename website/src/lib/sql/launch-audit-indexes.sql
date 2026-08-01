-- Launch-audit performance indexes. Idempotent — safe to run any time.
--
-- Run this in the Supabase SQL editor before launch.

-- 1) admin_audit_logs(action, created_at desc)
--    getControlSnapshot() reads the LIVE storefront config by scanning this
--    append-only table filtered by `action = 'admin_control_upsert'` ordered by
--    created_at, on EVERY storefront page render. There was no index on
--    `action`, so the filter rode the created_at index and discarded non-config
--    rows inline — a scan that grows with every admin action ever logged.
--    This composite index makes that read an index range scan.
create index if not exists idx_admin_audit_logs_action_created
  on public.admin_audit_logs (action, created_at desc);

-- 2) orders(lower(customer_email))
--    Customer order lookups match on the email case-insensitively. A plain
--    btree on customer_email can't serve a case-insensitive match; this
--    expression index lets a lower(customer_email) = lower($1) predicate use an
--    index instead of sequentially scanning orders as the table grows.
create index if not exists idx_orders_lower_customer_email
  on public.orders (lower(customer_email));

-- 3) points_ledger(user_id) is already indexed (idx_points_ledger_user_id);
--    listed here only as a reminder that the admin "customer balances" view
--    aggregates the whole ledger in memory and should be moved to a SQL
--    group-by / rollup table if transaction volume grows large.
