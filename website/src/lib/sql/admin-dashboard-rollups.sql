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
-- same net-of-refund revenue, same buckets). The app falls back to the legacy
-- JS path if a function is absent, so deploying the code before/after running
-- this migration is safe. Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Revenue metrics (mirrors src/lib/admin-revenue.ts getRevenueMetrics).
-- Paid statuses = paid|completed|succeeded (ledger.ts PAID_ORDER_STATUSES).
-- Net revenue per order = max(0, amount_paid - refund_amount), rounded to 2dp
-- per order then summed (matches netOrderRevenue()).
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
      round(greatest(0, coalesce(amount_paid, 0) - coalesce(refund_amount, 0)), 2) as net,
      coalesce(card_processing_fee, 0) as fee,
      paid_at
    from public.orders
    where payment_status in ('paid', 'completed', 'succeeded')
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
    round(coalesce(sum(round(greatest(0, coalesce(amount_paid, 0) - coalesce(refund_amount, 0)), 2)), 0), 2) as revenue,
    count(*) as orders
  from public.orders
  where payment_status in ('paid', 'completed', 'succeeded')
  group by coalesce(payment_method, '')
  order by revenue desc;
$$;

grant execute on function public.admin_revenue_summary(timestamptz) to service_role;
grant execute on function public.admin_revenue_by_method() to service_role;

-- ---------------------------------------------------------------------------
-- Customer rollup (mirrors src/lib/admin-customers.ts aggregateCustomers).
-- Aggregates guest/customer orders by lower(customer_email). totalSpent sums
-- amount_paid only for paid|partially_refunded|refunded orders; name is taken
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
      coalesce(sum(case when payment_status in ('paid', 'partially_refunded', 'refunded') then coalesce(amount_paid, 0) else 0 end), 0) as total_spent,
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

grant execute on function public.admin_customer_rollup(text, int, int) to service_role;
