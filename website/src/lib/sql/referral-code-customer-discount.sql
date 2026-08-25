-- =============================================================================
-- SEND THE CART THE AMBASSADOR'S OWN DISCOUNT.
--
-- THE DEFECT. A 15% ambassador's customers were offered 10%.
--
-- ambassadors.customer_discount_percent held 15.00. The server read it and
-- charged 15% (quote-order.ts resolves it through
-- resolveAmbassadorCustomerDiscount against the program default). The CART had
-- no way to know: validate_referral_code returned only valid / referral_code /
-- ambassador_id / ambassador_name, so the cart fell back to the one number it
-- did have — the program-wide default, which is unset in admin_control and
-- therefore DEFAULT_REFERRAL_DISCOUNT_PERCENT = 10.
--
-- The rate was never wrong in the database. It was never sent to the browser.
--
-- WHY THIS IS THE RIGHT PLACE. referral-client.ts stopped returning a discount
-- deliberately: it used to hand back a hardcoded `discountPercent: 10`, which
-- is wrong for any ambassador with a personal rate. Removing the lie was right;
-- what was missing was the truth to replace it with. This function is already
-- the SECURITY DEFINER read that anon uses to check a code, so it is where the
-- real number belongs.
--
-- WHY IT IS SAFE TO EXPOSE. customer_discount_percent is the discount the
-- shopper is about to be shown and charged — they see it the instant the code
-- applies. It is not the ambassador's pay. commission_percent stays out, as it
-- was before, and the client-side privacy tests still assert that.
--
-- The added key is additive: existing callers that read only the four original
-- keys are unaffected. The server remains authoritative for the charge; this
-- only stops the preview from contradicting it.
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
    'ambassador_name', a.name,
    -- NULL is meaningful and is passed through as null, not coerced: it means
    -- "this ambassador has no override, use the program default". Collapsing it
    -- to 0 here would hand every inheriting ambassador a 0% discount.
    'customer_discount_percent', a.customer_discount_percent
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

-- Verification. Every approved ambassador must now come back with their own
-- rate, and commission_percent must NOT appear anywhere in the payload.
do $$
declare
  payload jsonb;
  code text;
begin
  for code in select referral_code from public.ambassadors where status = 'approved' loop
    payload := public.validate_referral_code(code);

    if not (payload ? 'customer_discount_percent') then
      raise exception 'validate_referral_code(%) omits customer_discount_percent', code;
    end if;

    if payload::text ilike '%commission%' then
      raise exception 'validate_referral_code(%) leaks commission data', code;
    end if;
  end loop;
end $$;
