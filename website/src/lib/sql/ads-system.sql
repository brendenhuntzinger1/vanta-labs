-- =============================================================================
-- VANTA ADS — advertising operating system schema
--
-- NOT YET APPLIED. Review before running. Every statement is additive and
-- guarded with IF NOT EXISTS; nothing here alters, drops or reads a commerce
-- table. The ad system observes commerce and never participates in it.
--
-- The one join that matters: utm_content == creative_id. It is stamped on the
-- landing URL at publish time, captured by the existing attribution layer, and
-- lands on order_attribution.first_utm_content / last_utm_content. Every
-- per-creative number in the dashboard resolves through that single column.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Reference intelligence
-- -----------------------------------------------------------------------------

create table if not exists public.ad_reference_creatives (
  reference_id      text primary key,
  added_at          timestamptz not null default now(),
  platform          text not null default 'other',
  source_kind       text not null default 'url',
  source_url        text,
  company           text,
  asset_paths       text[] not null default '{}',
  owner_note        text,
  caption_text      text,
  -- Observed characteristics live in one jsonb rather than thirty columns: the
  -- list of things worth noticing about an ad will keep growing, and a schema
  -- migration per observation would guarantee the analysis stops happening.
  observed          jsonb not null default '{}'::jsonb,
  why_it_may_work   text,
  do_not_copy       text[] not null default '{}',
  compliance_flags  text[] not null default '{}',
  updated_at        timestamptz not null default now()
);

create index if not exists ad_reference_creatives_platform_idx on public.ad_reference_creatives (platform);
create index if not exists ad_reference_creatives_company_idx on public.ad_reference_creatives (company);
create index if not exists ad_reference_creatives_observed_idx on public.ad_reference_creatives using gin (observed);

create table if not exists public.ad_owner_taste_signals (
  signal_id     bigserial primary key,
  reference_id  text references public.ad_reference_creatives (reference_id) on delete cascade,
  dimension     text not null,
  sentiment     text not null check (sentiment in ('love','like','dislike','hate')),
  note          text not null,
  recorded_at   timestamptz not null default now()
);

create index if not exists ad_owner_taste_signals_dimension_idx on public.ad_owner_taste_signals (dimension, sentiment);

create table if not exists public.ad_patterns (
  pattern_id        text primary key,
  name              text not null,
  dimension         text not null,
  principle         text not null,
  mechanism         text,
  eligibility_risk  text not null default 'medium',
  created_at        timestamptz not null default now()
);

-- Many-to-many, so "how many independent ads show this pattern" is a count
-- rather than an array length nobody can index.
create table if not exists public.ad_pattern_observations (
  pattern_id    text not null references public.ad_patterns (pattern_id) on delete cascade,
  reference_id  text not null references public.ad_reference_creatives (reference_id) on delete cascade,
  primary key (pattern_id, reference_id)
);

-- -----------------------------------------------------------------------------
-- 2. Vanta creative
-- -----------------------------------------------------------------------------

