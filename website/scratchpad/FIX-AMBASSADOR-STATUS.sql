-- =====================================================================
-- VANTA LABS — AMBASSADOR STATUS CONSTRAINT
--
-- WHAT IS WRONG
-- The application has five ambassador statuses. It writes all five, its API
-- validates exactly those five, and the admin UI offers all five:
--
--     pending  approved  disabled  rejected  info_requested
--
-- The `partners` table allows all five. The `ambassadors` table allows only
-- four — `info_requested` is missing.
--
-- WHY IT BREAKS MORE THAN IT LOOKS LIKE IT SHOULD
-- Postgres re-validates the WHOLE ROW on every UPDATE, not just the columns
-- being changed. So once an ambassadors row holds `info_requested`, EVERY
-- later update to that row is rejected — including ones that never touch
-- status. That is why "Set %" failed on an ambassador whose displayed status
-- was "approved": the display reads the partners mirror, and the underlying
-- ambassadors row was already in the forbidden state.
--
-- SAFETY
-- Additive only. No row is read, written, or deleted; only the CHECK is
-- widened, and every value currently valid stays valid. Safe to re-run.
-- Wrapped in a transaction, so a failure rolls back rather than leaving the
-- table unprotected.
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 1 — DIAGNOSE. Read only. Run this first and look at the output.
-- ---------------------------------------------------------------------
select
  rel.relname          as table_name,
  con.conname          as constraint_name,
  pg_get_constraintdef(con.oid) as current_definition
from pg_constraint con
join pg_class rel      on rel.oid = con.conrelid
join pg_namespace nsp  on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname in ('ambassadors', 'partners')
  and con.conname like '%status%'
order by rel.relname;

-- Every status value that actually exists in your data right now. If anything
-- here is NOT in the five-value list below, STOP — adding the constraint would
-- fail, and you would want to know why that value exists before deciding.
select 'ambassadors' as source, status, count(*) as rows
from public.ambassadors group by status
union all
select 'partners', status, count(*)
from public.partners group by status
order by source, status;


-- ---------------------------------------------------------------------
-- STEP 2 — APPLY. This alters the schema. Data is untouched.
-- ---------------------------------------------------------------------
begin;

alter table public.ambassadors drop constraint if exists ambassadors_status_check;
alter table public.ambassadors
  add constraint ambassadors_status_check
  check (status in ('pending', 'approved', 'disabled', 'rejected', 'info_requested'));

-- Applied to partners as well so the two tables cannot drift apart again.
-- If partners already lists all five this is a no-op that rewrites the same
-- definition, which is why the whole script is safe to re-run.
alter table public.partners drop constraint if exists partners_status_check;
alter table public.partners
  add constraint partners_status_check
  check (status in ('pending', 'approved', 'disabled', 'rejected', 'info_requested'));

commit;


-- ---------------------------------------------------------------------
-- STEP 3 — VERIFY. Read only. Both rows must say PASS.
-- ---------------------------------------------------------------------
select
  rel.relname as table_name,
  case
    when pg_get_constraintdef(con.oid) like '%info_requested%' then 'PASS'
    else '*** FAIL — info_requested still missing ***'
  end as status,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class rel      on rel.oid = con.conrelid
join pg_namespace nsp  on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname in ('ambassadors', 'partners')
  and con.conname in ('ambassadors_status_check', 'partners_status_check')
order by rel.relname;


-- ---------------------------------------------------------------------
-- ROLLBACK — only if you need to undo this.
--
-- Narrowing the constraint FAILS if any row already holds `info_requested`,
-- which is correct: it refuses rather than silently leaving the table
-- unprotected. Set those rows to `pending` first if you genuinely want to
-- revert.
--
--   begin;
--   alter table public.ambassadors drop constraint if exists ambassadors_status_check;
--   alter table public.ambassadors
--     add constraint ambassadors_status_check
--     check (status in ('pending', 'approved', 'disabled', 'rejected'));
--   commit;
--
-- There is no good reason to run this. The application writes
-- `info_requested`, so a database that rejects it is the broken state, not
-- the safe one.
-- ---------------------------------------------------------------------
