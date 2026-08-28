-- ============================================================================
-- RLS-05 — REVOKE anon/authenticated SELECT ON EVERY RLS TABLE THAT HAS NO
-- POLICIES.
--
-- APPLIED TO PRODUCTION 2026-08-28 under the owner's standing SQL
-- authorisation. Recorded here so the database and the repository carry the
-- same history.
--
-- Completes the pair started by 20260828001500_revoke_client_key_writes_all_tables.sql,
-- which closed WRITES on all 70 tables and said at :72 that SELECT was
-- deliberately left alone. This closes SELECT on the subset where it is
-- provably inert.
--
-- ----------------------------------------------------------------------------
-- WHY THIS CHANGES NO ANSWER TODAY, WHICH IS THE WHOLE POINT.
--
-- A table with RLS ENABLED and ZERO POLICIES denies every row to any role that
-- does not bypass RLS. anon and authenticated do not bypass it. So all 36 of
-- these tables already returned nothing to a holder of the publishable key; the
-- SELECT grant on them was decoration over a closed door.
--
-- Established before applying, from the live catalogue:
--
--   36 tables in public with relrowsecurity = true and zero rows in pg_policy,
--   all 36 granting SELECT to both anon and authenticated. Among them
--   email_suppressions, marketing_subscribers, order_status_history,
--   order_attribution, inventory_transactions, membership_billing_events,
--   fulfillment_payouts, system_alerts.
--
-- ----------------------------------------------------------------------------
-- WHY IT IS WORTH DOING ANYWAY.
--
-- The grant is a loaded gun pointed at a future policy. The day somebody adds
-- one narrow permissive policy for a good reason — "a customer may read their
-- own order_status_history" — the standing table-wide SELECT grant is already
-- there, and the new policy is the ONLY thing deciding what the publishable key
-- can read. RLS gates rows; GRANTs gate columns; a policy author reasoning
-- about rows does not necessarily notice they have also just published every
-- column.
--
-- After this, adding a policy is not sufficient on its own. Someone has to
-- grant SELECT deliberately, and name the columns, the way
-- products-hide-cost-columns-from-public.sql and its product_doses sibling do.
--
-- ----------------------------------------------------------------------------
-- WHY IT IS SAFE, CHECKED RATHER THAN ASSERTED.
--
--   1. Every read of these tables in the app runs through `supabaseAdmin`
--      (service_role), which both bypasses RLS and holds its own grants —
--      unaffected by a revoke aimed at anon/authenticated.
--
--   2. A source scan over the NINE files that import the browser client
--      (`@/lib/supabase`, the publishable key that ships to every visitor)
--      found ZERO `.from(...)` references to any of the 36 tables. This is the
--      same method client-key-table-access.test.ts uses, and for the same
--      reason: the local harness carries its own grants and has already drifted
--      from production, so asserting against it would prove nothing.
--
--   3. Verified on production immediately after applying:
--
--        policy-less RLS tables ....... 36
--        of which anon still has SELECT  0
--
--        www.vantalabsresearch.com/                     -> 200
--        www.vantalabsresearch.com/products             -> 200
--        www.vantalabsresearch.com/products/bpc-157     -> 200
--        www.vantalabsresearch.com/cart                 -> 200
--        www.vantalabsresearch.com/checkout             -> 200
--        www.vantalabsresearch.com/partner              -> 200
--        www.vantalabsresearch.com/membership           -> 200
--        www.vantalabsresearch.com/api/catalog/products -> 200
--                                       36 products, 36 with doses
--
-- ----------------------------------------------------------------------------
-- NOTED WHILE VERIFYING, NOT ACTED ON. Four of the 36 have NO TypeScript
-- reference at all — not server-side, not browser-side:
--
--   fulfillment_events      194 rows
--   fulfillment_orders        2 rows
--   fulfillment_payouts       2 rows
--   order_amount_backfills    3 rows
--
-- They are declared in phase2-financial-remediation.sql,
-- schema-complete-sync.sql and shipping-protection-persistence.sql and they
-- hold live production rows, so they are not dead schema — but nothing in the
-- application reads or writes them. That makes the revoke trivially safe for
-- these four, and it is worth someone deciding deliberately whether they are
-- retired, fed by a manual process, or a feature that was never wired up.
-- Recorded rather than chased: it is outside this finding.
--
-- ----------------------------------------------------------------------------
-- COMPUTED AT RUN TIME, NOT FROM A TYPED LIST. The set is derived from
-- pg_class/pg_policy at execution, so re-running this after someone has added a
-- policy to one of these tables will correctly SKIP that table rather than
-- revoking a grant its new policy may depend on. Idempotent, and safe to re-run.
-- ============================================================================