create table if not exists public.ad_creatives (
  creative_id         text primary key,
  concept_id          text not null,
  variant_of          text references public.ad_creatives (creative_id) on delete set null,
  variant_axis        text not null default 'none',
  variant_label       text,
  archetype           text not null,
  status              text not null default 'concept',
  hook                text not null,
  opening_frame       text,
  script              text,
  storyboard          jsonb not null default '[]'::jsonb,
  caption             text,
  cta                 text,
  landing_path        text not null default '/',
  audience_hypothesis text,
  length_seconds      integer,
  claims_used         jsonb not null default '[]'::jsonb,
  eligibility         text not null default 'needs_verification',
  inspired_by         text[] not null default '{}',
  uses_patterns       text[] not null default '{}',
  -- The tracking token. Unique because two creatives sharing one would silently
  -- merge their performance, and the merge is undetectable after the fact.
  utm_content         text unique,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists ad_creatives_concept_idx on public.ad_creatives (concept_id);
create index if not exists ad_creatives_status_idx on public.ad_creatives (status);

create table if not exists public.ad_media_requests (
  request_id      text primary key,
  creative_id     text not null references public.ad_creatives (creative_id) on delete cascade,
  kind            text not null check (kind in ('image','video','voiceover','music')),
  prompt          text not null,
  provider        text,
  provider_job_id text,
  status          text not null default 'pending',
  asset_path      text,
  failure_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists ad_media_requests_status_idx on public.ad_media_requests (status);

-- Populated only after a real publish. A row here means the ad exists on the
-- platform; its absence means it does not. Never speculatively inserted.
create table if not exists public.ad_platform_refs (
  creative_id   text primary key references public.ad_creatives (creative_id) on delete cascade,
  platform      text not null,
  advertiser_id text not null,
  campaign_id   text not null,
  ad_group_id   text not null,
  ad_id         text not null,
  utm_content   text not null,
  published_at  timestamptz not null default now()
);

create index if not exists ad_platform_refs_ad_idx on public.ad_platform_refs (platform, ad_id);
create index if not exists ad_platform_refs_utm_idx on public.ad_platform_refs (utm_content);

-- -----------------------------------------------------------------------------
-- 3. Experiments
-- -----------------------------------------------------------------------------

create table if not exists public.ad_experiments (
  experiment_id  text primary key,
  name           text not null,
  hypothesis     text not null,
  axis           text not null,
  control_creative_id text,
  status         text not null default 'draft',
  -- Declared before the test runs so alpha can be corrected for peeking.
  -- Deciding how often to look after seeing the data is how a 5% error rate
  -- becomes 23%.
  planned_looks  integer not null default 3,
  looks_taken    integer not null default 0,
  started_at     timestamptz,
  decided_at     timestamptz,
  outcome        text,
  created_at     timestamptz not null default now()
);

create table if not exists public.ad_experiment_arms (
  experiment_id text not null references public.ad_experiments (experiment_id) on delete cascade,
  creative_id   text not null references public.ad_creatives (creative_id) on delete cascade,
  primary key (experiment_id, creative_id)
);

-- -----------------------------------------------------------------------------
-- 4. Performance
-- -----------------------------------------------------------------------------

-- One row per creative per day. Platform-side and site-side counts sit side by
-- side and are never reconciled into one number: the platform's conversion
-- count is its own attribution model and will disagree with ours. Keeping both
-- makes the disagreement visible instead of arbitrary.
create table if not exists public.ad_performance_daily (
  creative_id          text not null references public.ad_creatives (creative_id) on delete cascade,
  stat_date            date not null,
  platform             text not null default 'tiktok',
  campaign_id          text,
  ad_group_id          text,
  ad_id                text,

  spend                numeric(12,2) not null default 0,
  impressions          bigint not null default 0,
  reach                bigint,
  clicks               bigint not null default 0,
  video_views          bigint,
  views_2s             bigint,
  views_6s             bigint,
  views_complete       bigint,
  platform_conversions bigint,

  site_sessions        bigint not null default 0,
  site_add_to_carts    bigint not null default 0,
  site_checkouts       bigint not null default 0,
  site_purchases       bigint not null default 0,
  site_revenue         numeric(12,2) not null default 0,
  site_refunds         numeric(12,2) not null default 0,

  recorded_at          timestamptz not null default now(),
  primary key (creative_id, stat_date, platform)
);

create index if not exists ad_performance_daily_date_idx on public.ad_performance_daily (stat_date desc);

-- Derived metrics are a view, not columns. CTR stored alongside clicks and
-- impressions is a third number that can disagree with the two that produced
-- it, and it always eventually does.
--
-- security_invoker IS LOAD-BEARING, and its absence would have undone section 6
-- below. ad_performance_daily has RLS enabled with no policy, so no browser can
-- read it — but a view created WITHOUT security_invoker runs as its OWNER, and
-- the owner of a table is exempt from that table's RLS. Supabase's default
-- privileges then grant SELECT on a new public view to anon and authenticated,
-- so this view would have been an unauthenticated read of the store's entire ad
-- spend, CPA and ROAS: precisely the data section 6 says "the browser must never
-- read". The revoke below is the second half — invoker rights alone still leave
-- the grant sitting there for any future policy to widen.
create or replace view public.ad_performance_derived
with (security_invoker = true) as
select
  p.creative_id,
  p.stat_date,
  p.platform,
  p.spend,
  p.impressions,
  p.clicks,
  p.site_add_to_carts,
  p.site_purchases,
  (p.site_revenue - p.site_refunds) as net_revenue,
  case when p.impressions > 0 then p.clicks::numeric / p.impressions end as ctr,
  case when p.clicks > 0 then p.spend / p.clicks end as cpc,
  case when p.impressions > 0 then (p.spend / p.impressions) * 1000 end as cpm,
  case when p.clicks > 0 then p.site_add_to_carts::numeric / p.clicks end as atc_rate,
  case when p.site_add_to_carts > 0 then p.site_checkouts::numeric / p.site_add_to_carts end as checkout_rate,
  case when p.clicks > 0 then p.site_purchases::numeric / p.clicks end as cvr,
  case when p.site_purchases > 0 then p.spend / p.site_purchases end as cpa,
  case when p.spend > 0 then (p.site_revenue - p.site_refunds) / p.spend end as roas,
  case when p.impressions > 0 then p.views_2s::numeric / p.impressions end as hook_rate,
  case when p.views_2s > 0 then p.views_6s::numeric / p.views_2s end as hold_rate
from public.ad_performance_daily p;

revoke all on public.ad_performance_derived from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Decisions, guardrails and the action log
-- -----------------------------------------------------------------------------

create table if not exists public.ad_decisions (
  decision_id        text primary key,
  creative_id        text references public.ad_creatives (creative_id) on delete cascade,
  action             text not null,
  rationale          text not null,
  decided_metrics    text[] not null default '{}',
  unresolved_metrics text[] not null default '{}',
  evidence           jsonb not null default '{}'::jsonb,
  auto_executable    boolean not null default false,
  created_at         timestamptz not null default now()
);

-- Single row. Deny-by-default values matching DEFAULT_GUARDRAILS in
-- src/lib/ads/guardrails.ts — if you change one, change both.
create table if not exists public.ad_guardrails (
  id                           integer primary key default 1 check (id = 1),
  mode                         text not null default 'recommend'
                                 check (mode in ('recommend','manual_approval','autonomous')),
  daily_account_ceiling        numeric(12,2) not null default 100,
  campaign_daily_ceiling       numeric(12,2) not null default 50,
  max_budget_increase_pct      numeric(5,4) not null default 0.20,
  max_budget_increase_absolute numeric(12,2) not null default 25,
  min_conversions_to_scale     integer not null default 10,
  min_days_to_scale            integer not null default 7,
  min_impressions_to_kill      integer not null default 2000,
  auto_approved_actions        text[] not null default '{pause_ad,pause_campaign,decrease_budget,emergency_pause_all}',
  frozen                       boolean not null default false,
  frozen_reason                text,
  updated_at                   timestamptz not null default now()
);

insert into public.ad_guardrails (id) values (1) on conflict (id) do nothing;

create table if not exists public.ad_action_log (
  action_id         text primary key,
  at                timestamptz not null default now(),
  action_type       text not null,
  creative_id       text,
  campaign_id       text,
  ad_group_id       text,
  ad_id             text,
  daily_budget_delta numeric(12,2) not null default 0,
  rationale         text not null,
  proposal          jsonb not null default '{}'::jsonb,
  ruling            jsonb not null default '{}'::jsonb,
  executed          boolean not null default false,
  execution_result  jsonb,
  inverse           jsonb,
  reverted_by       text
);

create index if not exists ad_action_log_at_idx on public.ad_action_log (at desc);

-- Append-only, enforced in the database rather than by convention. A log that
-- can be edited cannot answer "what did the machine actually do", which is the
-- only question that matters after a bad night. The single permitted update is
-- stamping reverted_by on an existing row.
create or replace function public.ad_action_log_no_rewrite() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ad_action_log is append-only; rows cannot be deleted';
  end if;
  if row(new.*) is distinct from row(old.*) then
    if new.action_id is distinct from old.action_id
       or new.at is distinct from old.at
       or new.action_type is distinct from old.action_type
       or new.proposal is distinct from old.proposal
       or new.ruling is distinct from old.ruling
       or new.executed is distinct from old.executed
       or new.execution_result is distinct from old.execution_result then
      raise exception 'ad_action_log is append-only; only reverted_by may change';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ad_action_log_no_rewrite_trg on public.ad_action_log;
create trigger ad_action_log_no_rewrite_trg
  before update or delete on public.ad_action_log
  for each row execute function public.ad_action_log_no_rewrite();

-- -----------------------------------------------------------------------------
-- 6. RLS — deny by default
-- -----------------------------------------------------------------------------

-- Every table is enabled with no policy, so only the service-role key (which
-- bypasses RLS) can reach them. The browser must never read the ad system: it
-- contains competitor analysis, spend and the owner's private judgements.
do $$
declare t text;
begin
  foreach t in array array[
    'ad_reference_creatives','ad_owner_taste_signals','ad_patterns','ad_pattern_observations',
    'ad_creatives','ad_media_requests','ad_platform_refs','ad_experiments','ad_experiment_arms',
    'ad_performance_daily','ad_decisions','ad_guardrails','ad_action_log'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Verify
-- -----------------------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema = 'public' and table_name like 'ad\_%' order by 1;
