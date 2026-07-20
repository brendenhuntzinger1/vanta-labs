-- Client-safe referral code validation.
--
-- src/lib/referral-client.ts calls supabase.rpc("validate_referral_code", ...)
-- from the browser (anon key) so the cart can preview a referral discount
-- before checkout. public.ambassadors has RLS restricting SELECT to the
-- owning partner or an admin (see ambassadors_select_owner_or_admin in
-- partner-system-repair.sql), so an anonymous shopper cannot read it
-- directly. This function runs as security definer to look up only the
-- minimal, non-sensitive fields needed to apply a discount, without
-- exposing the rest of the ambassadors table to anonymous callers.
--
-- Run after partner-system-repair.sql.

create or replace function public.validate_referral_code(input_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'valid', true,
    'referral_code', a.referral_code,
    'ambassador_id', a.id,
    'ambassador_name', a.name,
    'commission_percent', a.commission_percent
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
$$;

grant execute on function public.validate_referral_code(text) to anon, authenticated;
