-- ============================================================================
-- VANTA LABS — fix coupons so they actually validate + apply.
-- Root cause: validateCoupon() reads `assigned_email` and cart-recovery writes
-- `source`, but some schema builds created public.coupons without those
-- columns — so the validation query errored on EVERY code ("didn't work").
-- This adds the missing columns (idempotent) and then shows each coupon's real
-- usable state. Supabase -> SQL Editor -> paste -> Run.
-- ============================================================================

alter table public.coupons
  add column if not exists assigned_email text,
  add column if not exists source text;

create index if not exists idx_coupons_assigned_email
  on public.coupons(assigned_email) where assigned_email is not null;

-- Diagnostic: every coupon + why it would/wouldn't apply right now.
select
  code,
  discount_type,
  discount_value,
  active,
  starts_at,
  ends_at,
  max_redemptions,
  redemptions_count,
  case
    when active is not true then 'DISABLED — flip it on'
    when starts_at is not null and starts_at > now() then 'SCHEDULED — not started yet'
    when ends_at is not null and ends_at < now() then 'EXPIRED — past end date'
    when max_redemptions is not null and redemptions_count >= max_redemptions then 'LIMIT REACHED'
    else 'ACTIVE — should apply at checkout'
  end as effective_status
from public.coupons
order by created_at desc;
