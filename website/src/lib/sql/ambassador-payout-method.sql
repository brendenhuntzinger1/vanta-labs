-- ============================================================================
-- VANTA LABS — AMBASSADOR PAYOUT METHOD
-- Stores each ambassador's preferred payout destination (how the business pays
-- THEM — not a customer payment method). Kept on the RLS-protected partners/
-- ambassadors tables (service-role only; anon/auth get no access). Idempotent.
--   payout_method: 'paypal' | 'venmo' | 'cashapp' (or empty until chosen)
--   payout_handle: the email / username / $cashtag for that platform
-- ============================================================================

alter table if exists public.partners
  add column if not exists payout_method text,
  add column if not exists payout_handle text,
  add column if not exists payout_updated_at timestamptz;

alter table if exists public.ambassadors
  add column if not exists payout_method text,
  add column if not exists payout_handle text,
  add column if not exists payout_updated_at timestamptz;

-- Records the method actually used for each payout, for accounting history.
alter table if exists public.partner_payouts
  add column if not exists payout_method text,
  add column if not exists payout_handle text;
alter table if exists public.payouts
  add column if not exists payout_method text,
  add column if not exists payout_handle text;
