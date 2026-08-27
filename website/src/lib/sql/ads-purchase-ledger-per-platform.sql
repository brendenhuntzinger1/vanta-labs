-- =============================================================================
-- Purchase send-ledger — widen the key from (order_id) to (order_id, platform).
--
-- NOT APPLIED. Authored for review; the owner applies it separately.
--
-- THE DEFECT
-- ----------
-- `ad_purchase_events_sent` was created with `order_id text primary key` — one
-- row per order, shared by every ad channel. The route's `platform` column
-- records which channel wrote the row, but the key does not include it, so the
-- FIRST channel to report an order permanently silences every other channel for
-- that order. TikTok delivering a Purchase means Reddit can never report that
-- same sale, and Google never will either.
--
-- The fix is a real database constraint on (order_id, platform), not an
-- application check. Two simultaneous requests for the same order can both read
-- "not yet sent"; only the constraint stops both from inserting and sending.
--
-- WHY A BACKFILL IS PART OF THE FIX
-- ---------------------------------
-- Widening the key changes what an existing row means. Today the single row for
-- an order blocks EVERY platform. Afterwards that same row blocks only TikTok —
-- so Reddit and Google would read "not yet sent" for orders that predate this
-- change, and re-opening one of those confirmation links would send a
-- conversion the old structure suppressed. Widening the key alone would resend
-- history.
--
-- Step 3 therefore backfills a suppression row for every existing order on
-- every other channel. Those rows are marked `delivered = false` with
-- `event_id = 'backfill-no-send'`, because nothing was actually sent to those
-- platforms — the row exists solely so a historical order cannot newly report.
-- Do not read them as delivery evidence, and do not count them in reporting.
--
-- The code that counts them was taught to skip them: `readPurchaseLedger` in
-- src/lib/ads/tracking-health-server.ts now scopes its read to one platform and
-- excludes `event_id = 'backfill-no-send'`. Before that fix this backfill would
-- have made the tracking-health board render Reddit's sends and these
-- suppression rows as TikTok's own, and — worse — a non-zero total on an
-- account with no delivered TikTok row flips that check from NOT_TESTED to
-- FAIL, reporting a working integration as broken. Any NEW consumer of this
-- table must apply the same two exclusions; src/lib/ads/purchase-ledger.ts
-- exports countLedger() and BACKFILL_EVENT_ID so it does not have to reinvent
-- them.
--
-- Idempotent throughout: `if exists` / `if not exists` / `on conflict do
-- nothing`. Running it twice is a no-op the second time.
--
-- Preflight facts (production, read-only, 2026-08-27): constraint
-- `ad_purchase_events_sent_pkey` is UNIQUE on (order_id) alone; 1 row total,
-- 1 distinct order_id, platform = 'tiktok'; zero duplicate (order_id, platform)
-- pairs and zero null/empty platform values, so steps 1-2 cannot fail on data.
-- =============================================================================

begin;

-- Step 0. Belt and braces for the legacy rows the column default was added
-- after. `platform` is NOT NULL in production today, but an empty string would
-- read as "unknown channel" and is normalised to the default the route wrote
-- under. No-op on a clean database.
update public.ad_purchase_events_sent
   set platform = 'tiktok'
 where platform is null or btrim(platform) = '';

alter table public.ad_purchase_events_sent
  alter column platform set default 'tiktok';

alter table public.ad_purchase_events_sent
  alter column platform set not null;

-- Step 1. Drop the single-column primary key.
--
-- Guarded on the constraint's actual key columns rather than on its name, so a
-- re-run after step 2 (when a DIFFERENT constraint of the same purpose exists
-- over two columns) does not drop the correct key and recreate it.
do $$
begin
  if exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.ad_purchase_events_sent'::regclass
       and c.contype = 'p'
       and c.conkey = array[
         (select attnum from pg_attribute
           where attrelid = c.conrelid and attname = 'order_id')
       ]::smallint[]
  ) then
    alter table public.ad_purchase_events_sent
      drop constraint ad_purchase_events_sent_pkey;
  end if;
end
$$;

-- Step 2. The real constraint. This is what makes per-platform sending
-- exactly-once under concurrency — the application check in
-- src/lib/ads/purchase-ledger.ts is a read, and reads race.
do $$
begin
  if not exists (
    select 1
      from pg_constraint c
     where c.conrelid = 'public.ad_purchase_events_sent'::regclass
       and c.contype = 'p'
  ) then
    alter table public.ad_purchase_events_sent
      add constraint ad_purchase_events_sent_pkey
      primary key (order_id, platform);
  end if;
