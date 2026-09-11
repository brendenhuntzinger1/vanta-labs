-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- VANTA TEXTS — M1. THE SCHEMA, AND NOTHING THAT USES IT.
--
-- Every table here is additive and, at M1, unread by application code. The SMS
-- programme is built in observable stages (see docs/SMS-IMPLEMENTATION-BLUEPRINT.md
-- §B8/D4) precisely so that the day A2P registration lands is a flag flip rather
-- than a deploy.
--
-- THE ONE RULE THIS SCHEMA EXISTS TO ENFORCE: having someone's phone number is
-- not consent to market to them. The store already holds ~33 numbers collected
-- for shipping and contact, none of which carry any SMS marketing consent —
-- there is no column anywhere in this database in which such a consent could
-- have been recorded, which is exactly the point. `marketing_consent` therefore
-- defaults FALSE and is never set by anything except an explicit, evidenced
-- grant, and the M0 migration (a separate file, run only on the owner's word)
-- seeds `sms_suppressions` with every number already here.
--
-- CONSENT EVIDENCE IS NEVER DELETED. Not on rollback, not on cleanup. If this
-- programme is abandoned, these tables stay: they are the record that proves
-- what was or was not agreed to, and that record outlives the feature.
--
-- RLS posture matches the rest of `public`: enabled with no policies, so only
-- the service-role client reaches these rows. The browser's anon key makes no
-- `.from()` calls against them and holds no grants.

-- ---------------------------------------------------------------------------
-- 1. Subscribers. One row per phone number, ever.
-- ---------------------------------------------------------------------------
-- PHONE IS THE PRIMARY KEY, and that is a deliberate integrity choice rather
-- than a convenience. It makes "one number, many accounts" unrepresentable:
-- a number carries at most one user_id, so a second account cannot quietly
-- claim the same number and earn a second introductory gift.
--
-- E.164 ONLY. Normalisation happens once, at the edge (src/lib/sms/phone.ts),
-- and a number that cannot be normalised never reaches this table — it is
-- suppressed under its raw digits instead, so an unparseable number is
-- un-textable rather than un-tracked.
create table if not exists public.sms_subscribers (
  phone_e164              text primary key,
  user_id                 uuid references auth.users(id) on delete set null,

  -- pending: number submitted, not yet proven.
  -- verified: possession proven by OTP. Transactional OK. NOT marketing.
  -- opted_out: STOP, or an admin, or a hard carrier failure.
  -- blocked: terminal. Abuse. Admin only, never reached automatically.
  status                  text not null default 'pending',

  verified_at             timestamptz,
  verify_attempts         integer not null default 0,
  last_verify_at          timestamptz,

  -- THE TWO CONSENTS ARE SEPARATE BECAUSE THE LAW TREATS THEM SEPARATELY.
  -- Transactional (order, shipping, verification) and marketing are different
  -- permissions with different evidentiary requirements, and a shipping notice
  -- carrying an offer is a marketing message however it was sent.
  marketing_consent       boolean not null default false,
  marketing_consent_at    timestamptz,
  transactional_consent   boolean not null default false,
  transactional_consent_at timestamptz,

  -- Double opt-in: the reply that confirms the number's owner meant it.
  -- Carrier rules require this for abandoned-cart messaging, and the inbound
  -- message it produces is also what earns "Known Sender" status on a new
  -- number — so it is both a compliance gate and a deliverability mechanism.
  double_optin_confirmed_at timestamptz,

  consent_source          text,
  disclosure_version      text,

  opted_out_at            timestamptz,
  opt_out_keyword         text,
  resubscribed_at         timestamptz,
  resubscribe_count       integer not null default 0,

  -- From Twilio Lookup, recorded at signup. VOIP numbers are refused at the
  -- edge: they are the cheap end of verification abuse and SMS pumping fraud.
  line_type               text,
  carrier                 text,

  -- Best known timezone for quiet hours, resolved from a real signal (the
  -- shipping state on an order), NEVER inferred from the area code — number
  -- portability makes an 813 number in Seattle perfectly ordinary. NULL means
  -- "unknown", and unknown falls back to the continental-safe window.
  timezone                text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint sms_subscribers_status_check
    check (status in ('pending', 'verified', 'opted_out', 'blocked'))
);

create index if not exists idx_sms_subscribers_user on public.sms_subscribers(user_id)
  where user_id is not null;
-- The marketing audience read. Partial, because the audience is always a small
-- subset and a full-table index would be mostly dead weight.
create index if not exists idx_sms_subscribers_marketing on public.sms_subscribers(phone_e164)
  where marketing_consent = true and status = 'verified';

-- ---------------------------------------------------------------------------
-- 2. Consent events. Append only. This is the legal evidence.
-- ---------------------------------------------------------------------------
-- WHY exact_copy_shown IS A COLUMN AND NOT A VERSION POINTER. A version number
-- pointing at editable copy proves nothing eighteen months later, when the copy
-- has changed twice and the question is what THIS person agreed to. The literal
-- rendered string is stored, verbatim, at the moment it was shown.
--
-- Nothing updates or deletes a row here. The revoke is another row, not an edit.
create table if not exists public.sms_consent_events (
  id                  uuid primary key default gen_random_uuid(),
  phone_e164          text not null,
  event               text not null,
  disclosure_version  text,
  exact_copy_shown    text,
  ip                  text,
  user_agent          text,
  source_url          text,
  user_id             uuid,
  twilio_message_sid  text,
  detail              jsonb,
  created_at          timestamptz not null default now(),

  constraint sms_consent_events_event_check check (event in (
    'disclosure_shown', 'verify_sent', 'verified',
    'marketing_granted', 'marketing_revoked',
    'transactional_granted', 'transactional_revoked',
    'double_optin_confirmed', 'resubscribed',
    'suppressed_by_migration', 'blocked_by_admin'
  ))
);

create index if not exists idx_sms_consent_events_phone
  on public.sms_consent_events(phone_e164, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Suppression. The layer that actually holds.
-- ---------------------------------------------------------------------------
-- SCOPE EXISTS BECAUSE THE PROGRAMME USES TWO NUMBERS. Twilio's own STOP is
-- per (sender number, recipient), so a STOP to the marketing number does not
-- and must not silence order notifications from the transactional number.
-- 'marketing' suppresses solicitation only; 'all' suppresses everything.
--
-- `phone_raw` carries numbers that could not be normalised to E.164. A number
-- we cannot parse is a number we cannot prove we suppressed, so it is recorded
-- under its digits and flagged for review rather than dropped.
create table if not exists public.sms_suppressions (
  phone_e164    text primary key,
  scope         text not null default 'marketing',
  reason        text,
  phone_raw     text,
  needs_review  boolean not null default false,
  created_at    timestamptz not null default now(),

  constraint sms_suppressions_scope_check check (scope in ('marketing', 'all'))
);

create index if not exists idx_sms_suppressions_review on public.sms_suppressions(created_at desc)
  where needs_review = true;

-- ---------------------------------------------------------------------------
-- 4. Send ledger. Mirrors email_send_log column-for-column on purpose.
-- ---------------------------------------------------------------------------
-- The shared cross-channel frequency cap (M3) reads both ledgers as one view of
-- "what has this person been sent". Keeping the shapes identical is what lets
-- that view be a union rather than a translation layer.
create table if not exists public.sms_send_log (
  id                  uuid primary key default gen_random_uuid(),
  campaign_type       text not null,
  reference_id        text,
  phone_e164          text not null,
  template_key        text not null,
  sent_at             timestamptz not null default now(),
  status              text not null default 'sending',
  twilio_message_sid  text,
  segments            integer,
  price_cents         integer,
  delivered_at        timestamptz,
  failed_at           timestamptz,
  error_code          text,
  clicked_at          timestamptz
);

-- The exact join to the provider's delivery webhook, and the idempotency key
-- for it. Partial: a row is created before Twilio answers, so the SID is null
-- for a moment and a full unique index would reject the second such row.
create unique index if not exists idx_sms_send_log_sid
  on public.sms_send_log(twilio_message_sid) where twilio_message_sid is not null;
create index if not exists idx_sms_send_log_phone on public.sms_send_log(phone_e164, sent_at desc);
create index if not exists idx_sms_send_log_reference on public.sms_send_log(campaign_type, reference_id);

-- ---------------------------------------------------------------------------
-- 5. Delivery events + click tracking.
-- ---------------------------------------------------------------------------
create table if not exists public.sms_delivery_events (
  id                  uuid primary key default gen_random_uuid(),
  twilio_message_sid  text not null,
  status              text not null,
  error_code          text,
  raw                 jsonb,
  received_at         timestamptz not null default now()
);

-- Twilio redelivers a status callback on any non-2xx, so the same (sid, status)
-- arrives more than once as a matter of course rather than as an anomaly.
create unique index if not exists idx_sms_delivery_events_unique
  on public.sms_delivery_events(twilio_message_sid, status);

-- FIRST-PARTY LINKS ONLY. A public URL shortener is a named A2P campaign
-- rejection reason (Twilio error 30963), so every link in an SMS is served
-- from a domain this store owns.
create table if not exists public.sms_link_clicks (
  id              uuid primary key default gen_random_uuid(),
  sms_send_log_id uuid references public.sms_send_log(id) on delete set null,
  phone_e164      text,
  path            text,
  clicked_at      timestamptz not null default now(),
  user_agent      text
);

create index if not exists idx_sms_link_clicks_send on public.sms_link_clicks(sms_send_log_id);

-- ---------------------------------------------------------------------------
-- 6. Existing tables: additive, nullable columns only.
-- ---------------------------------------------------------------------------

-- ONE REQUEST ROW, TWO CHANNELS. A parallel SMS table would notify the same
-- person twice for the same restock; the existing partial unique index on
-- (product_slug, variant_id, email) where notified = false stays correct and
-- unchanged.
alter table if exists public.back_in_stock_requests
  add column if not exists phone_e164 text,
  add column if not exists notify_sms boolean not null default false;

-- Attribution and audit. Both write-once, both nullable.
alter table if exists public.orders
  add column if not exists sms_attributed_send_id uuid,
  add column if not exists sms_benefit_cost_cents integer;

-- COMMISSION AUDIT (blueprint §C3). Written from M7 onward; null before that.
--
-- `commission_amount` deliberately keeps its existing meaning — the amount
-- actually payable — so every payout read, the partner portal and the payout
-- runs continue to work untouched. The new columns explain it rather than
-- replace it, because an ambassador seeing a number lower than they expected
-- needs the reason in the same row.
alter table if exists public.referral_orders
  add column if not exists commissionable_base            numeric(12,2),
  add column if not exists commission_calculated          numeric(12,2),
  add column if not exists commission_capped_amount       numeric(12,2) not null default 0,
  add column if not exists commission_cap_reason          text,
  add column if not exists contribution_before_commission numeric(12,2);

-- ---------------------------------------------------------------------------
-- 7. RLS — enabled, no policies. Service-role only, like every other table.
-- ---------------------------------------------------------------------------
alter table public.sms_subscribers      enable row level security;
alter table public.sms_consent_events   enable row level security;
alter table public.sms_suppressions     enable row level security;
alter table public.sms_send_log         enable row level security;
alter table public.sms_delivery_events  enable row level security;
alter table public.sms_link_clicks      enable row level security;

revoke all on public.sms_subscribers,
              public.sms_consent_events,
              public.sms_suppressions,
              public.sms_send_log,
              public.sms_delivery_events,
              public.sms_link_clicks
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Consent events are append-only, enforced by the database.
-- ---------------------------------------------------------------------------
-- A convention that "nothing updates this table" is a convention until someone
-- writes the UPDATE. The service-role client bypasses RLS, so the guarantee has
-- to live somewhere RLS cannot be bypassed: a trigger.
create or replace function public.sms_consent_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'sms_consent_events is append-only (attempted %)', tg_op;
end;
$$;

drop trigger if exists sms_consent_events_no_update on public.sms_consent_events;
create trigger sms_consent_events_no_update
  before update or delete on public.sms_consent_events
  for each row execute function public.sms_consent_events_append_only();
