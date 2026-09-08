-- ===========================================================================
-- RESOLVE A SET OF AUTH USER IDS TO ADDRESSES, DIRECTLY.
--
-- customer_preferences stores a user_id, not an address, so every audience
-- build has to turn opted-in ids into emails. supabase-js's admin API offers
-- listUsers() with paging and nothing else, so loadConsentedAudience paged the
-- WHOLE auth directory and kept the rows that matched. Two costs:
--
--   * O(every account that has ever signed up), paid on every campaign send
--     and every audience preview, however few people are actually opted in.
--     A store with 50,000 accounts and 400 opted-in subscribers read 50,000
--     rows to find 400.
--
--   * A ceiling of 100 pages x 1,000. Past 100,000 accounts an opted-in
--     customer was simply not found — no error, no mention, just a campaign
--     sent to a short list. That is the same silent-short-read failure the
--     bounded reader in audience.ts already refuses for the suppression list.
--
-- This is the direct question. SECURITY DEFINER because auth.users is not
-- readable through the API role; executable by the service role only, which is
-- the only caller. Returns id and email and nothing else, so no auth column
-- shape is duplicated here.
--
-- The code degrades without it: when the function is absent the resolver pages
-- the directory instead (slower, still correct, and now refuses rather than
-- truncating). Apply in Supabase -> SQL Editor; idempotent and safe to re-run.
-- ===========================================================================

create or replace function public.auth_emails_by_user_ids(p_ids uuid[])
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.email
  from auth.users u
  where u.id = any(coalesce(p_ids, '{}'::uuid[]))
    and u.email is not null;
$$;

comment on function public.auth_emails_by_user_ids(uuid[]) is
  'Addresses for a set of auth.users ids. Service role only; backs loadConsentedAudience so building an audience costs the opted-in list rather than the whole directory.';

revoke execute on function public.auth_emails_by_user_ids(uuid[]) from public, anon, authenticated;
grant execute on function public.auth_emails_by_user_ids(uuid[]) to service_role;