do $rls05$
declare
  t record;
  n int := 0;
begin
  for t in
    select c.oid::regclass as rel
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity
      and (select count(*) from pg_policy p where p.polrelid = c.oid) = 0
    order by c.relname
  loop
    execute format('revoke select on %s from anon, authenticated', t.rel);
    n := n + 1;
  end loop;
  raise notice 'RLS-05: revoked SELECT on % policy-less RLS tables', n;
end
$rls05$;

-- Verification. `anon_select_remaining` must be 0.
select count(*) filter (where has_table_privilege('anon', c.oid, 'SELECT')) as anon_select_remaining,
       count(*)                                                             as policyless_rls_tables
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  and (select count(*) from pg_policy p where p.polrelid = c.oid) = 0;

-- ============================================================================
-- ROLLBACK. Per table, and only with a reason — a blanket re-grant would undo
-- the point:
--
--   grant select on public.<table> to anon, authenticated;
--
-- If a future feature needs a client-side read of one of these, the correct
-- shape is a narrow policy PLUS a column-enumerated grant, following
-- products-hide-cost-columns-from-public.sql.
-- ============================================================================

-- ============================================================================
-- RLS-11 (item 2) — DROP THE DUPLICATE SELECT POLICY ON public.ambassadors.
--
-- APPLIED TO PRODUCTION 2026-08-28 in the same session, recorded here rather
-- than in its own file because it is one statement and it belongs to the same
-- RLS tidy-up.
--
-- Production carried BOTH `ambassadors_select_owner` and
-- `ambassadors_select_owner_or_admin`. Proven identical before dropping either:
--
--   polcmd        r      r        (SELECT)
--   polpermissive true   true
--   polroles      PUBLIC PUBLIC
--   md5(pg_get_expr(polqual, polrelid))
--                 98012577c5552b194677a79481226bfb   on BOTH
--
-- Two PERMISSIVE policies OR together, so two copies of one predicate are that
-- predicate. Dropping one removes no access and grants none — which is what
-- makes it safe, and also what made it invisible.
--
-- The Phase 11 repo change is the other half: partner-portal-rls.sql used to
-- re-create the `_select_owner` name, so running it after
-- partner-system-repair.sql re-introduced the duplicate. It now creates the
-- surviving `_select_owner_or_admin` name (predicate character-identical, so a
-- rename rather than a grant) and drops the old one, and either file now
-- converges on a single policy.
--
-- AFTER, verified:
--
--   No public ambassador viewing        r  false
--   ambassadors_insert_admin            a  (with-check only)
--   ambassadors_select_owner_or_admin   r  auth_user_id = current_auth_uid() OR role = 'admin'
--   ambassadors_update_admin            w  role = 'admin'
--
-- An anonymous reader still matches nothing: current_auth_uid() is null for a
-- publishable-key request, and the `false` policy contributes nothing to a
-- permissive OR either way.
--
-- ROLLBACK (it would restore an exact duplicate, so only for parity testing):
--
--   create policy "ambassadors_select_owner" on public.ambassadors for select
--     using ((auth_user_id = (select current_auth_uid()))
--            or ((select current_auth_role()) = 'admin'));
-- ============================================================================
