-- Veyra recurring memberships — ownership marker.
--
-- Additive and idempotent. Safe to run before the code deploys (and it MUST be
-- run first: the sweep guard filters on this column, and a query against a
-- missing column errors the whole sweep).
--
-- WHY THIS COLUMN EXISTS
-- A membership created through Veyra's POST /api/v1/membership is billed by
-- VEYRA: it charges the card, schedules renewals, and runs its own dunning.
-- Our runMembershipBillingSweep() must therefore skip those rows entirely.
-- Every sweep query in membership-billing.ts carries `.is("veyra_membership_id",
-- null)`. Without it, both systems bill the same member and every Veyra-backed
-- subscriber is charged twice a month.
--
-- NULL  = locally-billed membership (legacy / mock / noop provider). The sweep
--         owns it, exactly as before.
-- SET   = Veyra owns billing. The sweep must not touch it.

alter table if exists public.customer_memberships
  add column if not exists veyra_membership_id text;

comment on column public.customer_memberships.veyra_membership_id is
  'Veyra membership id when billing is owned by Veyra (/api/v1/membership). NON-NULL means runMembershipBillingSweep() must skip this row — Veyra charges and duns it. NULL means this store bills it locally.';

-- One local membership per Veyra membership. Guards against a retried signup
-- creating a second local row pointing at the same remote subscription, which
-- would double-count members and double-grant perks. Partial so the many
-- legacy NULL rows are unaffected.
create unique index if not exists customer_memberships_veyra_membership_id_key
  on public.customer_memberships (veyra_membership_id)
  where veyra_membership_id is not null;

-- Supports the `.is("veyra_membership_id", null)` filter now present on all five
-- sweep queries. Partial on NULL = exactly the rows the sweep still processes,
-- so it stays small even as Veyra-backed memberships grow.
create index if not exists customer_memberships_local_billing_idx
  on public.customer_memberships (next_billing_at)
  where veyra_membership_id is null;

-- Verification — fails loudly rather than reporting a silent success.
do $$
declare
  has_col boolean;
  has_uniq boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'customer_memberships'
      and column_name = 'veyra_membership_id'
  ) into has_col;

  select exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'customer_memberships_veyra_membership_id_key'
  ) into has_uniq;

  if not has_col then
    raise exception 'veyra_membership_id column missing after migration';
  end if;
  if not has_uniq then
    raise exception 'customer_memberships_veyra_membership_id_key index missing after migration';
  end if;

  raise notice 'veyra-memberships OK: column=% unique_index=%', has_col, has_uniq;
end $$;

select
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'customer_memberships'
      and column_name = 'veyra_membership_id'
  ) as column_ok,
  (select count(*) from public.customer_memberships where veyra_membership_id is not null) as veyra_backed_rows,
  (select count(*) from public.customer_memberships where veyra_membership_id is null) as locally_billed_rows;
