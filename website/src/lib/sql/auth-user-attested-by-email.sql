-- ===========================================================================
-- HAS THIS ADDRESS ALREADY MADE THE 21+ AND RESEARCH-USE REPRESENTATIONS?
--
-- WHY IT IS NEEDED. Every marketing email's button lands on the sign-in wall,
-- because access-policy.ts makes the store account-only and /products, /cart
-- and /account/orders — the only cta_path values in production — are all
-- behind it. The fix (lib/email/link-grant.ts) mints a short-lived browse
-- capability when a recipient clicks. It must NOT mint one for a person who
-- has never made the two required representations: they are collected as tick
-- boxes on the sign-in form itself, so the wall and the age gate are one
-- screen, and skipping the wall would skip the attestation.
--
-- So the click tracker asks this question, in one round trip, before it grants
-- anything. It sits on the redirect path a customer is waiting on, which is
-- why it is a single boolean rather than findUserByEmail's RPC-then-admin-API
-- pair: a marketing click must not pay two round trips to learn one fact.
--
-- WHAT IT ANSWERS. True only when BOTH representations are recorded on the
-- account. Anything else — no account, one box, neither — is false, and false
-- means the shopper goes to sign in and attests there. False is also the
-- answer for an address this cannot resolve, because the safe direction for a
-- compliance check is to ask again rather than to assume.
--
-- The metadata keys are the ones /api/auth/signup and /api/auth/session write
-- (age_confirmed_21, research_use_only_agreed). They are read as text and
-- compared to 'true' so a boolean true and the string "true" both count; a
-- missing key yields null, which is not 'true'.
--
-- SECURITY DEFINER because auth.users is not readable through the API role.
-- Executable by the service role only. The code degrades without it: the
-- lookup answers "not attested" when the function is absent, so grants simply
-- are not minted and every recipient sees the sign-in page — the exact
-- behaviour that existed before the grant did. Apply in Supabase → SQL Editor;
-- idempotent and safe to re-run.
-- ===========================================================================

create or replace function public.auth_user_attested_by_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select (u.raw_user_meta_data ->> 'age_confirmed_21') = 'true'
         and (u.raw_user_meta_data ->> 'research_use_only_agreed') = 'true'
      from auth.users u
      where lower(u.email) = lower(trim(coalesce(p_email, '')))
      order by u.created_at asc
      limit 1
    ),
    false
  );
$$;

comment on function public.auth_user_attested_by_email(text) is
  'True when the account for this address carries both the 21+ and research-use-only representations. Service role only; gates whether a marketing-link click may mint a browse grant (lib/email/link-grant.ts).';

revoke execute on function public.auth_user_attested_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_attested_by_email(text) to service_role;
