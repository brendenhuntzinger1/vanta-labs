-- ============================================================================
-- VANTA LABS — PHASE 1 OF THE FINAL-AUDIT REMEDIATION
-- Close the six client-key holes in orders, order_items, ambassadors and the
-- three referral/analytics event tables.
--
-- Findings closed: RLS-01 / VL-2 (per-SKU COGS), RLS-04 (shipping margin),
-- AUTHZ-2 / VL-27 (customer PII to ambassadors), AUTHZ-1 / RLS-03 / VL-22
-- (anonymous ambassador registration), AUTHZ-3 / RLS-02 / VL-SQL-01
-- (anonymous writes to referrals, partner_clicks, website_analytics_events).
--
-- Recorded here under the same version applied to production so the database
-- and the repository carry the same history — the drift pattern F-009 names.
-- Safe to re-run: every statement is idempotent.
--
-- ----------------------------------------------------------------------------
-- WHAT WAS ACTUALLY WRONG
--
-- Not RLS. Every one of these tables has a correct row policy. The hole is one
-- level below: all six carry a blanket
--
--     grant all on <table> to anon, authenticated
--
-- — SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on every
-- column. RLS was the only thing standing between the publishable key that
-- ships to every browser and these tables, and RLS cannot express "these rows,
-- but not those columns". So wherever a row policy legitimately lets a caller
-- see a row, it hands over all 104 columns of it.
--
-- REPRODUCED against production before changing anything, as role
-- `authenticated` holding nothing but one real customer's own JWT claims:
--
--   4 order rows visible (correct — orders_select_own), and on every one of
--   them the per-SKU landed cost readable through the order-history door:
--
--     Bac Water (0.9% Benzyl Alcohol) (10mL)   $14.99 retail   $ 1.43 cost
--     GLP-1 (10mg)                             $64.99 retail   $ 4.84 cost
--     GLP-3 (10mg)                             $69.99 retail   $10.47 cost
--
-- That is the same margin structure that products-hide-cost-columns and
-- product-doses-hide-cost-columns were written to protect. Those two
-- migrations closed the catalogue door; order_items.unit_cost_cents is the
-- same number behind the order-history door, and it was left open.
--
-- Also readable on the same rows: card_processing_fee, and — where populated —
-- postage_cost_cents, shipping_profit_cents, actual_shipping_cost_cents.
--
-- And, as role `anon` presenting no credential at all, this INSERT succeeds:
--
--   insert into ambassadors (name, email, referral_code, status, commission_percent)
--   values ('...','...@...','SOMECODE','pending',10.00);
--
-- referral_code and email are both UNIQUE, so that is referral-code squatting
-- (claim a code a real ambassador is about to be given), signup blocking (claim
-- their email), and unbounded flooding of the approval queue — all without
-- touching /api/partner/apply, which is where the rate limit and the validation
-- live. (The probe first appeared to FAIL: an INSERT ... RETURNING additionally
-- needs the SELECT policy, and "No public ambassador viewing" is `qual false`.
-- Drop the RETURNING and the write goes through. Recorded because the failing
-- form of that probe is exactly how this gets mistaken for already-fixed.)
--
-- ----------------------------------------------------------------------------
-- WHY THIS BREAKS NOTHING
--
-- Every read and every write of orders and order_items in the application runs
-- server-side under service_role. That was checked exhaustively, not sampled:
-- all 59 files containing `.from("orders")` or `.from("order_items")` import
-- supabaseAdmin from @/lib/supabase-server. There are zero exceptions. The
-- customer's own order history is no exception either — account/(dashboard)/
-- orders reaches the table through lib/account-orders.ts, which is
-- supabaseAdmin. Nothing in the browser has ever read these tables.
--
-- Ten files import the browser client from @/lib/supabase. Exactly one of them
-- touches a table at all: lib/referral-client.ts, and it reads `ambassadors`.
-- Which is why ambassadors keeps its SELECT grant below.
--
-- referrals, partner_clicks and website_analytics_events are written only by
-- app/r/[code]/route.ts, app/api/analytics/track/route.ts and
-- lib/payment-webhook.ts — all three supabaseAdmin. The route's own rate limit
-- is on the route; the `*_insert_any` policies let anyone skip the route.
--
-- No table here belongs to the supabase_realtime publication, so no browser
-- subscription depends on these grants. service_role and postgres retain full
-- privileges on all six tables and are unaffected — the service-role key
-- bypasses grants and RLS alike.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- orders, order_items — RLS-01 / VL-2, RLS-04, AUTHZ-2 / VL-27
--
-- No column list is re-granted. Unlike products/product_doses, which the
-- storefront must render from the browser, there is no legitimate client-key
-- read of an order at all. Order data reaches the customer already rendered.
--
-- This also closes AUTHZ-2 at its root. orders_select_owner_or_admin lets an
-- approved ambassador read every order carrying their ambassador_id, and with
-- the blanket grant that meant customer_name, shipping_address,
-- shipping_address_2, city, postal_code, phone and the billing_* block — far
-- beyond the five columns the partner API returns. Today that exposes nothing:
-- zero orders in production currently carry a non-null ambassador_id, so the
-- policy has never had a row to leak. It would have started leaking on the
-- first attributed order. The policy is left alone; the column scope is fixed
-- with grants, which is the mechanism that can say it.
-- ----------------------------------------------------------------------------
revoke all on public.orders      from anon, authenticated;
revoke all on public.order_items from anon, authenticated;

