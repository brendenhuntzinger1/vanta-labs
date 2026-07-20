-- Phase 4 admin dashboard: role-based permissions + partial refund tracking.
--
-- Run after partner-system-repair.sql. Idempotent - safe to rerun.

-- Roles: "staff" (default, day-to-day operations), "manager" (+ refunds,
-- coupons, inventory), "super_admin" (+ team management, role changes).
-- src/lib/admin-roles.ts is the single source of truth for what each role
-- can do; this column only stores the value.
alter table if exists public.admin_credentials
  add column if not exists role text not null default 'staff';

alter table public.admin_credentials
  drop constraint if exists admin_credentials_role_check;

alter table public.admin_credentials
  add constraint admin_credentials_role_check
  check (role in ('staff', 'manager', 'super_admin'));

-- Partial refund tracking. `refund_amount` accumulates across multiple
-- partial refunds; `refunded_at` is the timestamp of the most recent one.
-- payment_status moves to 'partially_refunded' or 'refunded' depending on
-- whether refund_amount has reached amount_paid (see src/lib/admin-refunds.ts).
alter table if exists public.orders
  add column if not exists refund_amount numeric(12,2) not null default 0,
  add column if not exists refunded_at timestamptz;

create index if not exists idx_admin_credentials_role on public.admin_credentials(role);
