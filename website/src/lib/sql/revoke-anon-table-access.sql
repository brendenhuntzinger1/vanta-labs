-- Take the database off the public internet, and keep it off.
--
-- ============================================================================
-- WHAT WAS WRONG
-- ============================================================================
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY is public by design and PostgREST is
-- internet-facing, so a table privilege granted to `anon` is a privilege
-- granted to the world. Measured on production 2026-09-05, `anon` and
-- `authenticated` each held 340 column-level SELECT grants across 28 tables:
--
--     products                36 rows readable: name, slug, category, price,
--                             batch_number, purity_result, descriptions
--     product_doses           49 rows: every size and its price
--     product_images          39 rows: every image URL, mapped to product_id
--     admin_credentials       password_hash, password_salt, passcode_hash,
--                             passcode_salt, username, role
--     admin_sessions          token_hash, expires_at, username, ip_address
--     partners                email, phone, payout_handle, commission_percent
--     customer_addresses      full_name, address, city, postal_code
--     customer_preferences    birthday, phone
--     email_delivery_events   recipient_email
--     notification_queue      recipient, payload
--     ...and eighteen more.
--
-- Row-level security was enabled on all 28 and WAS denying every row except the
-- three catalogue tables, so only the catalogue actually leaked. That is the
-- system working, but it is one lock doing the work of two: a single policy
-- rewritten too permissively, or one `disable row level security`, and the
-- admin password hashes are a curl away. A privilege that is never used should
-- not be held.
--
-- WHERE THE GRANTS CAME FROM, which matters more than the grants themselves.
-- Two ALTER DEFAULT PRIVILEGES entries on the public schema grant new tables to
-- anon and authenticated automatically:
--
--     postgres        -> anon, authenticated: rm  (SELECT, MAINTAIN)
--     supabase_admin  -> anon, authenticated: arwdDxtm (everything)
--
-- So this was never a one-off mistake to clean up. Every table anyone creates
-- in `public` from now on is granted to the world on creation. Revoking today
-- without changing that leaves the next migration to reintroduce it silently.
--
-- ============================================================================
-- WHY THIS IS SAFE
-- ============================================================================
--
-- The application never reads a table with the anon key. Verified by grep
-- before writing this: the browser client in lib/supabase.ts is used only for
-- `supabase.auth.*` and `removeChannel`. There is not one `.from()` call on it
-- anywhere in src/. Every data read goes through `supabaseAdmin`
-- (lib/supabase-server.ts), the service role, which bypasses both grants and
-- RLS. The same is true of `authenticated`: no browser-side table read exists
-- for a signed-in customer either, so both roles are revoked together.
--
-- KNOWN, ACCEPTED REGRESSION. Two admin screens open Supabase Realtime
-- channels with the anon key:
--     admin/products              -> products, product_doses, product_images
--     admin-control-center-client -> admin_audit_logs
-- Realtime honours grants and RLS, so those subscriptions stop delivering rows
-- and the lists no longer refresh by themselves. Both screens already load
-- their data through the admin API and refresh on demand, and the audit-log
-- subscription was already receiving nothing (its RLS denies anon), so the real
-- loss is the products list auto-updating. rls-enforce-all-tables.sql recorded
-- and accepted exactly this trade for admin_audit_logs; the same answer holds.
--
-- ============================================================================
-- WHAT THIS DOES NOT DO
-- ============================================================================
--
-- It does not vary by who is asking, and it must never be made to. There is no
-- crawler list here and no user-agent test, because serving reviewers a
-- different site than customers is cloaking. Anonymous means anonymous:
-- Googlebot, an ad reviewer, a competitor and a shopper who has not signed in
-- are treated identically, because they are identical.
--
-- It also does not retract anything already public. Pages Google has indexed,
-- archived snapshots, and product names already sent to ad-platform pixels are
-- out and stay out.

begin;

