-- Affiliate broadcasts: an affiliate audience and per-affiliate personalisation
-- for the campaign system that already exists.
--
-- THIS FILE ADDS COLUMNS. IT CREATES NO TABLES AND CHANGES NO EXISTING
-- BEHAVIOUR. email-campaigns.sql already owns the queue, the claim protocol,
-- the reaper, click/open tracking, and the unique constraint that makes a
-- double-send impossible. A second mailer beside it would mean a second
-- suppression check and a second unsubscribe path — the two things that must
-- never drift apart. So affiliate campaigns are rows in the SAME tables,
-- carrying a flag that says which audience they address.
--
-- Every column below is additive with a default, so every campaign that already
-- exists keeps exactly its current meaning and the customer composer needs no
-- change at all.
--
-- Idempotent. Run once in Supabase -> SQL Editor.

-- 1. Which audience a campaign addresses -------------------------------------
--
-- Defaulted to 'customer'. This column is what keeps the two audiences from ever
-- being resolved by the wrong code path: a customer campaign resolves consent
-- from customer_preferences / marketing_subscribers, an affiliate campaign
-- resolves from the ambassadors table. Nothing infers the audience from the
-- segment, and nothing has to.

alter table if exists public.email_campaigns
  add column if not exists audience_kind text not null default 'customer',
  -- all_active | selected | no_sales | has_sales.
  -- Only meaningful when audience_kind = 'affiliate'.
  add column if not exists affiliate_filter text,
  -- The hand-picked set. Null/empty when the filter is not 'selected'.
  add column if not exists affiliate_ids uuid[],
  -- Extra buttons beyond the primary CTA the campaign already has:
  -- [{"label": "Marketing images", "url": "https://..."}]
  --
  -- Affiliates need resources — product pages, sale pages, image folders, video.
  -- A jsonb array rather than a side table because these are content of one
  -- message, edited and versioned with it, never queried across campaigns.
  add column if not exists link_buttons jsonb;

-- The affiliate history reads only affiliate campaigns; the customer dashboard
-- reads only customer ones. Both are "newest first within a kind".
create index if not exists idx_email_campaigns_audience_kind
  on public.email_campaigns(audience_kind, created_at desc);

-- 2. Per-recipient personalisation -------------------------------------------
--
-- merge_context IS A SNAPSHOT, TAKEN ONCE AT QUEUE TIME, AND THAT IS THE WHOLE
-- REASON IT IS STORED RATHER THAN LOOKED UP.
--
-- A campaign can say "you earn {{commission_percent}}%". Resolving that per
-- batch instead would mean an affiliate whose rate changed mid-send receives a
-- different claim about their own money than the one the owner previewed and
-- approved — and on a large list, which affiliate got which version would depend
-- on batch timing. It is the same argument the recipient queue itself rests on:
-- the audience is resolved once so it cannot shift underneath a send already in
-- progress.
--
-- It also turns one database lookup per recipient into one read per campaign.
alter table if exists public.email_campaign_recipients
  add column if not exists ambassador_id uuid,
  add column if not exists merge_context jsonb;

create index if not exists idx_email_campaign_recipients_ambassador
  on public.email_campaign_recipients(ambassador_id)
  where ambassador_id is not null;

-- 3. Per-link click attribution ----------------------------------------------
--
-- email_campaign_clicks records that a campaign was clicked. With several
-- buttons in one affiliate email, "which link" is the question worth answering,
-- so the click row gains an index into the campaign's buttons.
--
-- Null means the primary CTA — which is exactly what every existing row means,
-- so no backfill is needed and older campaigns keep reporting correctly.
alter table if exists public.email_campaign_clicks
  add column if not exists link_index integer,
  add column if not exists link_label text;

create index if not exists idx_email_campaign_clicks_link
  on public.email_campaign_clicks(campaign_id, link_index);
