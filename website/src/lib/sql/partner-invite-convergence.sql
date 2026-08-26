-- =============================================================================
-- F-013 — make the ADMIN INVITE path atomic and identity-aware
-- =============================================================================
--
-- THE DEFECT
--
-- createPartnerInvite (src/lib/partner-portal.ts) wrote `partners` and then
-- `ambassadors` as two independent PostgREST statements. Two statements over
-- HTTP are two transactions, so there was nothing to roll the first one back.
--
-- `partners` has NO unique constraint on email; `ambassadors` does. So when the
-- invited address already belonged to an ambassador -- which is precisely what
-- "the admin pre-added this person" means -- the partners insert COMMITTED and
-- the ambassadors insert raised 23505 on ambassadors_email_key. The admin saw a
-- 400 and reasonably assumed nothing had happened.
--
-- What was left behind is the BRUTUS row: a `partners` row holding a live,
-- unique-claimed referral code with no `ambassadors` twin. validate_referral_code
-- reads `ambassadors`, so that code is dead at checkout -- it looks issued and
-- earns nothing.
--
-- It also silently DEFEATED the F-009 repair. The orphan carries auth_user_id,
-- so when the invitee later applied, both the app layer and
-- create_partner_application matched on auth_user_id, found the orphan, and
-- returned it as "already applied". Adoption never ran, and the person's real
-- approved identity -- with the rates the admin configured -- stayed stranded in
-- `ambassadors`, unclaimed, forever.
--
-- THE REPAIR
--
-- Same shape as F-009, because it is the same defect through a different door:
-- one plpgsql body is one transaction, and identity is the person (their email),
-- not the auth row.
--
--   1. Already invited/applied under this auth user? Hand back what exists.
--   2. An ambassador already holds this email?
--        - claimed by ANOTHER account -> raise. Silently merging two people's
--          identities is worse than failing.
--        - unclaimed -> ADOPT it. Claim it for the invited auth user and ensure
--          the partners twin exists with the SAME id.
--   3. Nobody by either -> create BOTH rows, or neither.
--
-- Nothing the admin configured is overwritten on adoption: not the referral code
-- (which may already be in circulation), not the commission rate, not the
-- customer discount, not the status. In particular the invite form's default
-- commission does NOT overwrite a rate the admin deliberately set -- silently
-- downgrading someone's rate through a form default is a money defect.
--
-- Verified by src/lib/partner-invite-atomicity.test.ts, which runs the REAL
-- createPartnerInvite against a real Postgres. An in-memory fake cannot prove
-- it: the defect lives entirely in the interaction between two un-transacted
-- statements and a UNIQUE constraint, and a fake that does not model that
-- constraint reports success on the exact input that fails in production.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_partner_invite(
  p_id uuid,
  p_auth_user_id uuid,
  p_name text,
  p_email text,
  p_referral_code text,
  p_commission_percent numeric,
  p_created_by uuid DEFAULT NULL)
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
  -- 1. This auth account already has an identity. Hand it back rather than mint
  --    a second one; re-inviting someone must not duplicate them.
  if p_auth_user_id is not null then
    select id, status, referral_code, commission_percent into existing
    from public.partners
    where auth_user_id = p_auth_user_id
    limit 1;

    if found then
      return jsonb_build_object(
        'partner_id', existing.id,
        'status', existing.status,
        'referral_code', existing.referral_code,
        'commission_percent', existing.commission_percent,
        'created', false,
        'adopted', false
      );
    end if;
  end if;

  -- 2. Pre-added by an admin under this email? Identity is the person, not the
  --    auth row, so compare case-insensitively. Oldest first, so the result is
  --    deterministic if two rows ever differ only by case (the unique index is
  --    on the raw value, so that is possible).
  select id, status, referral_code, commission_percent, auth_user_id into pre_added
  from public.ambassadors
  where lower(email) = lower(p_email)
  order by created_at
  limit 1;

  if found then
    -- Someone else's account already owns this ambassador. Fail loudly rather
    -- than hand one person's earnings to another.
    if pre_added.auth_user_id is not null
       and pre_added.auth_user_id is distinct from p_auth_user_id then
      raise exception
        'ambassador % is already claimed by another account', p_email
        using errcode = 'unique_violation';
    end if;

    -- Claim the admin's row for the invited account. The referral code, rates
    -- and status stay exactly as configured; only the link to the auth account
    -- and the invite timestamp change.
    update public.ambassadors set
      auth_user_id = p_auth_user_id,
      name         = coalesce(nullif(p_name, ''), name),
      invited_at   = coalesce(invited_at, now_ts),
      updated_at   = now_ts
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
      a.approved_at, a.disabled_at, coalesce(a.created_by, p_created_by),
      a.payout_method, a.payout_handle, a.payout_updated_at
    from public.ambassadors a
    where a.id = pre_added.id
    on conflict (id) do update set
      auth_user_id = excluded.auth_user_id,
      name         = excluded.name,
      invited_at   = excluded.invited_at,
      updated_at   = excluded.updated_at;

    return jsonb_build_object(
      'partner_id', pre_added.id,
      'status', pre_added.status,
      'referral_code', pre_added.referral_code,
      'commission_percent', pre_added.commission_percent,
      'created', false,
      'adopted', true
    );
  end if;

  -- 3. Nobody by this auth user and nobody pre-added: a genuinely new invitee.
  --    BOTH ROWS OR NEITHER -- one plpgsql body is one transaction.
  insert into public.partners (
    id, name, email, referral_code, status, commission_percent, auth_user_id,
    invited_at, created_by, updated_at
  ) values (
    p_id, p_name, p_email, p_referral_code, 'pending', p_commission_percent, p_auth_user_id,
    now_ts, p_created_by, now_ts
  );

  insert into public.ambassadors (
    id, name, email, referral_code, status, commission_percent, auth_user_id,
    invited_at, created_by, updated_at
  ) values (
    p_id, p_name, p_email, p_referral_code, 'pending', p_commission_percent, p_auth_user_id,
    now_ts, p_created_by, now_ts
  );

  return jsonb_build_object(
    'partner_id', p_id,
    'status', 'pending',
    'referral_code', p_referral_code,
    'commission_percent', p_commission_percent,
    'created', true,
    'adopted', false
  );
end;
$function$;
