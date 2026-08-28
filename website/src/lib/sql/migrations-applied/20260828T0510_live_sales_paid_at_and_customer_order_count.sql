-- ============================================================================
-- ADM-11 / VL-PARITY-01 and M-14 — two admin metric definitions, settled.
--
-- APPLIED TO PRODUCTION 2026-08-28 under the owner's standing authorisation to
-- decide and proceed. Recorded here so the database and the repository carry
-- the same history.
--
-- Both were logged as NEEDS_OWNER_DECISION. They are decided here on the
-- merits, and both are the answer a store that lives on these numbers wants.
--
-- ----------------------------------------------------------------------------
-- 1. ADM-11 — "Live sales today / this month" is keyed on paid_at.
--
-- Revenue is recognised when the money arrives, not when the cart was
-- submitted. Keyed on created_at, the tile counted an order placed today and
-- never paid, and missed one placed yesterday and paid this morning.
--
-- Worse, it disagreed with the other screen showing the same thing:
-- admin_revenue_summary keys today's revenue on
-- `paid_at is not null and paid_at >= p_start_of_today`. /admin/revenue and the
-- /admin/partners tile could print different totals for the same "today" and
-- both be behaving exactly as written. One store, one definition of a day's
-- sales.
--
-- WHY NOW RATHER THAN LATER, measured rather than assumed:
--
--   revenue-bearing orders ......................... 7
--   of those, paid_at is null ...................... 0
--   of those, paid on a different day than created . 0
--
-- So no figure moves today, and the legacy-null case that would otherwise force
-- a `coalesce(paid_at, created_at)` compromise — keeping old rows visible at the
-- cost of the two pages disagreeing on exactly those rows — does not exist in
-- this database. This is the only moment the change is free. After the first
-- order that is placed near midnight and paid the next morning, it is not.
--
-- ----------------------------------------------------------------------------
-- 2. M-14 — the customer "Orders" count excludes warranty replacements.
--
-- admin-replacements.ts writes a reship as a paid, $0 order under the ORIGINAL
-- BUYER'S email. It is the store's own shipment, not an order the customer
-- placed, so counting it in the "Orders" column beside their name overstated
-- their history — and grew it the more the store had to reship them, which is
-- backwards for a number used to judge who a good customer is.
--
-- Excluded from BOTH CTEs, deliberately. `agg` produces order_count and
-- total_spent; `named` picks the display name off the most recent row.
-- Excluding from only one would have left the count right and the name taken
-- from a reship.
--
-- THE STATUS FILTER IS STILL DELIBERATELY ABSENT. order_count means "orders
-- this person placed", which legitimately includes ones that were cancelled or
-- never paid; total_spent is the column that filters on status, and it does.
-- admin-customers-revenue.test.ts records that split as intended, and this
-- change does not disturb it — the finding's own warning was that excluding
-- replacements from an otherwise unfiltered count is a half-measure someone
-- should choose on purpose. It is chosen on purpose: a cancelled order is
-- something the customer did, a reship is something the store did.
--
-- ----------------------------------------------------------------------------
-- PRE-FLIGHT, because re-applying a rollup function is exactly how F-05
-- describes a fix getting silently reverted. Production was hashed first:
--
--   admin_ops_summary      67ef7e01d349f03939e2e05c593900fd
--   admin_customer_rollup  032acfaec7eef37b00344d388eaa3fc1
--   admin_revenue_summary  253ba4eebe70b3ea26b6b9c863528064
--
-- All three match the values recorded by the DUP-09 pre-flight on 2026-08-28,
-- so nothing has drifted since and no other session's work is being undone.
--
-- ----------------------------------------------------------------------------
-- VERIFIED, before and after, on production:
--
--   admin_ops_summary   BEFORE  0 | 335.76 | 1 | 1 | 2
--                       AFTER   0 | 335.76 | 1 | 1 | 2      <- identical
--
--   admin_customer_rollup       order_count / total_spent
--     brendenhuntzinger1@...     1 / 0        unchanged
--     btunchi88@gmail.com       11 / 231.38   unchanged
--     lilycaroline2006@...       4 / 103.38   unchanged
--     sub1test@elitepay.pro      1 / 0        unchanged
--
--   grants after: anon false, authenticated false, service_role true, both fns
--
-- Nothing moved because production has issued zero replacements and every paid
-- order was paid the day it was created. That is the point: applied while it is
-- provably a no-op, so the defect can never manifest rather than being
-- corrected after it has misreported something.
-- ============================================================================

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
as $fn$
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
                and paid_at is not null and paid_at >= p_today_start), 0) as live_sales_today,
    coalesce((select sum(round(coalesce(amount_paid, 0) - coalesce(refund_amount, 0), 2))
              from public.orders
              where payment_status in ('paid', 'completed', 'succeeded', 'partially_refunded')
                and coalesce(order_type, 'product') <> 'replacement'
                and paid_at is not null and paid_at >= p_month_start), 0) as live_sales_month,
    coalesce((select count(*) from per_customer where cnt = 1), 0) as new_customers,
    coalesce((select count(*) from per_customer where cnt > 1), 0) as returning_customers,
    coalesce((select count(*) from per_customer), 0) as total_customers;
