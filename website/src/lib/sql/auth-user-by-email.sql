-- ===========================================================================
-- LOOK AN AUTH USER UP BY EMAIL, DIRECTLY.
--
-- findUserByEmail (lib/auth-confirmation-email.ts) had no way to ask GoTrue
-- for one address: supabase-js's admin API offers listUsers() with paging and
-- nothing else, so it paged the newest 1,000 accounts and answered "no such
-- user" for anyone older. Past a thousand customers, a signup for an existing
-- older address raised a CRITICAL "no account exists" alert and sent nothing,
-- and the resend-confirmation button silently did nothing for them.
--
-- This is the direct question. SECURITY DEFINER because auth.users is not
-- readable through the API role; executable by the service role only, which
-- is the only caller. Returns the id and nothing else — the caller fetches
-- the user through the admin API it already uses, so no auth column shape is
-- duplicated here.
--
-- The code degrades without it: when the function is absent the lookup pages
-- the whole directory instead (slower, still correct). Apply in Supabase →
-- SQL Editor; idempotent and safe to re-run.
-- ===========================================================================

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
