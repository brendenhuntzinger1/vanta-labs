-- Atomic coupon redemption.
--
-- src/lib/coupons.ts redeemCoupon() previously did a read-modify-write
-- (SELECT redemptions_count, then UPDATE to count + 1). Two paid orders
-- confirming a coupon at its exact limit at the same time could each read the
-- old count and both write count + 1, over-counting by one and letting a
-- redemption past max_redemptions slip through.
--
-- This function increments in a single statement. The row is locked for the
-- duration of the UPDATE, so concurrent redemptions serialize: the max-check
-- and the increment happen together, with no window between them. It returns
-- whether the redemption was recorded so the caller can log an exhausted code.
--
-- redeemCoupon() calls this with the service-role key; it falls back to the
-- old read-modify-write if this function is absent (partially-migrated DB), so
-- running this migration is an optional hardening, not a hard requirement.
--
-- Safe to run more than once.

create or replace function public.redeem_coupon(input_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_count integer;
begin
  update public.coupons
     set redemptions_count = coalesce(redemptions_count, 0) + 1
   where code = upper(trim(input_code))
     and active = true
     and (max_redemptions is null or coalesce(redemptions_count, 0) < max_redemptions)
   returning redemptions_count into new_count;

  if new_count is null then
    -- No row matched: unknown/inactive code, or already at its limit.
    return jsonb_build_object('redeemed', false);
  end if;

  return jsonb_build_object('redeemed', true, 'redemptions_count', new_count);
end;
$$;

grant execute on function public.redeem_coupon(text) to service_role;
