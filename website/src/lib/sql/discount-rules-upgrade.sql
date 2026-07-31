-- ============================================================================
-- VANTA LABS — DISCOUNT RULES UPGRADE
-- 1) Coupon audience scoping: a code can be limited to active members only
--    ('members'), to non-members only ('non_members'), or open to everyone
--    ('all', the default — matches all existing coupons).
-- Safe to re-run. Supabase -> SQL Editor -> paste -> Run.
--
-- Note: no schema change is needed for the "bundle stacking" admin toggle —
-- it lives in the promotions control section (admin_audit_logs-backed
-- settings) like the other promotion switches, default OFF (no stacking).
-- ============================================================================

alter table public.coupons
  add column if not exists member_scope text not null default 'all';

alter table public.coupons
  drop constraint if exists coupons_member_scope_check;

alter table public.coupons
  add constraint coupons_member_scope_check
  check (member_scope in ('all', 'members', 'non_members'));
