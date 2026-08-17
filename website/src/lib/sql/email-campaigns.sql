-- Campaign email system: composer, batched sender, click attribution.
--
-- Builds on what already exists rather than replacing it:
--   * consent lives in customer_preferences.marketing_emails (accounts) and
--     marketing_subscribers (guests) — this adds no third consent store;
--   * suppression stays in email_suppressions, enforced by sendMarketingEmail;
--   * every individual send is still logged to email_send_log.
--
-- What is genuinely new is the campaign itself (a composed, reusable message),
-- a per-recipient work queue so a large send can be resumed instead of
-- restarted, and click attribution so campaign revenue is measurable.
--
-- Additive and idempotent. Run once in Supabase → SQL Editor.

-- 1. The campaign -----------------------------------------------------------

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  preview_text text,
  headline text not null,
  body text not null,
  promo_code text,
  cta_label text not null default 'SHOP NOW',
  -- Stored as a site-relative path ('/products', '/products/bpc-157'). Absolute
  -- URLs are rejected at the API layer: the click redirect below will only ever
  -- send someone to this site, and keeping the stored form relative means an
  -- open redirect cannot be introduced by editing a row.
  cta_path text not null default '/products',
  segment text not null default 'all',
  -- Only meaningful when segment = 'category' (a product category) — free text
  -- so a future segment can reuse it without a migration.
  segment_param text,
  -- draft | scheduled | sending | sent | paused | failed
  status text not null default 'draft',
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  -- Snapshot of the audience size at the moment the campaign was queued. The
  -- live count is derivable from email_campaign_recipients, but the snapshot is
  -- what the admin saw when they pressed send, and that is what a history row
  -- should report.
  recipient_count integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_email_campaigns_status
  on public.email_campaigns(status, created_at desc);
-- Partial index: the scheduler only ever asks for campaigns that are due.
create index if not exists idx_email_campaigns_scheduled
  on public.email_campaigns(scheduled_at)
  where status = 'scheduled';

-- 2. The per-recipient work queue -------------------------------------------
--
-- The audience is RESOLVED ONCE, at queue time, into rows here. Two reasons,
-- both learned from the coupon broadcast this replaces:
--
--   * Resumability. The cron sweep has a hard 60-second ceiling. A serial loop
--     over the whole list gets killed partway through with no record of where
--     it stopped, so the next run either re-sends from the top or gives up.
--     With a queue, "where it stopped" is just status = 'pending'.
--   * A stable audience. Resolving the segment on every batch would mean
--     someone who orders midway through a win-back campaign silently changes
--     which segment they belong to, and either receives it twice or not at all.
--
-- The unique constraint is the idempotency guarantee: one row per recipient per
-- campaign, so re-queuing can never double-send.

create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  email text not null,
  -- pending | claiming | sent | suppressed | failed
  --
  -- 'claiming' is what makes overlapping cron runs safe. A worker moves rows
  -- pending -> claiming in a single conditional update and only sends the rows
  -- that update actually matched, so a second worker starting mid-batch finds
  -- nothing left to take. Rows stranded in 'claiming' by a crashed run are
  -- returned to 'pending' by the reaper once claimed_at is old enough.
  status text not null default 'pending',
  attempts integer not null default 0,
  claimed_at timestamptz,
  error text,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, email)
);

-- The sender's hot path: "give me the next N pending rows for this campaign".
create index if not exists idx_email_campaign_recipients_pending
  on public.email_campaign_recipients(campaign_id, status)
  where status = 'pending';
create index if not exists idx_email_campaign_recipients_email
  on public.email_campaign_recipients(email);
-- Additive for anyone who applied an earlier copy of this file. Must come
-- BEFORE the index below, which references the column.
alter table if exists public.email_campaign_recipients
  add column if not exists claimed_at timestamptz;

-- The reaper's query: rows stuck mid-claim by a killed run.
create index if not exists idx_email_campaign_recipients_claiming
  on public.email_campaign_recipients(claimed_at)
  where status = 'claiming';

-- 3. Click tracking ----------------------------------------------------------
--
-- One row per click, not a boolean, so repeat clicks are visible and the
-- click-to-order window can be reconstructed after the fact.

