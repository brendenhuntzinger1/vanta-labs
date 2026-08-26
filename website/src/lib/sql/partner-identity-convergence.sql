-- =============================================================================
-- F-009 — recognise a pre-added ambassador when that person later applies
-- =============================================================================
--
-- THE DEFECT
--
-- create_partner_application matched an existing identity by auth_user_id
-- alone. An ambassador the admin pre-added -- email known, no auth account yet
-- -- has auth_user_id NULL, so when that same person signed up and applied
-- through the site they matched nothing and the function tried to mint a second
-- identity. `partners` has no unique constraint on email so that insert
-- succeeded; `ambassadors` does, so the second insert raised 23505 on
-- ambassadors_email_key and the whole application rolled back.
--
-- The earlier repair (both inserts in one transaction) fixed the CORRUPTION:
-- there is no orphan partners row any more. It did not fix the RECOGNITION, so
-- the applicant simply could never apply. Every retry failed identically, the
-- admin saw no application, and the person was stuck behind an opaque error.
-- This is the other half of the BRUTUS defect.
--
-- THE REPAIR
--
-- When no partners row matches auth_user_id, look for a pre-added ambassador
-- with the same email that no account has claimed yet, and ADOPT it: claim the
-- existing row for this auth user and make sure its partners twin exists with
-- the same id. Nothing the admin configured is overwritten -- not the referral
-- code (which may already be in circulation), not the commission rate, not the
-- customer discount, not the status.
--
-- If the email belongs to an ambassador some OTHER account already claimed,
-- raise. Silently merging two people's identities would be worse than failing.
--
-- Verified by src/lib/partner-identity-convergence.test.ts, which runs this
-- function against a real Postgres. An in-memory fake cannot prove it: the
-- defect lives in the interaction between the function body and a UNIQUE
-- constraint, and a fake that does not model the constraint reports success on
-- the exact input that fails in production.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_partner_application(
  p_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_email text,
  p_referral_code text,
  p_commission_percent numeric,
  p_applicant jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  existing    record;
  pre_added   record;
  now_ts      timestamptz := now();
begin
  -- 1. Already applied? Hand back what exists. Never a second identity, never a
  --    rewrite of rates the owner may have configured since.
  select id, status, referral_code into existing
  from public.partners
  where auth_user_id = p_auth_user_id
  limit 1;

  if found then
    return jsonb_build_object(
      'partner_id', existing.id,
      'status', existing.status,
      'referral_code', existing.referral_code,
      'created', false
    );
  end if;

  -- 2. Pre-added by the admin under this email? Identity is the person, not the
  --    auth row, so compare case-insensitively. Oldest first, so the result is
  --    deterministic if two rows ever differ only by case (the unique index is
  --    on the raw value, so that is possible).
  select id, status, referral_code, auth_user_id into pre_added
  from public.ambassadors
  where lower(email) = lower(p_email)
  order by created_at
  limit 1;

  if found then
    -- Someone else's account already owns this ambassador. Fail loudly rather
    -- than hand one person's earnings to another.
    if pre_added.auth_user_id is not null
       and pre_added.auth_user_id <> p_auth_user_id then
      raise exception
        'ambassador % is already claimed by another account', p_email
        using errcode = 'unique_violation';
    end if;

    -- Claim the admin's row. Applicant details fill in only where the admin
    -- left a blank; the referral code, rates and status stay exactly as
    -- configured.
    update public.ambassadors set
      auth_user_id  = p_auth_user_id,
      name          = coalesce(nullif(p_name, ''), name),
      first_name    = coalesce(p_applicant->>'first_name', first_name),
      last_name     = coalesce(p_applicant->>'last_name', last_name),
      phone         = coalesce(p_applicant->>'phone', phone),
      social        = coalesce(p_applicant->>'social', social),
      follower_count = coalesce((p_applicant->>'follower_count')::int, follower_count),
      preferred_referral_code = coalesce(p_applicant->>'preferred_referral_code', preferred_referral_code),
      updated_at    = now_ts
    where id = pre_added.id;

    -- The partners twin must exist and carry the SAME id. Pre-adding writes
    -- ambassadors only, so it is usually missing; if a twin is already there,
    -- claim it the same way.
    insert into public.partners (
      id, name, email, referral_code, status, commission_percent, auth_user_id,
      invited_at, updated_at,
      first_name, last_name, phone, social, follower_count, preferred_referral_code,
      commission_percent_locked, customer_discount_percent,
      approved_at, disabled_at, created_by, payout_method, payout_handle, payout_updated_at
    )
    select
      a.id, a.name, a.email, a.referral_code, a.status, a.commission_percent, p_auth_user_id,
      coalesce(a.invited_at, now_ts), now_ts,
      a.first_name, a.last_name, a.phone, a.social, a.follower_count, a.preferred_referral_code,
      a.commission_percent_locked, a.customer_discount_percent,
      a.approved_at, a.disabled_at, a.created_by, a.payout_method, a.payout_handle, a.payout_updated_at
    from public.ambassadors a
    where a.id = pre_added.id
    on conflict (id) do update set
      auth_user_id = excluded.auth_user_id,
      name         = excluded.name,
      first_name   = excluded.first_name,
      last_name    = excluded.last_name,
      phone        = excluded.phone,
      social       = excluded.social,
      follower_count = excluded.follower_count,
      preferred_referral_code = excluded.preferred_referral_code,
      updated_at   = excluded.updated_at;

    return jsonb_build_object(
      'partner_id', pre_added.id,
      'status', pre_added.status,
      'referral_code', pre_added.referral_code,
      'created', false,
      'adopted', true
    );
  end if;

  -- 3. Nobody by this auth user and nobody pre-added: a genuinely new applicant.
  --    BOTH ROWS OR NEITHER -- one plpgsql body is one transaction.
  insert into public.partners (
    id, name, email, referral_code, status, commission_percent, auth_user_id,
    invited_at, updated_at,
    first_name, last_name, phone, social, follower_count, preferred_referral_code
  ) values (
    p_id, p_name, p_email, p_referral_code, 'pending', p_commission_percent, p_auth_user_id,
    now_ts, now_ts,
    p_applicant->>'first_name', p_applicant->>'last_name', p_applicant->>'phone',
    p_applicant->>'social', (p_applicant->>'follower_count')::int,
    p_applicant->>'preferred_referral_code'
  );

  insert into public.ambassadors (
    id, name, email, referral_code, status, commission_percent, auth_user_id,
    invited_at, updated_at,
    first_name, last_name, phone, social, follower_count, preferred_referral_code
  ) values (
    p_id, p_name, p_email, p_referral_code, 'pending', p_commission_percent, p_auth_user_id,
    now_ts, now_ts,
    p_applicant->>'first_name', p_applicant->>'last_name', p_applicant->>'phone',
    p_applicant->>'social', (p_applicant->>'follower_count')::int,
    p_applicant->>'preferred_referral_code'
  );

  return jsonb_build_object(
    'partner_id', p_id, 'status', 'pending',
    'referral_code', p_referral_code, 'created', true
  );
end;
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
    execute $q$revoke all on function public.create_partner_application(uuid, uuid, text, text, text, numeric, jsonb) from public, anon, authenticated;$q$;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.create_partner_application(uuid, uuid, text, text, text, numeric, jsonb) to service_role;$q$;
  end if;
end
$rpc_lockdown$;

