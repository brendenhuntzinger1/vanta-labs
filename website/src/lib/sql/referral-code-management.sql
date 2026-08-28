-- ============================================================================
-- VANTA LABS — Ambassador Referral Code Management (P-feature).
-- SAFE MIGRATION, HELD FOR REVIEW — do not run until approved.
-- Adds: change-history (immutable), old-code aliases (for redirects), per-code
-- lock + last-changed timestamp, and case-insensitive uniqueness enforcement.
-- Idempotent (if not exists). No data change. Rollback notes at the bottom.
-- ============================================================================

-- 1) Per-ambassador code controls (lock + last-changed) on BOTH mirror tables.
alter table public.ambassadors
  add column if not exists referral_code_locked boolean not null default false,
  add column if not exists referral_code_changed_at timestamptz;
alter table public.partners
  add column if not exists referral_code_locked boolean not null default false,
  add column if not exists referral_code_changed_at timestamptz;

-- 2) Immutable change history — NEVER deleted. One row per code change.
create table if not exists public.referral_code_changes (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null,
  old_code text,
  new_code text not null,
  actor text not null,            -- 'ambassador' | 'admin:<username>' | 'system'
  reason text,                    -- e.g. 'self_service' | 'admin_force' | 'restore'
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_rcc_ambassador on public.referral_code_changes(ambassador_id, created_at desc);
create index if not exists idx_rcc_old_code on public.referral_code_changes(old_code);

-- 3) Old-code aliases — power the "old links keep working" redirect. A retired
--    code points at the ambassador so /r/<oldcode> resolves to their CURRENT
--    code. expires_at lets the admin choose how long old links live (or NULL =
--    forever). active=false = the admin chose "disable old codes immediately".
create table if not exists public.referral_code_aliases (
  id uuid primary key default gen_random_uuid(),
  alias_code text not null,
  alias_fingerprint text not null,   -- look-alike key (separators stripped)
  ambassador_id uuid not null,
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
-- One live alias per code; a re-used old code updates the same row.
create unique index if not exists uq_rca_alias_code on public.referral_code_aliases(alias_code);
create index if not exists idx_rca_fingerprint on public.referral_code_aliases(alias_fingerprint);
create index if not exists idx_rca_ambassador on public.referral_code_aliases(ambassador_id);

-- 4) Case-insensitive UNIQUENESS on the live code (codes are stored uppercase,
--    so a plain unique index is case-insensitive in practice). This is the
--    RACE BACKSTOP: two ambassadors can never end up with the same code even if
--    both pass the app-level availability check simultaneously — the second
--    UPDATE fails the constraint. MUST run after de-duping any existing codes
--    (see production-readiness-checks.sql check #3); if duplicates exist this
--    errors and tells you to fix them first.
create unique index if not exists uq_ambassadors_referral_code
  on public.ambassadors(referral_code)
  where referral_code is not null;

-- Verify what landed:
select
  (select count(*) from information_schema.columns where table_schema='public' and table_name='ambassadors' and column_name='referral_code_locked') as lock_col,
  (select count(*) from information_schema.tables  where table_schema='public' and table_name='referral_code_changes') as history_table,
  (select count(*) from information_schema.tables  where table_schema='public' and table_name='referral_code_aliases') as alias_table,
  (select count(*) from pg_indexes where schemaname='public' and indexname='uq_ambassadors_referral_code') as unique_index;

-- Rollback:
--   drop index if exists public.uq_ambassadors_referral_code;
--   drop table if exists public.referral_code_aliases;
--   drop table if exists public.referral_code_changes;
--   alter table public.ambassadors drop column if exists referral_code_locked, drop column if exists referral_code_changed_at;
--   alter table public.partners    drop column if exists referral_code_locked, drop column if exists referral_code_changed_at;

-- ============================================================================
-- CLOSE THE TWO TABLES THIS FILE CREATES. Added 2026-08-28 after an adversarial
-- review pointed out that this file is DEPLOYMENT-ORDER.md STEP 4 — a file
-- someone runs — and it created two tables with no RLS, no revoke, no policy
-- and no grant anywhere in it.
--
-- Protection existed only in a separate sweep (rls-enforce-all-tables.sql:69)
-- that has to be remembered and run afterwards. That is the same
-- non-self-contained shape already ruled a defect on ads-system.sql: a migration
-- cannot assume the database it lands in has already been hardened, and
-- Supabase's default privilege deliberately keeps SELECT for anon, so a table
-- created in `public` with RLS off is anon-readable from the moment it exists.
--
-- What that would have leaked on a fresh environment is not abstract.
-- referral_code_changes records `ip_address` and `user_agent` alongside each
-- ambassador's old and new code and who changed it; referral_code_aliases is the
-- full retired-code-to-ambassador map. rls-enforce-all-tables.sql:68 names it
-- exactly: "Ambassador code history, including the actor's IP address and user
-- agent."
--
-- SCOPE, honestly: in the CURRENT production database both tables are already
-- locked — they are among the 36 policy-less RLS tables that RLS-05 revoked
-- SELECT on, verified by probe (both return 42501 to the publishable key). The
-- defect was in the file, for the next environment, not in today's database.
--
-- RLS with no policy denies every row to anon and authenticated; service_role
-- bypasses it, and every reader of these two tables is server-side. Idempotent.
-- ============================================================================

alter table public.referral_code_changes enable row level security;
alter table public.referral_code_aliases enable row level security;

revoke all on public.referral_code_changes from anon, authenticated;
revoke all on public.referral_code_aliases from anon, authenticated;
