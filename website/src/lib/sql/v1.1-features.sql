-- ============================================================================
-- v1.1 features: email retry queue, monitoring/alerts, payout reversal.
-- All additive and idempotent. Safe to run more than once. The app degrades
-- gracefully (features no-op) until this is applied.
-- ============================================================================

-- 1) EMAIL RETRY QUEUE ------------------------------------------------------
-- A transactional email (receipt/shipping) that fails to send is enqueued here
-- and retried by the cron sweep with exponential backoff.
create table if not exists public.pending_emails (
  id              uuid primary key default gen_random_uuid(),
  to_email        text not null,
  subject         text not null,
  html            text,
  text_body       text,
  reply_to        text,
  attempts        integer not null default 0,
  status          text not null default 'pending',  -- pending | sent | failed
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists pending_emails_due on public.pending_emails (status, next_attempt_at);

-- 2) MONITORING / SYSTEM ALERTS --------------------------------------------
-- Durable operational alerts (fulfillment failures, undeliverable emails, etc.).
-- Critical alerts also email the operator; this table backs an admin view.
create table if not exists public.system_alerts (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,
  severity    text not null default 'warning',      -- info | warning | critical
  message     text not null,
  context     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists system_alerts_recent on public.system_alerts (created_at desc);

-- 3) PAYOUT REVERSAL --------------------------------------------------------
-- Link each paid commission to its payout so a payout can be reversed, and stamp
-- reversed payouts (kept as immutable records) with who/when/why.
alter table public.referral_orders add column if not exists payout_id uuid;
create index if not exists referral_orders_payout_id on public.referral_orders (payout_id);

alter table public.partner_payouts add column if not exists reversed_at timestamptz;
alter table public.partner_payouts add column if not exists reversed_by text;
alter table public.partner_payouts add column if not exists reversal_reason text;

alter table public.payouts add column if not exists reversed_at timestamptz;
alter table public.payouts add column if not exists reversed_by text;
alter table public.payouts add column if not exists reversal_reason text;
