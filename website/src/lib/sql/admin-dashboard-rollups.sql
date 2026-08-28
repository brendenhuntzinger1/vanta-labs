-- ============================================================================
-- Admin dashboard scalability rollups.
--
-- Several admin surfaces previously pulled large slices of `orders` into the
-- app and aggregated in JS, some behind silent row caps (revenue 10k, customers
-- 5k) that UNDERCOUNT once the store grows. These functions do the exact same
-- aggregation in Postgres (one grouped pass) so the numbers stay correct and
-- fast at 100k+ orders / 50k+ customers.
--
-- Every function mirrors the JS logic it replaces EXACTLY (same status filters,
-- same net-of-refund revenue, same buckets, same order_type exclusions). The app
-- falls back to the legacy JS path if a function is absent, so deploying the
-- code before/after running this migration is safe. Safe to run more than once.
--
-- DEPLOYMENT ORDER NOTE. The revenue functions below now exclude
-- order_type='replacement' so /admin/revenue counts the same sales the profit
-- dashboard does. The JS fallback applies the same exclusion, so the app is
-- correct either way — but an instance still running the OLD function bodies
-- keeps over-counting until this file is re-applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Revenue metrics (mirrors src/lib/admin-revenue.ts getRevenueMetrics).
--
-- REVENUE STATUSES = paid|completed|succeeded|partially_refunded
-- (ledger.ts REVENUE_ORDER_STATUSES). Owner's decision: a $200 order refunded
-- by $50 is $150 of revenue and is still an order. It used to be excluded
-- entirely by this filter, so its RETAINED revenue vanished from the revenue
-- page while admin-profit counted it — two numbers for one store.
--
-- Net revenue per order = amount_paid - refund_amount, rounded to 2dp per order
-- then summed (matches netOrderRevenue()).
--
-- SIGNED, NOT CLAMPED. This was `greatest(0, ...)` while the profit engine
-- subtracted the refund unfloored, so an order paid 100 and refunded 150 was
-- -50 on the profit dashboard and 0 here. ledger.netOrderRevenue now keeps the
-- sign and so does this: a clamp does not make the money come back, it reports
-- an order the store lost money on as having broken even. Proved by executing
-- this file's own definition against Postgres in
-- sql/bulk-savings-rollup-executed.test.ts, and guarded textually by
-- ledger-sql-parity.test.ts.
--
-- ledger-sql-parity.test.ts fails if this status list and REVENUE_ORDER_STATUSES
-- stop agreeing, so neither side can drift alone.
-- ---------------------------------------------------------------------------
create or replace function public.admin_revenue_summary(p_start_of_today timestamptz)
returns table (
  total_paid_revenue numeric,
  total_paid_orders bigint,
  processing_fees numeric,
  today_revenue numeric,
  today_orders bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with paid as (
    select
      round(coalesce(amount_paid, 0) - coalesce(refund_amount, 0), 2) as net,
      coalesce(card_processing_fee, 0) as fee,
      paid_at
    from public.orders
    where payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
      and coalesce(order_type, 'product') <> 'replacement'
  )
  select
    coalesce(sum(net), 0) as total_paid_revenue,
    count(*) as total_paid_orders,
    coalesce(sum(fee), 0) as processing_fees,
    coalesce(sum(net) filter (where paid_at is not null and paid_at >= p_start_of_today), 0) as today_revenue,
    count(*) filter (where paid_at is not null and paid_at >= p_start_of_today) as today_orders
  from paid;
$$;

create or replace function public.admin_revenue_by_method()
returns table (
  method text,
  revenue numeric,
  orders bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(payment_method, '') as method,
    round(coalesce(sum(round(coalesce(amount_paid, 0) - coalesce(refund_amount, 0), 2)), 0), 2) as revenue,
    count(*) as orders
  from public.orders
  where payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
    and coalesce(order_type, 'product') <> 'replacement'
  group by coalesce(payment_method, '')
  order by revenue desc;
$$;

-- SECURITY DEFINER functions are granted EXECUTE to PUBLIC by default on
-- create, which would let anon/authenticated callers invoke them via PostgREST
-- and read revenue/PII while bypassing RLS. Revoke that default and grant only
-- to service_role (the key the app uses).
revoke all on function public.admin_revenue_summary(timestamptz) from public;
revoke all on function public.admin_revenue_by_method() from public;
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_revenue_summary(timestamptz) to service_role;$q$;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_revenue_by_method() to service_role;$q$;
  end if;
end
$rpc_lockdown$;


-- ---------------------------------------------------------------------------
-- Customer rollup (mirrors src/lib/admin-customers.ts aggregateCustomers).
-- Aggregates guest/customer orders by lower(customer_email). totalSpent sums
-- NET revenue (amount_paid - refund_amount) for paid|partially_refunded|refunded
-- orders -- it used to sum GROSS amount_paid, so a customer whose order was
-- fully refunded still showed as having spent the whole amount. Name is taken
-- from the customer's LATEST order (may be null, matching the JS). Search
-- matches email OR name (case-insensitive). Returns a window total_count so the
-- caller gets the filtered total alongside the page in one round-trip.
-- p_limit NULL = no limit (used by CSV export). p_search NULL/'' = no filter.
-- ---------------------------------------------------------------------------
create or replace function public.admin_customer_rollup(
  p_search text default null,
  p_limit int default null,
  p_offset int default 0
)
returns table (
  email text,
  name text,
  order_count bigint,
  total_spent numeric,
  first_order_at timestamptz,
  last_order_at timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with agg as (
    select
      lower(trim(customer_email)) as email,
      count(*) as order_count,
      coalesce(sum(case when payment_status in ('paid', 'partially_refunded', 'refunded')
                        then round(coalesce(amount_paid, 0) - coalesce(refund_amount, 0), 2)
                        else 0 end), 0) as total_spent,
      min(created_at) as first_order_at,
      max(created_at) as last_order_at
    from public.orders
    where customer_email is not null and trim(customer_email) <> ''
    group by lower(trim(customer_email))
  ),
  named as (
    select distinct on (lower(trim(customer_email)))
      lower(trim(customer_email)) as email,
      customer_name as name
    from public.orders
    where customer_email is not null and trim(customer_email) <> ''
    order by lower(trim(customer_email)), created_at desc
  ),
  joined as (
    select a.email, n.name, a.order_count, a.total_spent, a.first_order_at, a.last_order_at
    from agg a
    left join named n on n.email = a.email
    where p_search is null or p_search = ''
      or a.email like '%' || lower(p_search) || '%'
      or lower(coalesce(n.name, '')) like '%' || lower(p_search) || '%'
  )
  select
    email, name, order_count, total_spent, first_order_at, last_order_at,
    count(*) over() as total_count
  from joined
  order by last_order_at desc
  limit p_limit
  offset coalesce(p_offset, 0);
$$;

revoke all on function public.admin_customer_rollup(text, int, int) from public;
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_customer_rollup(text, int, int) to service_role;$q$;
  end if;
end
$rpc_lockdown$;


-- ---------------------------------------------------------------------------
-- Operations summary customer counts + live sales (mirrors partner-portal.ts
-- getAdminOperationsSummary). new/returning are computed by grouping PAID orders
-- on the RAW customer_email (matches the JS map key — no lower/trim).
--
-- The customer counts exclude replacements for the same reason the live-sales
-- sums below do. admin-replacements.ts writes a reship as payment_status 'paid'
-- under the ORIGINAL BUYER'S email, so a one-time buyer who was sent a
-- replacement had two 'paid' rows and was counted as a RETURNING customer — the
-- store's repeat-purchase tile counted its own warranty shipments as repeat
-- business, and got better the more reships it sent.
--
-- Live sales now sum NET revenue over REVENUE_ORDER_STATUSES, so they agree
-- with the revenue page and the profit dashboard. They previously summed GROSS
-- amount_paid for status='paid' only, which both ignored refunds and dropped
-- partly refunded orders.
--
-- Replacement reships are excluded, exactly as admin_revenue_summary excludes
-- them: order_type='replacement' is paid with amount_paid 0, so counting it as
-- a sale drags the same tile the revenue page reports differently.
--
-- The JS twin (partner-portal.ts getAdminOperationsSummary, used when this RPC
-- is not migrated) now resolves the identical definition through ledger.ts.
-- ledger-sql-parity.test.ts fails if either side changes alone.
-- ---------------------------------------------------------------------------
create or replace function public.admin_ops_summary(
  p_today_start timestamptz,
  p_month_start timestamptz
)
returns table (
  live_sales_today numeric,
  live_sales_month numeric,
  new_customers bigint,
  returning_customers bigint,
  total_customers bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with per_customer as (
    select customer_email, count(*) as cnt
    from public.orders
    where payment_status = 'paid' and customer_email is not null and customer_email <> ''
      and coalesce(order_type, 'product') <> 'replacement'
    group by customer_email
  )
  select
    coalesce((select sum(round(coalesce(amount_paid, 0) - coalesce(refund_amount, 0), 2))
              from public.orders
              where payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
                and coalesce(order_type, 'product') <> 'replacement'
                and created_at >= p_today_start), 0) as live_sales_today,
    coalesce((select sum(round(coalesce(amount_paid, 0) - coalesce(refund_amount, 0), 2))
              from public.orders
              where payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
                and coalesce(order_type, 'product') <> 'replacement'
                and created_at >= p_month_start), 0) as live_sales_month,
    coalesce((select count(*) from per_customer where cnt = 1), 0) as new_customers,
    coalesce((select count(*) from per_customer where cnt > 1), 0) as returning_customers,
    coalesce((select count(*) from per_customer), 0) as total_customers;
$$;

revoke all on function public.admin_ops_summary(timestamptz, timestamptz) from public;
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_ops_summary(timestamptz, timestamptz) to service_role;$q$;
  end if;
end
$rpc_lockdown$;


-- ---------------------------------------------------------------------------
-- Total outstanding points (mirrors admin-membership.ts getMembershipAnalytics
-- totalPointsOutstanding = sum of every points_ledger.amount).
-- ---------------------------------------------------------------------------
create or replace function public.admin_points_outstanding()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(amount), 0) from public.points_ledger;
$$;

revoke all on function public.admin_points_outstanding() from public;
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_points_outstanding() to service_role;$q$;
  end if;
end
$rpc_lockdown$;


-- ---------------------------------------------------------------------------
-- Bulk-savings tier stats (mirrors admin-membership.ts getBulkSavingsStats).
--
-- REVIEW FINDING 5. This function summed GROSS amount_paid with NO
-- payment_status filter at all, so every pending_payment, canceled, failed and
-- fully-refunded order with a bulk tier counted as bulk-savings revenue, and a
-- free replacement reship counted as an order. On a six-order basket worth $350
-- it reported $1,015.00 across 6 orders. The JS fallback did exactly the same,
-- so the two "agreed" while both were wrong — and this file's own header claims
-- every function mirrors its JS "EXACTLY (same status filters, same
-- net-of-refund revenue ... same order_type exclusions)".
--
-- Now identical in shape to admin_revenue_by_method above: the ledger's revenue
-- statuses, replacements excluded, refunds netted off. Revenue is still returned
-- in CENTS because that is what getBulkSavingsStats consumes.
-- ---------------------------------------------------------------------------
create or replace function public.admin_bulk_savings_stats()
returns table (
  tier text,
  orders bigint,
  revenue_cents numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    bulk_discount_tier as tier,
    count(*) as orders,
    coalesce(sum(round(coalesce(amount_paid, 0) - coalesce(refund_amount, 0), 2) * 100), 0) as revenue_cents
  from public.orders
  where bulk_discount_tier is not null
    and payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
    and coalesce(order_type, 'product') <> 'replacement'
  group by bulk_discount_tier;
$$;

revoke all on function public.admin_bulk_savings_stats() from public;
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_bulk_savings_stats() to service_role;$q$;
  end if;
end
$rpc_lockdown$;


-- ---------------------------------------------------------------------------
-- Supporting indexes for the aggregations above. IF NOT EXISTS = safe re-run.
-- ---------------------------------------------------------------------------
-- Speeds the customer-rollup "latest order per email" DISTINCT ON and the
-- per-email grouping (functional index matches lower(trim(customer_email))).
create index if not exists idx_orders_email_lower_created
  on public.orders (lower(trim(customer_email)), created_at desc)
  where customer_email is not null;

-- Bulk-savings stats only touch the small subset of orders that carry a tier.
create index if not exists idx_orders_bulk_tier
  on public.orders (bulk_discount_tier)
  where bulk_discount_tier is not null;

-- Ops-summary live-sales windows filter paid orders by created_at.
create index if not exists idx_orders_paid_created
  on public.orders (created_at)
  where payment_status = 'paid';
