-- ============================================================================
-- VANTA LABS — LOOK AN AUTH USER UP BY EMAIL, DIRECTLY
--
-- APPLIED TO PRODUCTION 2026-09-05 09:27 UTC via the Supabase migration API
-- (migration name `auth_user_id_by_email`), as part of the launch-audit
-- closeout. Additive: one SECURITY DEFINER function executable by service_role
-- only. Safe to re-run.
--
-- Source of truth: ../auth-user-by-email.sql (this file is the record of what
-- ran; edit that one). The local harness applies it from
-- scripts/setup-local-harness.sh's post-parity list.
--
-- WHY. findUserByEmail (lib/auth-confirmation-email.ts) could only page the
-- newest 1,000 accounts through listUsers(); an older customer signing up
-- again or asking for a new confirmation link was told no account existed.
-- The code degrades correctly when the function is absent (it pages the whole
-- directory), so either deployment order is safe.
-- ============================================================================

create or replace function public.auth_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(trim(coalesce(p_email, '')))
  order by u.created_at asc
  limit 1;
$$;

comment on function public.auth_user_id_by_email(text) is
  'The auth.users id for an email address (case-insensitive), or null. Service role only; backs findUserByEmail so signup/resend can find any account, not just the newest 1,000.';

revoke execute on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;
