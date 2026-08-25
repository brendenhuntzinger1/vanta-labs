-- =============================================================================
-- Purchase send-ledger — idempotency for server-side conversion reporting.
--
-- APPLIED to production 2026-08-25. Additive, isolated, no FK into commerce.
--
-- Applied because the second real production order proved the gap is live, not
-- theoretical: PostgREST answered 404 for this table at 03:36:17.067 (the
-- lookup the route makes before deciding whether to send), so `alreadySent` was
-- always false, and the shopper's back-navigation re-sent the server-side
-- TikTok and Reddit conversions 27 seconds after the first send.
--
-- Verified after applying: RLS on, zero policies, and `set role anon` sees 0
-- rows with a probe row present. Only service_role reads it.
--
-- TikTok dedups identical (event_source_id, event, event_id) for 48 hours. The
-- confirmation URL is an unguessable bearer token but it can circulate, and a
-- visit 49 hours later would send the same Purchase again as a NEW conversion.
-- This table makes the send permanent rather than time-boxed.
--
-- It records only that a send happened. No customer data, no order amounts —
-- the order itself remains the source of truth for everything that matters.
-- =============================================================================

create table if not exists public.ad_purchase_events_sent (
  order_id      text primary key,
  event_id      text not null,
  platform      text not null default 'tiktok',
  delivered     boolean not null default false,
  tiktok_code   integer,
  first_sent_at timestamptz not null default now(),
  attempts      integer not null default 1
);

create index if not exists ad_purchase_events_sent_at_idx
  on public.ad_purchase_events_sent (first_sent_at desc);

alter table public.ad_purchase_events_sent enable row level security;

comment on table public.ad_purchase_events_sent is
  'One row per order whose Purchase has been reported server-side. Prevents a re-opened confirmation link from creating a second conversion after TikTok''s 48-hour dedup window closes.';
