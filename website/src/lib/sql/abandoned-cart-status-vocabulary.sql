-- ---------------------------------------------------------------------------
-- THE CART STATUS VOCABULARY, ENFORCED WHERE IT CANNOT BE BYPASSED.
--
-- WHAT THIS FIXES. On 2026-09-10 four abandoned carts sat at status='held':
-- $1,980.90 in total, averaging $495 against a $185 norm, the largest a
-- $950.07 cart that had received one of its four recovery stages. Nothing in
-- the application writes 'held' and nothing clears it — it is absent from the
-- TypeScript, from every SQL file, and from the entire git history. The rows
-- outlived whatever wrote them.
--
-- They were frozen in BOTH directions. The sweep selected
-- `.eq("status","active")`, so no further stage could be sent; and
-- markAbandonedCartsRecovered filtered the same way, so a purchase could not
-- close them either. Nothing alerted, because a cart that is mailed by nothing
-- and closed by nothing leaves only an absence behind, which looks exactly
-- like a quiet week.
--
-- The application half of the fix is CART_STATUS_OPEN / CART_STATUS_TERMINAL
-- in cart-recovery.ts: the sweep now asks "is this cart open?" rather than "is
-- this cart active?". That stops a known-but-unhandled status from freezing a
-- cart. This file stops an UNKNOWN one from ever being written — including by
-- a hand-run UPDATE in a SQL console, which is the only path that can explain
-- the four rows above, and the one path no amount of TypeScript can guard.
--
-- WHY 'held' IS KEPT RATHER THAN MIGRATED AWAY. rename-to-recon-water.sql
-- already records the intent in writing — "(active + held) can still send" —
-- so 'held' means an open cart, not a closed one. Deleting the value would
-- silently re-close the same four carts; naming it makes the intent explicit
-- and keeps them sending.
--
-- IDEMPOTENT. Safe to re-run: the constraint is dropped and recreated, and the
-- backfill only touches rows that are already outside the vocabulary.
-- ---------------------------------------------------------------------------

begin;

-- 1. Any row already outside the vocabulary becomes 'active' so it re-enters
--    the programme rather than being rejected by the constraint below. The
--    sweep's own paid-order check closes anything the shopper has since
--    bought, so a stale row cannot mail someone who already converted.
update public.abandoned_carts
   set status = 'active'
 where status is null
    or status not in ('active', 'held', 'recovered', 'cleared', 'expired');

-- 2. The vocabulary itself. Two open statuses, three terminal ones, and
--    nothing else. A future status must be added HERE and to
--    CART_STATUS_OPEN/CART_STATUS_TERMINAL together — which is the point: the
--    constraint makes the omission a loud failure at write time instead of a
--    silent freeze discovered in an audit.
alter table public.abandoned_carts
  drop constraint if exists abandoned_carts_status_vocabulary;

alter table public.abandoned_carts
  add constraint abandoned_carts_status_vocabulary
  check (status in ('active', 'held', 'recovered', 'cleared', 'expired'));

comment on constraint abandoned_carts_status_vocabulary on public.abandoned_carts is
  'Open: active, held. Terminal: recovered, cleared, expired. Kept in step with CART_STATUS_OPEN/CART_STATUS_TERMINAL in cart-recovery.ts — a status known to one and not the other freezes carts silently, which is what this constraint exists to prevent.';

-- 3. The sweep pages by status and activity on every tick. Without this it is
--    a sequential scan of the whole table each time; with it the open carts
--    are found directly.
create index if not exists abandoned_carts_open_activity_idx
  on public.abandoned_carts (status, last_updated_at desc)
  where status in ('active', 'held');

commit;