-- ---------------------------------------------------------------------------
-- 1. REVOKE EVERY SELECT anon AND authenticated HOLD ON public.
--
-- Table-level REVOKE also removes column-level grants, which is what these
-- are. Done as a loop rather than 340 statements so it cannot drift out of
-- date, and restricted to ordinary tables so views and sequences are untouched.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('revoke select on public.%I from anon, authenticated', r.relname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. STOP GRANTING NEW TABLES TO THE WORLD ON CREATION.
--
-- Without this the next `create table` re-opens the hole. Only the `postgres`
-- default is changed here: the `supabase_admin` entry belongs to the platform
-- and is not ours to rewrite from a migration. See the deployment note at the
-- bottom, which explains how to confirm the remaining one.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke select on tables from anon;
alter default privileges in schema public revoke select on tables from authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE CATALOGUE POLICIES, WHICH WERE THE ONLY ONES ACTUALLY LEAKING.
--
-- Dropped verbatim from pg_policies before the change:
--
--   products_select_public       SELECT to public
--     using (((is_active) AND (NOT is_archived) AND (is_enabled) AND (is_published))
--            OR current_auth_role() = 'admin')
--
--   product_doses_select_public  SELECT to public
--     using (exists (select 1 from products p where p.id = product_doses.product_id
--            and ((p.is_active AND NOT p.is_archived AND p.is_enabled AND p.is_published)
--                 OR current_auth_role() = 'admin')))
--
--   product_images_select_public SELECT to public   [same shape as doses]
--
-- Replaced with admin-only reads. The storefront is unaffected: it reads
-- through the service role, which no policy applies to. Belt as well as braces
-- — step 1 already removed the privilege, and this removes the permission.
-- ---------------------------------------------------------------------------
drop policy if exists products_select_public on public.products;
drop policy if exists product_doses_select_public on public.product_doses;
drop policy if exists product_images_select_public on public.product_images;

create policy products_select_admin on public.products
  for select using ((select public.current_auth_role()) = 'admin');

create policy product_doses_select_admin on public.product_doses
  for select using ((select public.current_auth_role()) = 'admin');

create policy product_images_select_admin on public.product_images
  for select using ((select public.current_auth_role()) = 'admin');

commit;

-- ---------------------------------------------------------------------------
-- VERIFY, as anon, from anywhere. Every one must return no rows.
--
--   curl 'https://<ref>.supabase.co/rest/v1/products?select=name&limit=5' \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
--   ...and the same for product_doses, product_images, admin_credentials,
--   admin_sessions, partners, customer_addresses.
--
-- Then confirm the storefront is unharmed: an authenticated customer must still
-- see the full catalogue, because that path reads through the service role.
--
-- MANUAL, IN THE SUPABASE DASHBOARD, AND NOT DOABLE FROM HERE:
-- the `supabase_admin` default-privilege entry still grants new tables to anon
-- and authenticated. It is platform-owned. Re-run the query below after any
-- Supabase platform upgrade to confirm nothing has been re-granted:
--
--   select grantee, count(*) from information_schema.column_privileges
--   where table_schema='public' and grantee in ('anon','authenticated')
--     and privilege_type='SELECT'
--   group by grantee;
--
-- Expected: zero rows.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ROLLBACK. Restores the exact pre-change state.
--
--   begin;
--   drop policy if exists products_select_admin on public.products;
--   drop policy if exists product_doses_select_admin on public.product_doses;
--   drop policy if exists product_images_select_admin on public.product_images;
--
--   create policy products_select_public on public.products for select
--     using (((is_active = true) and (is_archived = false) and (is_enabled = true)
--             and (is_published = true))
--            or ((select public.current_auth_role()) = 'admin'));
--
--   create policy product_doses_select_public on public.product_doses for select
--     using (exists (select 1 from public.products p
--                     where p.id = product_doses.product_id
--                       and (((p.is_active = true) and (p.is_archived = false)
--                             and (p.is_enabled = true) and (p.is_published = true))
--                            or ((select public.current_auth_role()) = 'admin'))));
--
--   create policy product_images_select_public on public.product_images for select
--     using (exists (select 1 from public.products p
--                     where p.id = product_images.product_id
--                       and (((p.is_active = true) and (p.is_archived = false)
--                             and (p.is_enabled = true) and (p.is_published = true))
--                            or ((select public.current_auth_role()) = 'admin'))));
--
--   alter default privileges in schema public grant select on tables to anon;
--   alter default privileges in schema public grant select on tables to authenticated;
--   -- and, to restore the blanket table grants:
--   -- do $$ declare r record; begin
--   --   for r in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--   --            where n.nspname='public' and c.relkind in ('r','p')
--   --   loop execute format('grant select on public.%I to anon, authenticated', r.relname);
--   --   end loop; end $$;
--   commit;
-- ---------------------------------------------------------------------------