-- ----------------------------------------------------------------------------
-- ambassadors — AUTHZ-1 / RLS-03 / VL-22
--
-- The policy has to go as well as the grant: it is the thing that says an
-- anonymous caller may write this table, and it names a commission_percent of
-- 10.00 that production no longer uses (production's default is 15 — see
-- P12-03, which is an owner decision and is NOT touched here).
--
-- Applications keep working. /api/partner/apply writes through supabaseAdmin
-- and never depended on this policy.
-- ----------------------------------------------------------------------------
drop policy if exists "Anyone can submit ambassador application" on public.ambassadors;

revoke insert, update, delete, truncate, references, trigger
  on public.ambassadors from anon, authenticated;

-- SELECT is deliberately KEPT. lib/referral-client.ts falls back to a narrow
-- browser-side read of this table when the validate_referral_code RPC is
-- missing, and it `throw`s on any error. The SELECT policy already returns the
-- anonymous caller nothing ("No public ambassador viewing" is `qual false`;
-- the two owner policies need current_auth_uid() or admin), so the grant leaks
-- no row. Revoking it would convert a silent empty result into a thrown 42501
-- on the storefront's referral-code path — a behaviour change, for no gain.

-- ----------------------------------------------------------------------------
-- referrals, partner_clicks, website_analytics_events
--   — AUTHZ-3 / RLS-02 / VL-SQL-01
--
-- `with_check (true)` on a table anon can INSERT into is an open write endpoint.
-- supabase-advisor-remaining-fixes.sql is recorded as applied and was supposed
-- to have dropped exactly these three; production kept all three. This is the
-- file that actually removes them.
--
-- The sibling *_insert_admin policies remain and require
-- current_auth_role() = 'admin', which no client key can present.
-- ----------------------------------------------------------------------------
drop policy if exists referrals_insert_any                on public.referrals;
drop policy if exists partner_clicks_insert_any           on public.partner_clicks;
drop policy if exists website_analytics_events_insert_any on public.website_analytics_events;

revoke all on public.referrals                from anon, authenticated;
revoke all on public.partner_clicks           from anon, authenticated;
revoke all on public.website_analytics_events from anon, authenticated;

commit;

-- ============================================================================
-- VERIFICATION — every row must read false / 0.
-- ============================================================================
select 'orders'                   as tbl, has_table_privilege('anon','public.orders','select')                   as anon_select, has_table_privilege('authenticated','public.orders','select')                   as auth_select
union all select 'order_items',              has_table_privilege('anon','public.order_items','select'),              has_table_privilege('authenticated','public.order_items','select')
union all select 'referrals',                has_table_privilege('anon','public.referrals','insert'),                has_table_privilege('authenticated','public.referrals','insert')
union all select 'partner_clicks',           has_table_privilege('anon','public.partner_clicks','insert'),           has_table_privilege('authenticated','public.partner_clicks','insert')
union all select 'website_analytics_events', has_table_privilege('anon','public.website_analytics_events','insert'), has_table_privilege('authenticated','public.website_analytics_events','insert')
union all select 'ambassadors(insert)',      has_table_privilege('anon','public.ambassadors','insert'),              has_table_privilege('authenticated','public.ambassadors','insert');

-- Must return 0 rows: no permissive open-write policy left anywhere in public.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and cmd in ('INSERT','UPDATE','DELETE','ALL')
  and (with_check = 'true' or qual = 'true');

-- service_role must still hold everything it had. Must return 6 rows, each
-- with all seven privileges.
select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.table_privileges
where table_schema = 'public'
  and grantee = 'service_role'
  and table_name in ('orders','order_items','ambassadors','referrals',
                     'partner_clicks','website_analytics_events')
group by table_name
order by table_name;

-- ============================================================================
-- ROLLBACK, if this ever needs undoing in a hurry. Restores the exact prior
-- state: all six tables carried `grant all` to both roles before this ran.
--
--   grant all on public.orders, public.order_items, public.ambassadors,
--                public.referrals, public.partner_clicks,
--                public.website_analytics_events
--     to anon, authenticated;
--
--   create policy "Anyone can submit ambassador application"
--     on public.ambassadors for insert to anon, authenticated
--     with check (status = 'pending' and commission_percent = 10.00);
--
--   create policy referrals_insert_any
--     on public.referrals for insert with check (true);
--   create policy partner_clicks_insert_any
--     on public.partner_clicks for insert with check (true);
--   create policy website_analytics_events_insert_any
--     on public.website_analytics_events for insert with check (true);
--
-- DELIBERATELY NOT TOUCHED here, each for its own reason:
--
--   orders_select_owner_or_admin       The row scope is the intended feature;
--                                      the column scope was the bug, and it is
--                                      fixed above. Narrowing which orders an
--                                      ambassador may see is a product
--                                      decision, not an audit fix.
--   ambassadors SELECT grant           See the note in the body.
--   commission_percent = 15 in prod    Owner decision (P12-03).
--   validate_referral_code anon EXEC   Owner decision (RLS-09).
-- ============================================================================
