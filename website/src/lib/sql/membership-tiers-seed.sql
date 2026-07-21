-- ============================================================================
-- VANTA LABS — MEMBERSHIP TIERS SEED (Essential / Pro / Elite / Black)
-- Paste into: Supabase -> SQL Editor -> New query -> Run. Safe to re-run.
--
-- Adds the store-credit + compare-price columns the tiers use, upserts the 4
-- paid tiers by slug, and retires any older paid tiers. The free "Research
-- Member" tier is left untouched (the app requires it for the points system).
-- Margin guardrails: each tier's store credit has a REDEEM MINIMUM order value
-- so credit is only spent on orders large enough for product margin to cover it.
-- ============================================================================

alter table if exists public.membership_tiers
  add column if not exists monthly_store_credit_cents integer not null default 0,
  add column if not exists store_credit_min_order_cents integer not null default 0,
  add column if not exists compare_monthly_price_cents integer not null default 0;

-- Retire any previously-seeded paid tiers that aren't in the new lineup.
update public.membership_tiers set is_active = false
  where slug in ('plus') and slug not in ('essential', 'pro', 'elite', 'black');

insert into public.membership_tiers
  (slug, name, monthly_price_cents, annual_price_cents, compare_monthly_price_cents,
   points_per_dollar, free_shipping, priority_shipping, early_access, exclusive_pricing,
   referral_bonus_points, benefits, monthly_store_credit_cents, store_credit_min_order_cents,
   intro_price_cents, intro_duration_days, intro_offer_enabled, member_discount_percent,
   position, is_active)
values
  (
    'essential', 'Vanta Essential', 999, 9990, 1999,
    2, false, false, true, false, 100,
    '["🏷️ 5% member discount on all products","💳 $5 monthly store credit","🔔 Early access to restocks","🎁 Members-only promotions","🚚 Free standard shipping on $250+ orders","🎂 Birthday reward","✉️ Priority email support"]'::jsonb,
    500, 5000, 100, 7, true, 5, 1, true
  ),
  (
    'pro', 'Vanta Pro', 2499, 24990, 3999,
    3, true, true, true, false, 150,
    '["🏷️ 8% member discount","💳 $15 monthly store credit","⚡ Free 2-day shipping","🔒 Early access to limited drops","🧪 Members-only products","🚀 Priority order processing","📦 Free research supply kit every 3 months","💬 Priority email & chat support"]'::jsonb,
    1500, 10000, 100, 7, true, 8, 2, true
  ),
  (
    'elite', 'Vanta Elite', 3999, 39990, 5999,
    4, true, true, true, true, 250,
    '["🏷️ 10% member discount","💳 $30 monthly store credit","📊 Exclusive bulk discounts — $500+ save 5%, $1,000+ save 12%","⚡ Free 2-day shipping on every order","🚀 Highest-priority order processing","🔒 Early access to new products","✨ Exclusive product drops","🎧 Premium customer support","🏅 VIP researcher badge"]'::jsonb,
    3000, 15000, 100, 7, true, 10, 3, true
  ),
  (
    'black', 'Vanta Black', 8999, 89990, 14999,
    5, true, true, true, true, 500,
    '["🏷️ 12% member discount","💳 $75 monthly store credit","📊 Exclusive bulk discounts — $500+ save 5%, $1,000+ save 12%","🌙 Free overnight shipping on $250+ orders","🎧 Concierge priority support","👥 Private VIP community access","✨ Exclusive limited releases","🧬 Beta product access","🚀 Highest order priority","🧑‍💼 Dedicated account manager","🎁 Surprise member gifts throughout the year"]'::jsonb,
    7500, 25000, 100, 7, true, 12, 4, true
  )
on conflict (slug) do update set
  name = excluded.name,
  monthly_price_cents = excluded.monthly_price_cents,
  annual_price_cents = excluded.annual_price_cents,
  compare_monthly_price_cents = excluded.compare_monthly_price_cents,
  points_per_dollar = excluded.points_per_dollar,
  free_shipping = excluded.free_shipping,
  priority_shipping = excluded.priority_shipping,
  early_access = excluded.early_access,
  exclusive_pricing = excluded.exclusive_pricing,
  referral_bonus_points = excluded.referral_bonus_points,
  benefits = excluded.benefits,
  monthly_store_credit_cents = excluded.monthly_store_credit_cents,
  store_credit_min_order_cents = excluded.store_credit_min_order_cents,
  intro_price_cents = excluded.intro_price_cents,
  intro_duration_days = excluded.intro_duration_days,
  intro_offer_enabled = excluded.intro_offer_enabled,
  member_discount_percent = excluded.member_discount_percent,
  position = excluded.position,
  is_active = excluded.is_active,
  updated_at = now();
