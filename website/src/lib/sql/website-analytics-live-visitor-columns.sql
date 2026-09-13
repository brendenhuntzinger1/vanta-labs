-- ============================================================================
-- Live visitor tracker — user_id and is_bot on website_analytics_events.
--
-- Backs /admin/live. Two nullable/defaulted columns, no table rewrite:
--
--   user_id  uuid   references auth.users(id) on delete set null
--   is_bot   boolean not null default false
--
-- WHY user_id AND NOT name/email. The live dashboard needs to name a
-- signed-in customer/ambassador, but resolving that identity happens
-- SERVER-SIDE from the verified session cookie at write time (never from
-- anything the client claims) and the NAME is resolved at READ time, in
-- admin-live-visitors.ts, only for the handful of currently-live rows — not
-- duplicated onto every event. Storing just the id keeps this table's PII
-- footprint the same as it already was for `visitor_id`/`session_id`
-- (opaque identifiers), rather than adding a customer's name/email to a
-- table a much broader set of code already reads for ordinary analytics.
--
-- on delete set null (not cascade): deleting an auth.users row should not
-- silently delete this visit's analytics history — same choice
-- abandoned-cart-recovery.sql made for customer_user_id.
--
-- WHY is_bot. The heartbeat event type (added alongside this migration, see
-- api/analytics/track/route.ts) is classified at write time by
-- lib/bot-detection.ts so the live dashboard can filter obvious
-- crawlers/headless clients from its display. This is a display filter for
-- one internal admin screen — see that file's header for why it is not, and
-- must never become, an access control or a per-requester behavior change.
--
-- BLAST RADIUS: NONE. Two columns, no default requiring a rewrite for
-- user_id (nullable) and a constant default for is_bot (catalogue-only on
-- Postgres 11+). No existing read or write path references either column
-- today, so nothing changes until the application code that uses them ships.
--
-- Goes through the existing createOptionalColumnInserter fallback
-- (analytics-column-fallback.ts), so deploying the code before running this
-- migration degrades to "heartbeat rows write without these two columns"
-- rather than breaking analytics inserts — the same safety net
-- utm_content/utm_term/ttclid already rely on.
-- ============================================================================

alter table public.website_analytics_events
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists is_bot  boolean not null default false;

comment on column public.website_analytics_events.user_id is
  'The signed-in customer/ambassador this event belongs to, resolved server-side from the session cookie at write time — never trusted from the client. Null for anonymous activity. Never joined with name/email except at admin-live-visitors.ts read time, for currently-live rows only.';
comment on column public.website_analytics_events.is_bot is
  'Coarse UA-based bot classification (lib/bot-detection.ts), applied at write time. Display filter for /admin/live only — never an access control, never varies what is served.';

-- Run on its own — CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, and most SQL clients wrap a pasted script in one.
--
-- Partial + narrow: the live query filters is_bot = false and created_at
-- within the last ~60s, event_type in ('heartbeat','page_view','session_start'),
-- and this table's overwhelming majority of rows are neither a heartbeat nor
-- a bot, so indexing only the rows the live query actually scans keeps this
-- cheap to build and cheap to maintain on a table that already takes a row
-- per pageview.
create index concurrently if not exists website_analytics_events_live_lookup_idx
  on public.website_analytics_events (session_id, created_at desc)
  where is_bot = false and event_type in ('heartbeat', 'page_view', 'session_start');

-- Verification. Run after the statements above.
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'website_analytics_events'
--     and column_name in ('user_id', 'is_bot');
--
--   select indexrelid::regclass::text as index_name, indisvalid
--   from pg_index
--   where indrelid = 'public.website_analytics_events'::regclass
--     and indexrelid::regclass::text = 'website_analytics_events_live_lookup_idx';
--
-- Both must report indisvalid = true; a failed concurrent build leaves an
-- INVALID index that must be dropped and rebuilt, not left in place.

-- ============================================================================
-- ROLLBACK. Only if the feature is abandoned outright — dropping user_id
-- discards which live rows were ever attributable to a signed-in visitor.
--
--   drop index concurrently if exists public.website_analytics_events_live_lookup_idx;
--   alter table public.website_analytics_events
--     drop column if exists user_id,
--     drop column if exists is_bot;
-- ============================================================================