create table if not exists public.email_campaign_clicks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  email text not null,
  clicked_at timestamptz not null default now(),
  user_agent text,
  ip_hash text
);

create index if not exists idx_email_campaign_clicks_campaign
  on public.email_campaign_clicks(campaign_id, clicked_at desc);

-- 4. Revenue attribution -----------------------------------------------------
--
-- Denormalised onto the order deliberately. Attribution is a claim about what
-- was true AT THE TIME OF THE ORDER; recomputing it later from click history
-- would let a subsequent campaign silently rewrite the revenue credited to an
-- earlier one. Written once, at order creation, then immutable.

alter table if exists public.orders
  add column if not exists attributed_campaign_id uuid,
  add column if not exists attributed_at timestamptz;

create index if not exists idx_orders_attributed_campaign
  on public.orders(attributed_campaign_id)
  where attributed_campaign_id is not null;

-- 5. RLS ---------------------------------------------------------------------
--
-- Everything here is service-role only: campaigns are composed in the admin and
-- sent by the cron, and no browser client ever reads these tables. RLS enabled
-- with NO policies is deny-by-default for anon and authenticated.

alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;
alter table public.email_campaign_clicks enable row level security;

-- 6. Automated retention sequences -------------------------------------------
--
-- The copy lives in the DATABASE, not in code. These messages are marketing,
-- and marketing gets rewritten far more often than software gets deployed —
-- hardcoding the wording would mean a code change and a deploy every time a
-- subject line is tweaked. One row per automation, edited in the admin.
--
-- There is no per-recipient queue here, unlike campaigns: an automation's
-- audience is small (whoever crossed the threshold since the last sweep) and is
-- re-evaluated every run by design, because eligibility genuinely changes over
-- time. Duplicate suppression is handled by email_send_log instead — see
-- lib/email/automations.ts for what each one keys on.

create table if not exists public.email_automations (
  -- welcome_no_purchase | post_purchase | winback_30 | winback_60
  key text primary key,
  enabled boolean not null default false,
  -- Days after the triggering event before the message is sent.
  delay_days integer not null default 3,
  subject text not null,
  headline text not null,
  body text not null,
  promo_code text,
  cta_label text not null default 'SHOP NOW',
  cta_path text not null default '/products',
  updated_at timestamptz not null default now()
);

alter table public.email_automations enable row level security;

-- Seeded DISABLED with usable default copy, so turning one on is a decision an
-- operator makes deliberately rather than something that starts mailing
-- customers the moment the migration runs.
insert into public.email_automations (key, enabled, delay_days, subject, headline, body, cta_label, cta_path)
values
  ('welcome_no_purchase', false, 3,
   'Your Vanta Labs account is ready',
   'Everything''s set up',
   E'Thanks for creating an account with Vanta Labs.\n\nOur full catalog of research compounds is ready when you are — third-party tested, with COAs available for every batch.',
   'BROWSE THE CATALOG', '/products'),
  ('post_purchase', false, 14,
   'How''s your research going?',
   'Thanks for your order',
   E'We hope everything arrived in good order.\n\nWhen you''re ready to restock, your next order is a couple of clicks away.',
   'REORDER', '/products'),
  ('winback_30', false, 30,
   'We''ve got new arrivals',
   'It''s been a while',
   E'Your last order was a month ago, and the catalog has moved on since then.\n\nTake a look at what''s new.',
   'SHOP NOW', '/products'),
  ('winback_60', false, 60,
   'Still researching?',
   'Come back and see what''s new',
   E'It''s been a couple of months. Here''s what''s waiting whenever you need to restock.',
   'SHOP NOW', '/products')
on conflict (key) do nothing;

-- 7. Send outcome on the shared log ------------------------------------------
--
-- email_send_log records every marketing send, and it did so without recording
-- whether the send actually worked. That was harmless while the log was only
-- used to answer "has this coupon already gone to this address", but the
-- retention automations dedupe against it — so a provider hiccup would mark a
-- recipient as done and they would never receive that message again.
--
-- Defaults to 'sent' so every existing row keeps its current meaning.
alter table if exists public.email_send_log
  add column if not exists status text not null default 'sent';

create index if not exists idx_email_send_log_campaign_status
  on public.email_send_log(campaign_type, status);
