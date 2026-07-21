-- Index orders.paid_at for the admin revenue dashboard.
--
-- getRevenueWindowMetrics() and getRevenueTrend() (src/lib/admin-analytics.ts)
-- filter orders with `.gte("paid_at", …)` and `.is("paid_at", null)` on every
-- admin dashboard load. orders is already indexed on created_at,
-- customer_email, payment_status, referral_code and ambassador_id, but not
-- paid_at, so these date-window scans grow linearly with the table. This
-- partial index keeps them fast and stays small (only paid orders have a
-- paid_at).
--
-- Safe to run more than once.

create index if not exists idx_orders_paid_at on public.orders(paid_at) where paid_at is not null;
