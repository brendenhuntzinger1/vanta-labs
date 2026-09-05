-- ===========================================================================
-- A TIER CHANGE AN ANNUAL MEMBER HAS NOT PAID FOR WAITS FOR THE RENEWAL.
--
-- An annual member could buy the cheapest tier and switch to the dearest one
-- minutes later: the tier change branch repriced the NEXT charge at Veyra and
-- moved the member onto the new tier's perks at once, so the upgrade was free
-- for the rest of the paid year (up to twelve months of member pricing, store
-- credit and points at a tier never paid for). Veyra's `change` endpoint takes
-- an amount and an interval; it offers no supported proration or immediate
-- difference charge, and inventing one is exactly the fragile billing logic
-- the owner ruled out.
--
-- So an annual tier change is SCHEDULED: the renewal is repriced at Veyra now,
-- the requested tier is parked in these two columns, and membership.renewed
-- (the moment the new price is actually paid) moves the member onto it.
-- Monthly members keep the immediate switch: at most one month's exposure,
-- and the very next charge is already the new price.
--
-- Additive and nullable; the code treats an absent/NULL pair as "no change
-- scheduled". DELIBERATELY NOT A FOREIGN KEY: a second FK from
-- customer_memberships to membership_tiers makes every PostgREST embed
-- `membership_tiers(*)` ambiguous (PGRST201) and took the membership sweep
-- down for one tick on 2026-09-05 before it was dropped. The code validates
-- the id against membership_tiers itself. Safe to re-run. Apply in Supabase → SQL Editor before or after
-- deploying the code that uses it (either order is safe).
-- ===========================================================================

alter table public.customer_memberships
  add column if not exists pending_tier_id uuid null,
  add column if not exists pending_tier_effective_at timestamptz null;

comment on column public.customer_memberships.pending_tier_id is
  'Tier the member has asked to move to at the next renewal (annual members). Applied by the membership.renewed webhook; NULL when nothing is scheduled.';
comment on column public.customer_memberships.pending_tier_effective_at is
  'When the scheduled tier change takes effect: the next renewal the reprice was made for.';
