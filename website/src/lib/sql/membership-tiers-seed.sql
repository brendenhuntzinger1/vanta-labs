-- ============================================================================
-- VANTA LABS — MEMBERSHIP TIERS SEED
-- Paste into: Supabase -> SQL Editor -> New query -> Run.
-- Creates/updates the 4 paid membership tiers (Vanta+, Pro, Elite, Black).
-- Safe to re-run: it upserts by slug, so running again just refreshes the copy.
-- Every perk here maps to a REAL feature (member pricing %, points multiplier,
-- free/priority shipping). Edit any of it later in Admin -> Memberships.
-- ============================================================================

insert into public.membership_tiers
  (slug, name, monthly_price_cents, annual_price_cents, points_per_dollar,
   free_shipping, priority_shipping, early_access, exclusive_pricing,
   referral_bonus_points, benefits, intro_price_cents, intro_duration_days,
   intro_offer_enabled, member_discount_percent, position, is_active)
values
  (
    'plus', 'Vanta+', 999, 9990, 2,
    true, false, false, false, 100,
    '["🏷️ 5% member pricing on every order","⭐ 2× reward points on every order","🚚 Free standard shipping, every order","🔔 Member-only restock alerts","♻️ Free reship protection"]'::jsonb,
    100, 7, true, 5, 1, true
  ),
  (
    'pro', 'Vanta Pro', 1999, 19990, 3,
    true, false, true, false, 150,
    '["🏷️ 7% member pricing on every order","⭐ 3× reward points on every order","⚡ Free 2-day shipping","🔔 Member-only restock alerts","🔒 Early access + member-only drops","♻️ Free reship protection"]'::jsonb,
    100, 7, true, 7, 2, true
  ),
  (
    'elite', 'Vanta Elite', 3999, 39990, 4,
    true, true, true, false, 250,
    '["🏷️ 9% member pricing on every order","⭐ 4× reward points on every order","⚡ Free 2-day shipping","🔔 Member-only restock alerts","🔒 Early access + member-only drops","🎧 Priority support","♻️ Free reship protection"]'::jsonb,
    100, 7, true, 9, 3, true
  ),
  (
    'black', 'Vanta Black', 9999, 99990, 5,
    true, true, true, true, 500,
    '["🏷️ 10% member pricing on every order","⭐ 5× reward points on every order","⚡ Free priority shipping + free overnight on $250+","🔒 Early access + member-only drops","🎧 Priority WhatsApp + SMS support","🌙 Concierge 1-on-1 research support","♻️ Free reship protection"]'::jsonb,
    100, 7, true, 10, 4, true
  )
on conflict (slug) do update set
  name = excluded.name,
  monthly_price_cents = excluded.monthly_price_cents,
  annual_price_cents = excluded.annual_price_cents,
  points_per_dollar = excluded.points_per_dollar,
  free_shipping = excluded.free_shipping,
  priority_shipping = excluded.priority_shipping,
  early_access = excluded.early_access,
  exclusive_pricing = excluded.exclusive_pricing,
  referral_bonus_points = excluded.referral_bonus_points,
  benefits = excluded.benefits,
  intro_price_cents = excluded.intro_price_cents,
  intro_duration_days = excluded.intro_duration_days,
  intro_offer_enabled = excluded.intro_offer_enabled,
  member_discount_percent = excluded.member_discount_percent,
  position = excluded.position,
  is_active = excluded.is_active,
  updated_at = now();
