-- ============================================================================
-- Admin Partners page rollup.
--
-- getAdminPartnerRows() previously pulled EVERY row of referral_orders, orders,
-- and partner_clicks into the app and aggregated in JS on every page load — an
-- unbounded scan that degrades as those tables grow. This function does the
-- same aggregation in Postgres (one grouped pass per table) and returns one row
-- per ambassador. The bucket logic mirrors src/lib/ledger.ts + partner-portal.ts
-- exactly (earned = NOT reversed/voided/manual_review; revenue = paid orders).
--
-- Safe to run more than once. The app falls back to the legacy JS aggregation if
-- this function is absent, so deploying the code before/after this is safe.
-- ============================================================================

create or replace function public.admin_partner_rollups()
returns table (
  ambassador_id text,
  commission_total numeric,
  commission_pending numeric,
  commission_approved numeric,
  commission_paid numeric,
  commission_reversed numeric,
  order_revenue numeric,
  order_count bigint,
  click_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with c as (
    select
      ambassador_id::text as ambassador_id,
      sum(case when lower(coalesce(payment_status, '')) not in ('reversed', 'voided', 'manual_review') then coalesce(commission_amount, 0) else 0 end) as total,
      sum(case when lower(coalesce(payment_status, '')) not in ('commission_paid', 'paid', 'approved_for_payout', 'reversed', 'voided') then coalesce(commission_amount, 0) else 0 end) as pending,
      sum(case when lower(coalesce(payment_status, '')) = 'approved_for_payout' then coalesce(commission_amount, 0) else 0 end) as approved,
      sum(case when lower(coalesce(payment_status, '')) in ('commission_paid', 'paid') then coalesce(commission_amount, 0) else 0 end) as paid,
      sum(case when lower(coalesce(payment_status, '')) in ('reversed', 'voided') then coalesce(commission_amount, 0) else 0 end) as reversed
    from public.referral_orders
    where ambassador_id is not null
    group by ambassador_id
  ),
  o as (
    select ambassador_id::text as ambassador_id, sum(coalesce(amount_paid, 0)) as revenue, count(*) as cnt
    from public.orders
    where ambassador_id is not null and payment_status = 'paid'
    group by ambassador_id
  ),
  k as (
    select ambassador_id::text as ambassador_id, count(*) as cnt
    from public.partner_clicks
    where ambassador_id is not null
    group by ambassador_id
  ),
  ids as (
    select ambassador_id from c
    union select ambassador_id from o
    union select ambassador_id from k
  )
  select
    ids.ambassador_id,
    coalesce(c.total, 0), coalesce(c.pending, 0), coalesce(c.approved, 0), coalesce(c.paid, 0), coalesce(c.reversed, 0),
    coalesce(o.revenue, 0), coalesce(o.cnt, 0), coalesce(k.cnt, 0)
  from ids
  left join c on c.ambassador_id = ids.ambassador_id
  left join o on o.ambassador_id = ids.ambassador_id
  left join k on k.ambassador_id = ids.ambassador_id;
$$;

-- Lock down the SECURITY DEFINER function: Postgres grants EXECUTE to PUBLIC by
-- default on create, which (via Supabase's anon/authenticated roles + PostgREST
-- RPC exposure) would let an anonymous caller read ambassador commission/revenue
-- financials while bypassing RLS. Revoke the default; grant only to service_role.
revoke all on function public.admin_partner_rollups() from public;
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_partner_rollups() to service_role;$q$;
  end if;
end
$rpc_lockdown$;

