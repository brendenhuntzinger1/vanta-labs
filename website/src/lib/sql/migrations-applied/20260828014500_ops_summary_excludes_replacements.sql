-- ============================================================================
-- DUP-09 — admin_ops_summary counted the store's own warranty reships as
-- repeat customers, and as revenue.
--
-- APPLIED TO PRODUCTION 2026-08-28 under the owner's standing SQL
-- authorisation. Recorded here under the same version so the database and the
-- repository carry the same history.
--
-- This is the same function body that lives in admin-dashboard-rollups.sql —
-- extracted rather than re-applying that whole file, and the two are verified
-- identical below. Re-applying the full file would also have been safe (that
-- was checked, see PRE-FLIGHT), but a five-function replacement to change one
-- function is a wider blast radius than the change needs.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS WRONG
--
-- admin-replacements.ts writes a warranty reship as payment_status 'paid'
-- under the ORIGINAL BUYER'S email. admin_ops_summary grouped paid orders by
-- customer_email and called anyone with more than one row a returning
-- customer. So a one-time buyer who was sent a replacement became a repeat
-- customer, and the repeat-purchase tile improved the more reships the store
-- had to send — a metric that rewarded its own failures.
--
-- The live-sales sums had the same shape: a replacement carries no new money,
-- but it was inside the revenue window all the same.
--
-- ----------------------------------------------------------------------------
-- PRE-FLIGHT, because re-applying a rollup file is exactly how finding F-05
-- describes a fix getting silently reverted.
--
-- The repo file was applied to a throwaway database cloned from the harness
-- (created and dropped for the purpose; the harness database was not touched),
-- and every function it defines was hashed and compared against production:
--
--   admin_revenue_summary      253ba4ee…  IDENTICAL to production
--   admin_bulk_savings_stats   1c8240fe…  IDENTICAL
--   admin_customer_rollup      032acfae…  IDENTICAL
--   admin_points_outstanding   6fbfb0d5…  IDENTICAL
--   admin_revenue_by_method    0f9ddba9…  IDENTICAL
--   admin_ops_summary          67ef7e01…  DIFFERENT — this change, and only this
--
-- Five of six byte-identical means the file carries no other session's work
-- that this would undo. That is the check F-05 asks for, and it passed.
--
-- ----------------------------------------------------------------------------
-- BLAST RADIUS: NIL, TODAY.
--
--   select count(*) from orders where coalesce(order_type,'product')='replacement'
--   -> 0
--
-- No replacement has ever been issued, so no number moves. Verified before and
-- after: live_sales_month 335.76, new_customers 1, returning_customers 1,
-- total_customers 2 — identical either side. This is preventative, applied at
-- the only moment it costs nothing, so the defect can never manifest rather
-- than being corrected after it has misreported something.
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

-- ----------------------------------------------------------------------------
-- CLOSE IT TO ANON, because a function created without this is a function
-- anyone with the publishable key can call.
--
-- Not needed for THIS production run: `create or replace function` preserves
-- the existing ACL, and production was checked after applying — SECURITY
-- DEFINER intact, anon and authenticated both false, service_role true. It is
-- needed because a migration file has to be self-contained. Re-run against a
-- fresh database this file would otherwise create a SECURITY DEFINER function
-- over the orders table with PostgREST's default EXECUTE-to-public.
--
-- rpc-security-posture.test.ts caught exactly that and named this file. The
-- guard was right and the omission was mine.
--
-- Guarded on pg_roles so the file also runs against a bare Postgres, where the
-- Supabase-managed roles do not exist — matching admin-dashboard-rollups.sql.
-- ----------------------------------------------------------------------------
do $rpc_lockdown$
begin
  execute $q$revoke all on function public.admin_ops_summary(timestamptz, timestamptz) from public$q$;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute $q$revoke all on function public.admin_ops_summary(timestamptz, timestamptz) from anon$q$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute $q$revoke all on function public.admin_ops_summary(timestamptz, timestamptz) from authenticated$q$;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute $q$grant execute on function public.admin_ops_summary(timestamptz, timestamptz) to service_role$q$;
  end if;
end
$rpc_lockdown$;

-- Verification. Must return true, and the md5 must equal what
-- admin-dashboard-rollups.sql produces (67ef7e01d349f03939e2e05c593900fd at
-- the time of applying — recompute rather than trusting this literal if the
-- file has changed since).
select md5(pg_get_functiondef(p.oid))                    as body_md5,
       pg_get_functiondef(p.oid) like '%order_type%'     as excludes_replacements
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_ops_summary';

-- ============================================================================
-- ROLLBACK — production's exact body immediately before this ran
-- (md5 87b284e0523ba9f20de9068a973006de). Differs from the above only by the
-- three order_type predicates.
--
--   create or replace function public.admin_ops_summary(
--     p_today_start timestamptz, p_month_start timestamptz)
--   returns table (live_sales_today numeric, live_sales_month numeric,
--     new_customers bigint, returning_customers bigint, total_customers bigint)
--   language sql stable security definer set search_path = public, pg_temp
--   as $$
--     with per_customer as (
--       select customer_email, count(*) as cnt from public.orders
--       where payment_status = 'paid' and customer_email is not null
--         and customer_email <> ''
--       group by customer_email
--     )
--     select
--       coalesce((select sum(round(coalesce(amount_paid,0) - coalesce(refund_amount,0), 2))
--                 from public.orders
--                 where payment_status in ('paid','completed','succeeded','partially_refunded')
--                   and created_at >= p_today_start), 0),
--       coalesce((select sum(round(coalesce(amount_paid,0) - coalesce(refund_amount,0), 2))
--                 from public.orders
--                 where payment_status in ('paid','completed','succeeded','partially_refunded')
--                   and created_at >= p_month_start), 0),
--       coalesce((select count(*) from per_customer where cnt = 1), 0),
--       coalesce((select count(*) from per_customer where cnt > 1), 0),
--       coalesce((select count(*) from per_customer), 0);
--   $$;
-- ============================================================================
