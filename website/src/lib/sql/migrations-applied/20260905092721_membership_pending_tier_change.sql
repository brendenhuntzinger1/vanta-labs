-- ============================================================================
-- VANTA LABS — A TIER CHANGE WAITS FOR THE RENEWAL THAT PAYS FOR IT
--
-- APPLIED TO PRODUCTION 2026-09-05 09:27 UTC via the Supabase migration API
-- (migration name `membership_pending_tier_change`), as part of the
-- launch-audit closeout. Additive: two nullable columns. Safe to re-run.
--
-- Source of truth: ../membership-pending-tier-change.sql (this file is the
-- record of what ran; edit that one). The local harness applies it from
-- scripts/setup-local-harness.sh's post-parity list.
--
-- WHY. A monthly member could pay for the cheapest tier, upgrade at once and
-- hold the dearest tier's perks until the next charge, then downgrade before
-- it — every cycle. Veyra's `change` offers no proration, so an UPGRADE is
-- now repriced at Veyra and parked here; membership.renewed (the first charge
-- at the new price) moves the member onto it. Annual passes never renew and
-- are refused a change while paid up. The code treats NULL as "nothing
-- scheduled", so deploying before or after this migration is equally safe.
-- ============================================================================

alter table public.customer_memberships
  add column if not exists pending_tier_id uuid null,
  add column if not exists pending_tier_effective_at timestamptz null;

comment on column public.customer_memberships.pending_tier_id is
  'Tier the member has asked to move to at the next renewal (monthly upgrades). Applied by the membership.renewed webhook; NULL when nothing is scheduled.';
comment on column public.customer_memberships.pending_tier_effective_at is
  'When the scheduled tier change takes effect: the next renewal the reprice was made for.';
