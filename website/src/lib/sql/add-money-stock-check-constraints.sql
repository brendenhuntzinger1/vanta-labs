-- ============================================================================
-- VANTA LABS — non-negative CHECK constraints on money + stock (P2/P8).
-- SAFE MIGRATION, HELD FOR REVIEW — do NOT run until check #5 of
-- production-readiness-checks.sql returns all zeros (no existing negatives).
--
-- Strategy: add each constraint as NOT VALID (no full-table scan, no lock on
-- existing rows, cannot fail on legacy data), then VALIDATE separately. If a
-- VALIDATE errors, you have pre-existing bad data to clean first — that is the
-- point (it surfaces corruption instead of hiding it).
--
-- Idempotent: each add is guarded so re-running is a no-op.
-- Rollback: `alter table <t> drop constraint <name>;` for any constraint below.
-- ============================================================================

-- Helper: add a NOT VALID check only if it doesn't already exist and the
-- column exists (so a not-yet-migrated column is skipped, not an error).
do $$
declare
  r record;
  checks text[][] := array[
    ['orders','amount_paid'], ['orders','discount_amount'], ['orders','subtotal'],
    ['orders','refund_amount'], ['orders','handling_fee'], ['orders','tax_amount'],
    ['orders','shipping_amount'],
    ['referral_orders','commission_amount'], ['referral_orders','amount_paid'],
    ['commissions','commission_amount'],
    ['payouts','amount'], ['partner_payouts','amount'],
    ['coupons','discount_value'], ['coupons','redemptions_count'],
    ['products','inventory_quantity'], ['products','price_cents'], ['products','product_cost_cents'],
    ['product_doses','inventory_quantity'], ['product_doses','price_cents'], ['product_doses','product_cost_cents']
  ];
  i int;
  tbl text; col text; cons text;
begin
  for i in 1 .. array_length(checks, 1) loop
    tbl := checks[i][1];
    col := checks[i][2];
    cons := format('%s_%s_nonneg', tbl, col);
    -- column must exist
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = tbl and column_name = col
    ) and not exists (
      select 1 from pg_constraint where conname = cons
    ) then
      execute format('alter table public.%I add constraint %I check (%I >= 0) not valid', tbl, cons, col);
      raise notice 'added NOT VALID constraint %', cons;
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- VALIDATE STEP — run only after check #5 confirms zero existing negatives.
-- Each VALIDATE scans the table; a failure means real bad data to fix first.
-- Uncomment and run once you've confirmed the smoke test is clean:
-- ----------------------------------------------------------------------------
-- do $$
-- declare c record;
-- begin
--   for c in select conname, conrelid::regclass as tbl from pg_constraint
--            where conname like '%\_nonneg' and not convalidated loop
--     execute format('alter table %s validate constraint %I', c.tbl, c.conname);
--   end loop;
-- end $$;

-- Verify what got added and whether it's validated yet:
select conrelid::regclass as table_name, conname, convalidated
from pg_constraint where conname like '%\_nonneg' order by 1;