end
$$;

-- Step 3. Suppression backfill — see the header. Every order that exists at the
-- moment of this migration gets a row on every OTHER channel, so no pre-existing
-- order can newly report anywhere.
--
-- `on conflict do nothing` makes this idempotent AND makes it incapable of
-- overwriting a genuine send: if a real row already exists for that
-- (order_id, platform), it is left exactly as it is.
insert into public.ad_purchase_events_sent
  (order_id, event_id, platform, delivered, first_sent_at, attempts)
select distinct
       s.order_id,
       'backfill-no-send',
       p.platform,
       false,
       now(),
       0
  from public.ad_purchase_events_sent s
 cross join (values ('tiktok'), ('reddit'), ('google')) as p(platform)
 where s.order_id is not null
on conflict (order_id, platform) do nothing;

-- Step 4. Index unchanged (`ad_purchase_events_sent_at_idx` on first_sent_at
-- desc) — restated only so a fresh database reaches the same shape.
create index if not exists ad_purchase_events_sent_at_idx
  on public.ad_purchase_events_sent (first_sent_at desc);

-- RLS was already enabled with zero policies (service_role only). Restated for
-- the same reason; enabling an already-enabled table is a no-op.
alter table public.ad_purchase_events_sent enable row level security;

comment on table public.ad_purchase_events_sent is
  'One row per (order, ad platform) whose Purchase has been reported server-side. Keyed on (order_id, platform) so each channel deduplicates independently. Rows with event_id = ''backfill-no-send'' were never sent: they exist only to stop orders that predate the per-platform key from newly reporting on a channel the old single-column key had suppressed.';

commit;

-- =============================================================================
-- VERIFICATION (read-only; run after applying)
-- =============================================================================
-- select conname, contype,
--        (select array_agg(attname order by attnum)
--           from pg_attribute
--          where attrelid = c.conrelid and attnum = any(c.conkey)) as cols
--   from pg_constraint c
--  where c.conrelid = 'public.ad_purchase_events_sent'::regclass;
--   -> expect ad_purchase_events_sent_pkey, 'p', {order_id,platform}
--
-- select platform, count(*), count(*) filter (where event_id = 'backfill-no-send') as backfilled
--   from public.ad_purchase_events_sent group by platform order by platform;
--   -> expect one row per (order, platform) for all three platforms

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- READ THIS BEFORE RUNNING IT. A clean revert is available ONLY while no order
-- has rows for two different platforms. That is true immediately after applying
-- this migration IF you first delete the backfilled rows (step R1) — those are
-- the only multi-platform rows a fresh apply creates.
--
-- After real multi-platform use, it is NOT available. Once TikTok and Reddit
-- have each genuinely reported the same order, that order has two rows with
-- distinct platforms, and `primary key (order_id)` cannot hold both. Restoring
-- the single-column key then REQUIRES DELETING REAL SEND RECORDS — one channel's
-- proof-of-send is destroyed, and the order becomes re-sendable on that channel.
-- There is no version of this rollback that keeps that data. If you have reached
-- that point, the honest options are to stay on the two-column key, or to accept
-- the deletion knowingly and decide in advance which platform's rows survive.
--
-- begin;
--
-- -- R1. Remove the suppression rows. They are identifiable by their marker and
-- -- nothing else writes that value, so this cannot touch a genuine send.
-- delete from public.ad_purchase_events_sent
--  where event_id = 'backfill-no-send';
--
-- -- R2. Check whether a clean revert is still possible. If this returns ANY
-- -- rows, STOP: reverting the key from here means deleting real send records.
-- select order_id, count(*)
--   from public.ad_purchase_events_sent
--  group by order_id having count(*) > 1;
--
-- -- R3. Only if R2 returned zero rows: restore the single-column key.
-- alter table public.ad_purchase_events_sent
--   drop constraint if exists ad_purchase_events_sent_pkey;
-- alter table public.ad_purchase_events_sent
--   add constraint ad_purchase_events_sent_pkey primary key (order_id);
--
-- comment on table public.ad_purchase_events_sent is
--   'One row per order whose Purchase has been reported server-side. Prevents a re-opened confirmation link from creating a second conversion after TikTok''''s 48-hour dedup window closes.';
--
-- commit;
--
-- Note on the code: reverting the schema WITHOUT reverting the route re-creates
-- the original defect in a louder form — the route's upsert targets
-- "order_id,platform", which has no matching constraint once R3 runs, and the
-- ledger write will error (the route swallows it, so sends continue with TikTok's
-- own 48h dedup as the only guard). Revert the application change too.
-- =============================================================================
