create or replace function public.current_auth_email() returns text language sql stable as $function$ select lower(auth.jwt() ->> 'email'); $function$;
create or replace function public.current_auth_role() returns text language sql stable as $function$ select auth.jwt() ->> 'role'; $function$;
create or replace function public.current_auth_uid() returns uuid language sql stable as $function$ select auth.uid(); $function$;
create or replace function public.order_attribution_touch_updated_at() returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin new.updated_at := now(); return new; end; $function$;
-- admin_ops_summary is deliberately NOT defined here.
--
-- This file is a point-in-time dump of the live functions, and the copy it
-- carried was the PRE-FIX body: gross sum(amount_paid) over payment_status
-- 'paid' only. setup-local-harness.sh applies this file LAST, so that stale
-- body overwrote the corrected one and the harness reported "live sales"
-- ignoring refunds — the exact drift admin-dashboard-rollups.sql was written
-- to remove. The harness now applies admin-dashboard-rollups.sql, which owns
-- this function; re-adding it here would silently win again.
create or replace function public.admin_points_outstanding() returns numeric language sql stable security definer set search_path to 'public','pg_temp' as $function$
  select coalesce(sum(amount),0) from public.points_ledger;
$function$;

-- ---------------------------------------------------------------------------
-- I-11 — close these to anon on creation, rather than sweeping up afterwards.
--
-- Supabase's default privilege grants EXECUTE on every function created in
-- `public` to `anon` and `authenticated`. A SECURITY DEFINER function is
-- therefore reachable by anyone holding the public anon key the moment it
-- exists. That is exactly how `create_partner_invite` became an
-- unauthenticated, RLS-bypassing write into the affiliate money tables (I-07).
--
-- Production is currently clean, because migration 20260825003037 swept every
-- function that existed at that moment. But a sweep is point-in-time and the
-- default is still armed — HALF of it cannot even be disarmed from this
-- project's access (see sql/rpc-default-privilege-lockdown.sql for the proof).
-- So re-running this file in a fresh environment would create these
-- world-executable, and the sweep would have to be remembered again.
--
-- rpc-security-posture.test.ts fails the build if a new function arrives here
-- without one of these lines.
-- ---------------------------------------------------------------------------
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='anon') then
    execute $q$revoke all on function public.admin_points_outstanding() from public, anon, authenticated;$q$;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.admin_points_outstanding() to service_role;$q$;
  end if;
  if exists (select 1 from pg_roles where rolname='anon') then
    execute $q$revoke all on function public.current_auth_email() from public, anon, authenticated;$q$;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.current_auth_email() to service_role;$q$;
  end if;
end
$rpc_lockdown$;

