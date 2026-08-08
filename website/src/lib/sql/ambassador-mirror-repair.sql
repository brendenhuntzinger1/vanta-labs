-- ===========================================================================
-- VANTA LABS — AMBASSADOR MIRROR REPAIR + STATUS CONSTRAINT
--
-- Run one lettered block at a time. Supabase's editor returns only the LAST
-- statement's result.
--
-- BACKGROUND
-- An ambassador exists as two rows with the same id: `partners` and
-- `ambassadors`. The admin writes both together, but they were written
-- CONCURRENTLY with an identical payload -- so when one write was rejected by a
-- constraint the other had already landed, and the pair silently diverged.
--
-- That matters because they are read by different things:
--   ambassadors  -> CHECKOUT (quote-order.ts) and the payment webhook
--   partners     -> the ADMIN roster and the ambassador's own dashboard
--
-- A divergence therefore shows the owner one discount while charging the
-- shopper another. Confirmed on ELIJAH-AB78AE: partners 20.00, ambassadors NULL.
--
-- The application no longer creates this divergence (a rate edit stopped
-- writing status, which is what tripped the constraint). Blocks B and C repair
-- the rows that already drifted.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- A. DIAGNOSE -- read only. Run this first and read it before changing anything.
--
-- `partners` is treated as intent: it is the table the admin reads back, so it
-- holds the number the owner last saw and believed they had saved.
-- ---------------------------------------------------------------------------
select
  a.name,
  a.referral_code,
  a.status                        as ambassadors_status,
  p.status                        as partners_status,
  a.customer_discount_percent     as checkout_uses_this,
  p.customer_discount_percent     as admin_shows_this,
  a.commission_percent            as commission_paid_at,
  p.commission_percent            as commission_shown,
  case
    when a.customer_discount_percent is distinct from p.customer_discount_percent
     and a.commission_percent      is distinct from p.commission_percent
      then 'BOTH RATES DRIFTED'
    when a.customer_discount_percent is distinct from p.customer_discount_percent
      then 'DISCOUNT DRIFTED — shopper is charged the ambassadors value'
    when a.commission_percent is distinct from p.commission_percent
      then 'COMMISSION DRIFTED — payout uses the ambassadors value'
    when a.status is distinct from p.status
      then 'STATUS DRIFTED'
    else 'in sync'
  end                             as verdict
from public.ambassadors a
full outer join public.partners p on p.id = a.id
order by verdict, a.name;


-- ---------------------------------------------------------------------------
-- B. PREVIEW THE REPAIR -- still read only.
--
-- Shows exactly which rows block C would change, and to what. If this returns
-- nothing, there is nothing to repair and you can skip to C.
--
-- Direction: ambassadors <- partners. The owner edits through the admin, which
-- reads partners, so partners carries what they intended. Copying the other way
-- would overwrite a deliberate edit with a stale value.
-- ---------------------------------------------------------------------------
select
  a.referral_code,
  a.name,
  a.customer_discount_percent     as discount_before,
  p.customer_discount_percent     as discount_after,
  a.commission_percent            as commission_before,
  p.commission_percent            as commission_after
from public.ambassadors a
join public.partners p on p.id = a.id
where a.customer_discount_percent is distinct from p.customer_discount_percent
   or a.commission_percent        is distinct from p.commission_percent
order by a.name;


-- ---------------------------------------------------------------------------
-- C. APPLY THE REPAIR -- THIS WRITES.
--
-- Only touches the two rate columns, only on rows that actually differ, and
-- only where a matching partners row exists. No status, no timestamps, no
-- deletions. Returns the rows it changed so the result is its own receipt.
-- ---------------------------------------------------------------------------
update public.ambassadors a
   set customer_discount_percent = p.customer_discount_percent,
       commission_percent        = p.commission_percent,
       updated_at                = now()
from public.partners p
where p.id = a.id
  and (a.customer_discount_percent is distinct from p.customer_discount_percent
    or a.commission_percent        is distinct from p.commission_percent)
returning
  a.referral_code,
  a.name,
  a.customer_discount_percent as discount_now,
  a.commission_percent        as commission_now;


-- ---------------------------------------------------------------------------
-- D. CONFIRM -- read only. Every row should read 'in sync'.
-- ---------------------------------------------------------------------------
select
  a.name,
  a.referral_code,
  a.customer_discount_percent as checkout_uses_this,
  p.customer_discount_percent as admin_shows_this,
  case when a.customer_discount_percent is distinct from p.customer_discount_percent
         or a.commission_percent is distinct from p.commission_percent
       then 'STILL DRIFTED' else 'in sync' end as verdict
from public.ambassadors a
join public.partners p on p.id = a.id
order by verdict desc, a.name;


-- ===========================================================================
-- E. THE STATUS CONSTRAINT
--
-- Optional. Only needed if you want to move an ambassador INTO
-- "info_requested" from the roster ("Request Info"). Everything else works
-- without this.
--
-- E1 first: read what the constraints currently allow. Do not run E3 until you
-- have looked at E1 and E2.
-- ===========================================================================

-- E1. What do the constraints say today?
select
  rel.relname          as table_name,
  con.conname          as constraint_name,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace nsp on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname in ('ambassadors', 'partners')
  and con.contype = 'c'
order by rel.relname, con.conname;


-- E2. What status values actually exist in the data right now?
-- Every value listed here MUST appear in the new constraint, or E3 fails and
-- changes nothing (which is the safe outcome, but wastes a step).
select 'ambassadors' as source, status, count(*) from public.ambassadors group by status
union all
select 'partners', status, count(*) from public.partners group by status
order by source, status;


-- E3. Widen the constraint. THIS ALTERS THE SCHEMA.
--
-- Drop-and-recreate is the only way to change a CHECK. It is not destructive to
-- data -- no row is read, written or deleted -- but if any existing row falls
-- outside the list the ADD fails and the table is left WITHOUT the constraint
-- until you re-run it with that value included. Confirm E2 first.
--
-- Wrapped in a transaction so a failure rolls back to the original state
-- rather than leaving the table unprotected.
begin;

alter table public.ambassadors drop constraint if exists ambassadors_status_check;
alter table public.ambassadors
  add constraint ambassadors_status_check
  check (status in ('pending', 'approved', 'disabled', 'rejected', 'info_requested'));

alter table public.partners drop constraint if exists partners_status_check;
alter table public.partners
  add constraint partners_status_check
  check (status in ('pending', 'approved', 'disabled', 'rejected', 'info_requested'));

commit;


-- E4. Confirm both constraints now list all five statuses.
select
  rel.relname as table_name,
  con.conname as constraint_name,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel on rel.oid = con.conrelid
join pg_namespace nsp on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname in ('ambassadors', 'partners')
  and con.conname like '%status_check'
order by rel.relname;
