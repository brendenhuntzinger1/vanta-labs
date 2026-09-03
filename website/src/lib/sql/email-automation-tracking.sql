-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- CLICK AND REVENUE TRACKING FOR THE RETENTION AUTOMATIONS.
--
-- Campaigns have had click attribution since email-campaigns.sql: a signed
-- redirect through /api/email/click, one row per click in
-- email_campaign_clicks, and orders.attributed_campaign_id stamped from a
-- cookie the redirect sets. Automations had none of it. automations.ts said so
-- in a comment and linked customers straight to the destination, because the
-- campaign scheme is keyed on a campaign UUID and an automation's identity is
-- a text key like 'winback_30'.
--
-- The consequence was not a missing chart. All four retention automations are
-- enabled and mailing customers, and there was NO WAY AT ALL to tell whether
-- anyone clicked them — not a click count, not a conversion, not a dollar. The
-- one part of the email system running unattended was the one part nobody
-- could measure.
--
-- WHY NOT REUSE THE CAMPAIGN TABLES. Three hard blockers, each of which would
-- have failed silently rather than loudly:
--
--   * email_campaign_clicks.campaign_id is `uuid not null references
--     email_campaigns(id)`. Inserting 'winback_30' fails on both the cast and
--     the foreign key.
--   * The click route looks the campaign row up with `.eq("id", campaignId)`.
--     A non-uuid makes PostgREST raise 22P02, the route reads `data` as null,
--     and it redirects to /products recording nothing — a link that works and
--     reports zero, which is the worst failure shape available.
--   * orders.attributed_campaign_id is a uuid. Automation revenue needs its
--     own column, not a widened one, if that column is to stay honest.
--
-- The alternative considered and rejected was a "shadow campaign" row per
-- automation. It fails on drift: the automation's copy and cta_path live in
-- email_automations and are edited there, so the two cta_paths diverge and the
-- customer silently lands somewhere the operator did not choose. It also makes
-- one (campaign, email) signature eternal — a link minted in January still
-- verifies in December, and every send of that automation collapses into one
-- bucket with no per-send cohort.
--
-- So automations get their own small surface, sharing the parts that carry
-- correctness (the HMAC scheme, the same-origin destination resolution) and
-- nothing that would corrupt campaign reporting.

-- 1. Clicks -----------------------------------------------------------------
--
-- One row per click, not per clicker. Unique clicks are counted from
-- email_send_log.clicked_at (see section 3), which is first-touch by
-- construction; this table keeps the raw stream so a "clicked three times over
-- two days" pattern stays visible.
create table if not exists public.email_automation_clicks (
  id uuid primary key default gen_random_uuid(),
  -- 'welcome_no_purchase' | 'post_purchase' | 'winback_30' | 'winback_60'.
  -- Deliberately NOT a foreign key to email_automations: deleting an
  -- automation row must not delete the evidence of what it earned.
  automation_key text not null,
  -- The send this click belongs to, matching email_send_log.reference_id — an
  -- address for the welcome sequence, an order id for post-purchase, and
  -- `${email}:${lastOrderAt}` for a win-back episode. This is what gives each
  -- send its own cohort: a customer won back twice produces two references and
  -- two separately measurable episodes, where a campaign-style scheme would
  -- merge them forever.
  reference_id text not null,
  email text not null,
  clicked_at timestamptz not null default now(),
  user_agent text,
  -- Hashed, never raw. Same treatment as email_campaign_clicks.
  ip_hash text
);

comment on table public.email_automation_clicks is
  'One row per click on a retention automation CTA. Written by /api/email/automation-click after HMAC verification.';

-- The report reads "clicks for this automation, newest first".
create index if not exists email_automation_clicks_key_idx
  on public.email_automation_clicks (automation_key, clicked_at desc);
-- And "did this particular send get clicked", for per-episode drill-down.
create index if not exists email_automation_clicks_reference_idx
  on public.email_automation_clicks (automation_key, reference_id);

revoke all on public.email_automation_clicks from public, anon, authenticated;
grant select, insert, update, delete on public.email_automation_clicks to service_role;
-- Service-role-only operational table: RLS on, no policies, so a leaked anon
-- key reaches nothing here even if a grant is added by mistake later.
alter table public.email_automation_clicks enable row level security;

-- 2. Revenue ----------------------------------------------------------------
--
-- The mirror of orders.attributed_campaign_id, kept separate rather than
-- overloaded. Text, because an automation key is text; nullable, because most
-- orders have no automation behind them.
alter table if exists public.orders
  add column if not exists attributed_automation_key text;
alter table if exists public.orders
  add column if not exists attributed_automation_at timestamptz;

comment on column public.orders.attributed_automation_key is
  'Retention automation whose CTA click preceded this order, inside the 7-day window. Written once, at order creation, and never moved.';

-- Partial: the overwhelming majority of orders have no automation attribution,
-- and the only query is "orders belonging to automation X".
create index if not exists orders_attributed_automation_idx
  on public.orders (attributed_automation_key)
  where attributed_automation_key is not null;

-- 3. Per-send open and click state -----------------------------------------
--
-- email_send_log has carried `opened_at` and `clicked_at` since
-- membership-billing.sql and NOTHING HAS EVER WRITTEN TO EITHER. They are the
-- natural home for automation first-touch state: the log already has exactly
-- one row per (campaign_type, reference_id), enforced by the partial unique
-- index in automation-send-once.sql, so "was this send opened" and "was this
-- send clicked" have somewhere to live without inventing a recipients table
-- for a sequence that deliberately has no queue.
--
-- No column is added here. This index is: the automation report groups by
-- campaign_type ('automation:<key>') and needs sends, deliveries and opens
-- per key without a sequential scan of every marketing send ever made.
create index if not exists email_send_log_campaign_type_idx
  on public.email_send_log (campaign_type, sent_at desc);

-- 4. Joining a send to its delivery event ----------------------------------
--
-- email_delivery_events records what the provider's webhook said — delivered,
-- bounced, complained — keyed by `provider_message_id`. email_send_log records
-- what we sent. NOTHING JOINED THE TWO, because the send log never kept the id
-- the provider handed back, even though EmailSendResult has carried
-- `providerMessageId` all along and resend.ts explicitly reads it.
--
-- Without this column a per-automation delivery rate can only be guessed at by
-- matching recipient address and timestamp, which double-counts the moment one
-- person is in two sequences. With it the join is exact.
--
-- Nullable, and must stay so: SMTP returns no id, and a send that succeeded
-- without one is still a send.
alter table if exists public.email_send_log
  add column if not exists provider_message_id text;

comment on column public.email_send_log.provider_message_id is
  'Provider''s own id for the message, when it returns one. Joins this row to email_delivery_events.provider_message_id.';

create index if not exists email_send_log_provider_message_id_idx
  on public.email_send_log (provider_message_id)
  where provider_message_id is not null;
