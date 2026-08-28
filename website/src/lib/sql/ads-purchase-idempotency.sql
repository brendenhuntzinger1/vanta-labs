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

-- ---------------------------------------------------------------------------
-- THE KEY IS COMPOSITE, AND THIS FILE USED TO SAY IT WAS NOT (F-02).
--
-- This declared `order_id text primary key` while the route upserts with
-- `onConflict: "order_id,platform"` (api/ads/purchase-event/[orderId]/route.ts).
-- Production was queried on 2026-08-28 to settle which record was wrong:
--
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.ad_purchase_events_sent'::regclass;
--   -> ad_purchase_events_sent_pkey  PRIMARY KEY (order_id, platform)
--
-- Production carries the composite key. The ROUTE was right and this FILE was
-- the stale record, so the file is corrected rather than the code — no
-- production change was made or needed.
--
-- The composite key is also the correct one on the merits, which is why the
-- drift mattered beyond tidiness. One row per ORDER would mean the TikTok send
-- permanently blocks the Reddit send for the same order: they are separate
-- conversions on separate platforms, and the second would be recorded as an
-- already-sent duplicate and never dispatched. One row per (order, platform) is
-- the invariant the route actually enforces.
--
-- Left uncorrected, this file was a live hazard rather than a stale comment: a
-- fresh environment (or the local harness) built from it would get the
-- single-column key, and every upsert the route makes would fail against a
-- conflict target that does not exist there.
--
-- NOTE for anyone re-running this against a database that already has the OLD
-- single-column key: `create table if not exists` will NOT fix it. Drop and
-- recreate the constraint deliberately —
--   alter table public.ad_purchase_events_sent
--     drop constraint ad_purchase_events_sent_pkey,
--     add primary key (order_id, platform);
-- ---------------------------------------------------------------------------
create table if not exists public.ad_purchase_events_sent (
  order_id      text not null,
  event_id      text not null,
  platform      text not null default 'tiktok',
  delivered     boolean not null default false,
  tiktok_code   integer,
  first_sent_at timestamptz not null default now(),
  attempts      integer not null default 1,
  primary key (order_id, platform)
);

create index if not exists ad_purchase_events_sent_at_idx
  on public.ad_purchase_events_sent (first_sent_at desc);

alter table public.ad_purchase_events_sent enable row level security;

comment on table public.ad_purchase_events_sent is
  'One row per (order, platform) whose Purchase has been reported server-side. Prevents a re-opened confirmation link from creating a second conversion after TikTok''s 48-hour dedup window closes.';
