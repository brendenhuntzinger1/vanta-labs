-- =============================================================================
-- validate_referral_code — stop handing out commission terms to the internet.
--
-- THIS IS THE ONE SECURITY DEFINER FUNCTION ANONYMOUS CALLERS MAY EXECUTE.
-- rpc-execute-lockdown.sql revoked EXECUTE from public/anon/authenticated on
-- every other one; this stays callable because the cart has to check a referral
-- code before the shopper has an account. That makes what it RETURNS the entire
-- anonymous read surface of the ambassador programme, so it should return the
-- minimum the cart actually renders and nothing else.
--
-- WHAT IT WAS RETURNING THAT IT SHOULD NOT
--
--   commission_percent — what Vanta pays that ambassador.
--
-- Confidential business terms, reachable by anyone with the public anon key
-- (which ships in the client bundle) at /rest/v1/rpc/validate_referral_code.
-- Referral codes are short, human-chosen and guessable, and a PostgREST RPC
-- does not pass through the application's rate limiter, so the codes can be
-- swept. One ambassador discovering another's rate is a real problem, and the
-- field bought nothing: NOTHING reads it.
--
--   * referral-client.ts returned it,
--   * cart-context.tsx stored it on referralDetails,
--   * and no component ever rendered it.
--
-- The commission that actually gets paid never came from here in the first
-- place. quote-order.ts re-reads commission_percent from the ambassadors table
-- with the service role and resolves it against the performance tiers; the
-- client only ever supplies the CODE. So this removes a leak, not a feature.
--
-- WHAT IT STILL RETURNS, AND WHY
--
--   valid, referral_code, ambassador_id, ambassador_name
--
-- The name is deliberate: the cart, the drawer and the checkout summary all
-- show "Ambassador <name> · N% off" so the shopper can confirm they applied
-- the right person's code. A caller who already holds a valid code learns a
-- name that the UI would show them anyway.
--
-- RESIDUAL, STATED PLAINLY. Guessing a valid code still reveals that name.
-- Closing that means moving validation behind a rate-limited application route
-- and revoking the anon grant — a larger change to a live checkout path, left
-- documented rather than attempted here.
--
-- The ambassadors TABLE itself is not exposed: RLS is on and `set role anon`
-- sees 0 rows, verified behaviourally.
-- =============================================================================

create or replace function public.validate_referral_code(input_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'valid', true,
    'referral_code', a.referral_code,
    'ambassador_id', a.id,
    'ambassador_name', a.name
    -- commission_percent deliberately omitted. See the header.
  )
  into result
  from public.ambassadors a
  where a.referral_code = upper(trim(input_code))
    and a.status = 'approved'
  limit 1;

  if result is null then
    return jsonb_build_object('valid', false);
  end if;

  return result;
end;
$function$;

-- Re-assert the grants exactly as the lockdown left them. CREATE OR REPLACE
-- keeps existing privileges, but stating them here means this file can be run
-- on a fresh database and produce the same posture rather than a more open one.
revoke all on function public.validate_referral_code(text) from public;
do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.validate_referral_code(text) to anon, authenticated, service_role;$q$;
  end if;
end
$rpc_lockdown$;

