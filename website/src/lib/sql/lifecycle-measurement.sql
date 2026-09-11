-- ---------------------------------------------------------------------------
-- MEASURING THE LIFECYCLE THE WAY THE MONEY IS MADE.
--
-- Additive only. Nothing running reads or writes these before the code that
-- ships with them, so applying this migration changes no behaviour on its own.
--
-- WHY. The programme reported sent / opened / clicked per channel, and the
-- first-touch columns it used (opened_at, clicked_at) could not say WHAT
-- fetched the pixel or followed the link. On 2026-09-11, five of fifteen
-- "opens" on real recovery sends were stamped within forty seconds of the
-- send — image prefetch and link scanners, not people — and no report could
-- tell them from a read. A funnel judged on that flatters itself.
--
-- `email_engagement_events` keeps EVERY open and click, with the user agent
-- that produced it, append-only. Classification (human, prefetch, scanner)
-- happens at read time in engagement-classification.ts, so the rule can be
-- tightened later without losing history. The first-touch columns keep
-- working exactly as before; this is the source of truth beside them.
--
-- `abandoned_cart_emails.experiment` names the axis a send's `variant`
-- belonged to. The variant column has carried one subject-line test so far;
-- the next test varies the sender name, and a report that pooled the two
-- would describe an experience nobody had.
-- ---------------------------------------------------------------------------

create table if not exists public.email_engagement_events (
  id uuid primary key default gen_random_uuid(),
  -- The same identity email_send_log uses, so one join answers every channel.
  campaign_type text not null,
  reference_id text,
  recipient_email text,
  kind text not null check (kind in ('opened', 'clicked')),
  -- pixel: our image; click: our redirect; provider: the sender's webhook.
  source text not null check (source in ('pixel', 'click', 'provider')),
  at timestamptz not null default now(),
  user_agent text,
  created_at timestamptz not null default now()
);

comment on table public.email_engagement_events is
  'Every open and click the system hears about, with what fetched it. Append-only; '
  'classified at read time. The first-touch columns on email_send_log and the '
  'per-channel tables stay as they were.';

create index if not exists email_engagement_events_send_idx
  on public.email_engagement_events (campaign_type, reference_id);

create index if not exists email_engagement_events_at_idx
  on public.email_engagement_events (at);

-- Deny-all, like every table beside it: RLS on, no policies, service role only.
alter table public.email_engagement_events enable row level security;

alter table if exists public.abandoned_cart_emails
  add column if not exists experiment text;

comment on column public.abandoned_cart_emails.experiment is
  'Which experiment this send''s variant belonged to, e.g. "subject-2026-09" or '
  '"sender-name-2026-09". Null for sends before the column existed, which were '
  'all the subject-line test. Reports group by (experiment, variant), never by '
  'variant alone.';
