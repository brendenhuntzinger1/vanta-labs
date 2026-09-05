-- Take the catalog off the public internet.
--
-- ============================================================================
-- WHY THIS FILE IS THE REAL FIX AND EVERYTHING IN THE APP IS SECONDARY
-- ============================================================================
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY is designed to be public. It is inlined into
-- browser bundles by construction, and PostgREST is internet-facing. Supabase's
-- whole security model therefore assumes the key is known and puts the boundary
-- in row-level security. rls-enforce-all-tables.sql in this directory already
-- says so in its own header.
--
-- The products table carried a policy granting SELECT to `public`, which
-- includes `anon`. So the entire catalog was readable by anyone, with no
-- account, no session, and without touching the Next.js app at all:
--
--     $ curl 'https://<ref>.supabase.co/rest/v1/products?select=name,price_cents' \
--         -H "apikey: <the public anon key>"
--     [{"name":"GLP-1","price_cents":4499}, ...]
--     content-range: 0-0/36
--
-- Measured against production on 2026-09-05: 36 rows, every name, slug,
-- category and price. Middleware gates, page guards and route guards are all
-- irrelevant to that request, because it never reaches them. Until these
-- policies are gone, every other layer is decoration.
--
-- ============================================================================
-- WHY THIS IS SAFE FOR THE STOREFRONT
-- ============================================================================
--
-- The application does not read products with the anon key. Every catalog read
-- in lib/catalog.ts goes through `supabaseAdmin` (lib/supabase-server.ts), the
-- service role, which bypasses RLS entirely. Verified by inspection before
-- writing this: the only browser-side uses of the anon client are
-- `supabase.auth.*` in the four account components and `removeChannel` in two
-- admin screens. There is not one anon-key table read of products anywhere.
--
-- KNOWN, ACCEPTED REGRESSION. /admin/products subscribes to postgres_changes on
-- products, product_doses and product_images using the anon key, so its list
-- will stop refreshing by itself when a row changes. Realtime honours RLS, and
-- with these policies gone the subscription receives no rows. The page still
-- loads its data through the admin API and still refreshes on demand. This is
-- the same trade rls-enforce-all-tables.sql already recorded for the
-- admin_audit_logs subscription, and the same answer applies: an auto-updating
-- list is not worth a publicly readable catalog.
--
-- ============================================================================
-- WHAT THIS DOES NOT DO
-- ============================================================================
--
-- It does not retract anything already public. Pages Google has indexed,
-- Wayback Machine snapshots, and product names already sent to the TikTok and
-- Meta pixels are out and stay out. This changes what is readable from now on.
--
-- It also does not vary by who is asking, and must never be made to. There is
-- no crawler list here and no user-agent test, because there cannot be one at
-- this layer and there should not be one at any layer: serving reviewers a
-- different site than customers is cloaking. This is a uniform wall. Anonymous
-- means anonymous, whether that is Googlebot, an ad-platform reviewer, a
-- competitor, or a shopper who has not signed in yet.
--
-- ============================================================================
-- REVERSING IT
-- ============================================================================
--
-- Re-run the `create policy` statements at the bottom of this file, which are
-- the exact definitions being dropped, captured from pg_policies before the
-- change. Reverting is a single transaction and takes effect immediately.
--
-- Apply with the deploy, not before it: while the old build is live the site
-- keeps working either way (it reads via the service role), so ordering is a
-- convenience rather than a constraint.

begin;

-- ---------------------------------------------------------------------------
-- products
--
-- Dropped policy, verbatim from pg_policies:
--   products_select_public  SELECT  to public
--   using (((is_active = true) AND (is_archived = false) AND (is_enabled = true)
--           AND (is_published = true))
--          OR ((select current_auth_role()) = 'admin'::text))
--
-- Replaced with an admin-only read. The admin console authenticates separately
-- and resolves through current_auth_role(), so staff keep their access; the
-- storefront never depended on this policy at all.
-- ---------------------------------------------------------------------------
drop policy if exists products_select_public on public.products;

create policy products_select_admin
  on public.products
  for select
  using ((select public.current_auth_role()) = 'admin');

-- ---------------------------------------------------------------------------
-- product_doses
--
-- Dropped policy, verbatim from pg_policies:
--   product_doses_select_public  SELECT  to public
--   using (EXISTS (SELECT 1 FROM products p
--                   WHERE p.id = product_doses.product_id
--                     AND (((p.is_active = true) AND (p.is_archived = false)
--                           AND (p.is_enabled = true) AND (p.is_published = true))
--                          OR ((select current_auth_role()) = 'admin'::text))))
--
-- Doses carry the per-size prices. Leaving them readable would publish the
-- price list even with products closed, and the dose labels ("10mg") plus the
-- product_id would rebuild much of the catalogue shape besides.
-- ---------------------------------------------------------------------------
drop policy if exists product_doses_select_public on public.product_doses;

create policy product_doses_select_admin
  on public.product_doses
  for select
  using ((select public.current_auth_role()) = 'admin');

commit;

-- ---------------------------------------------------------------------------
-- VERIFY, as anon, after applying. Both must return zero rows.
--
--   curl 'https://<ref>.supabase.co/rest/v1/products?select=name&limit=5' \
--     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--   curl 'https://<ref>.supabase.co/rest/v1/product_doses?select=id&limit=5' \
--     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--
-- And confirm the storefront still works: an authenticated customer must still
-- see the full catalogue, because that path reads through the service role.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- ROLLBACK, if this needs to be undone:
--
--   begin;
--   drop policy if exists products_select_admin on public.products;
--   drop policy if exists product_doses_select_admin on public.product_doses;
--
--   create policy products_select_public on public.products
--     for select
--     using (((is_active = true) and (is_archived = false) and (is_enabled = true)
--             and (is_published = true))
--            or ((select public.current_auth_role()) = 'admin'));
--
--   create policy product_doses_select_public on public.product_doses
--     for select
--     using (exists (select 1 from public.products p
--                     where p.id = product_doses.product_id
--                       and (((p.is_active = true) and (p.is_archived = false)
--                             and (p.is_enabled = true) and (p.is_published = true))
--                            or ((select public.current_auth_role()) = 'admin'))));
--   commit;
-- ---------------------------------------------------------------------------