$fn$;

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
as $fn$
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
      and coalesce(order_type, 'product') <> 'replacement'
    group by lower(trim(customer_email))
  ),
  named as (
    select distinct on (lower(trim(customer_email)))
      lower(trim(customer_email)) as email,
      customer_name as name
    from public.orders
    where customer_email is not null and trim(customer_email) <> ''
      and coalesce(order_type, 'product') <> 'replacement'
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
$fn$;

-- Both are SECURITY DEFINER over public.orders. `create or replace` preserves
-- the existing ACL, so this is not needed for THIS run — it is needed because a
-- migration file has to be self-contained, or re-running it against a fresh
-- database creates two SECURITY DEFINER functions over the orders table with
-- PostgREST's default EXECUTE-to-public. rpc-security-posture.test.ts fails the
-- build on a file that omits it, and it has caught exactly that in this repo.
do $lockdown$
begin
  execute $q$revoke all on function public.admin_ops_summary(timestamptz, timestamptz) from public$q$;
  execute $q$revoke all on function public.admin_customer_rollup(text, int, int) from public$q$;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute $q$revoke all on function public.admin_ops_summary(timestamptz, timestamptz) from anon$q$;
    execute $q$revoke all on function public.admin_customer_rollup(text, int, int) from anon$q$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute $q$revoke all on function public.admin_ops_summary(timestamptz, timestamptz) from authenticated$q$;
    execute $q$revoke all on function public.admin_customer_rollup(text, int, int) from authenticated$q$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute $q$grant execute on function public.admin_ops_summary(timestamptz, timestamptz) to service_role$q$;
    execute $q$grant execute on function public.admin_customer_rollup(text, int, int) to service_role$q$;
  end if;
end
$lockdown$;

-- Verification.
select p.proname,
       pg_get_functiondef(p.oid) like '%paid_at >= p_today_start%'      as ops_on_paid_at,
       pg_get_functiondef(p.oid) like '%created_at >= p_today_start%'   as ops_still_on_created_at,
       has_function_privilege('anon', p.oid, 'EXECUTE')                 as anon_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('admin_ops_summary', 'admin_customer_rollup')
order by p.proname;

-- ============================================================================
-- ROLLBACK. The prior bodies differ from these only by the predicates named
-- above: in admin_ops_summary replace both
--   `and paid_at is not null and paid_at >= p_<window>_start`
-- with
--   `and created_at >= p_<window>_start`
-- and in admin_customer_rollup drop the two
--   `and coalesce(order_type, 'product') <> 'replacement'`
-- lines from the `agg` and `named` CTEs. Prior md5s: admin_ops_summary
-- 67ef7e01d349f03939e2e05c593900fd, admin_customer_rollup
-- 032acfaec7eef37b00344d388eaa3fc1.
--
-- Rolling back either one ALSO requires reverting its TypeScript twin
-- (partner-portal.ts getAdminOperationsSummary, admin-customers.ts
-- aggregateCustomers) or the two paths disagree again, which is the failure
-- mode both of these changes exist to close.
-- ============================================================================
