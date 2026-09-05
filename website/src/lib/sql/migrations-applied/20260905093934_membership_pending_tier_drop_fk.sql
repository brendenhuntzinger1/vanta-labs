-- ============================================================================
-- VANTA LABS — DROP THE SECOND FK FROM customer_memberships TO membership_tiers
--
-- APPLIED TO PRODUCTION 2026-09-05 09:39 UTC via the Supabase migration API
-- (migration name `membership_pending_tier_drop_fk`).
--
-- WHY. membership_pending_tier_change (09:27 UTC) added pending_tier_id WITH a
-- foreign key to membership_tiers. That made two relationships between the two
-- tables, so every PostgREST embed `membership_tiers(*)` from
-- customer_memberships answered PGRST201 ("more than one relationship") — the
-- 09:30 UTC sweep tick failed membership_billing and store_credit, and
-- getCustomerMembership / member pricing would have failed for the twelve
-- minutes the constraint existed. No orders were placed in that window.
-- The column stays; the code validates the id itself.
-- ============================================================================

alter table public.customer_memberships
  drop constraint if exists customer_memberships_pending_tier_id_fkey;
