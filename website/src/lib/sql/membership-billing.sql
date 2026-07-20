-- Real recurring-billing membership engine + bulk-savings program.
--
-- IMPORTANT: this schema and all the application code built on top of it
-- (src/lib/billing-provider.ts, src/lib/membership-billing.ts) are fully
-- functional - dates, state transitions, emails, and admin analytics are
-- all real. The ONE thing that isn't real yet is the actual card charge:
-- src/lib/billing-provider.ts defaults to a "Noop" provider that always
-- reports the charge as failed (never fakes success) until real payment
-- processor credentials are added via BILLING_PROVIDER / the matching env
-- vars. Every "failed payment" you see until then is expected and honest -
-- it means no processor is connected, not that something is broken.
--
-- Run after membership-rewards.sql and coupon-checkout-columns.sql.
-- Idempotent - safe to re-run.

-- 1. Tier pricing + intro-offer + member-discount configuration -------------

-- +$10/month on the two paid tiers (free tier is untouched - $0 stays $0).
update public.membership_tiers
set monthly_price_cents = monthly_price_cents + 1000,
    updated_at = now()
where slug in ('plus', 'elite')
  and monthly_price_cents > 0;

alter table if exists public.membership_tiers
  add column if not exists intro_price_cents integer not null default 100,
  add column if not exists intro_duration_days integer not null default 7,
  add column if not exists intro_offer_enabled boolean not null default true,
  add column if not exists member_discount_percent numeric(5,2) not null default 0;

-- 2. Real subscription state on customer_memberships ------------------------

-- status keeps using its existing free-text column - now including
-- "trialing" (intro period active, before the first real charge) and
-- "past_due" (a renewal/remainder charge failed and is awaiting retry) in
-- addition to the pre-existing active/paused/cancelled values.
alter table if exists public.customer_memberships
  add column if not exists intro_status text not null default 'not_applicable',
  add column if not exists intro_started_at timestamptz,
  add column if not exists intro_ends_at timestamptz,
  add column if not exists intro_charge_amount_cents integer,
  add column if not exists first_month_remainder_cents integer,
  add column if not exists next_billing_at timestamptz,
  add column if not exists next_billing_amount_cents integer,
  add column if not exists payment_method_ref text,
  add column if not exists billing_provider_customer_id text,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists first_month_reminder_sent_at timestamptz,
  add column if not exists renewal_reminder_sent_at timestamptz;

create index if not exists idx_customer_memberships_next_billing_at
  on public.customer_memberships(next_billing_at)
  where next_billing_at is not null;

create index if not exists idx_customer_memberships_intro_ends_at
  on public.customer_memberships(intro_ends_at)
  where intro_status = 'active';

-- 3. Append-only billing event ledger - the source of truth for every admin
--    billing metric (conversion rate, recurring revenue, churn, failed
--    payments, recovery attempts), rather than projecting them from
--    current-state columns. ---------------------------------------------

create table if not exists public.membership_billing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tier_id uuid references public.membership_tiers(id),
  event_type text not null, -- intro_charge | first_month_remainder | renewal | payment_failed | cancellation
  amount_cents integer not null default 0,
  status text not null, -- succeeded | failed
  provider_charge_id text,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_membership_billing_events_user_id
  on public.membership_billing_events(user_id, created_at desc);
create index if not exists idx_membership_billing_events_type
  on public.membership_billing_events(event_type, created_at desc);

-- 4. Email compliance + delivery tracking (shared by membership campaign
--    emails and the abandoned-cart-recovery system in
--    abandoned-cart-recovery.sql). --------------------------------------

create table if not exists public.email_suppressions (
  email text primary key,
  reason text not null default 'unsubscribed',
  created_at timestamptz not null default now()
);

create table if not exists public.email_send_log (
  id uuid primary key default gen_random_uuid(),
  campaign_type text not null, -- membership_welcome | membership_trial_confirmation | ... | cart_recovery_t30m | ...
  reference_id text, -- e.g. user_id or abandoned_cart id, free text so both subsystems can use it
  recipient_email text not null,
  template_key text not null,
  sent_at timestamptz not null default now(),
  opened_at timestamptz,
  clicked_at timestamptz
);

create index if not exists idx_email_send_log_reference on public.email_send_log(reference_id);
create index if not exists idx_email_send_log_campaign_type on public.email_send_log(campaign_type, sent_at desc);
create index if not exists idx_email_send_log_recipient on public.email_send_log(recipient_email);

-- 5. Per-recipient, single-use coupon support (needed for cart-recovery
--    coupons; also usable for any future targeted offer). -----------------

alter table if exists public.coupons
  add column if not exists assigned_email text,
  add column if not exists source text;

create index if not exists idx_coupons_assigned_email on public.coupons(assigned_email) where assigned_email is not null;

-- 6. Elite bulk-savings program tracking on orders, and a priority-order
--    flag (tiers with priority_shipping=true, active/trialing member). ----

alter table if exists public.orders
  add column if not exists bulk_discount_tier text, -- '5_percent' | '12_percent'
  add column if not exists bulk_discount_amount numeric(12,2) not null default 0,
  add column if not exists priority boolean not null default false;

create index if not exists idx_orders_bulk_discount_tier on public.orders(bulk_discount_tier) where bulk_discount_tier is not null;
create index if not exists idx_orders_priority on public.orders(priority) where priority = true;

-- 7. RLS ---------------------------------------------------------------------

alter table public.membership_billing_events enable row level security;
alter table public.email_suppressions enable row level security;
alter table public.email_send_log enable row level security;

-- No anon/authenticated policies on any of the three tables above -
-- everything is written and read by server code using the service-role
-- client (src/lib/membership-billing.ts, src/lib/email/marketing.ts,
-- src/lib/cart-recovery.ts), same pattern as points_ledger's writes.
-- /api/unsubscribe is the one public-facing write path, and it also goes
-- through the service-role client rather than a client-side insert policy.
