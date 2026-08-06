-- ---------------------------------------------------------------------------
-- Shippo ORDERS sync.
--
-- Follows self-fulfillment-shippo.sql. Additive and idempotent; safe to re-run.
--
-- WHY THIS EXISTS
-- The first build had the owner buying labels inside the Vanta admin, with
-- Shippo used purely as an API. The workflow has changed: paid orders are now
-- pushed into Shippo's own Orders tab, the owner buys the label there, and the
-- resulting cost and tracking flow back here.
--
-- That inverts the direction of the interesting data. Previously we knew the
-- transaction id because we created it; now Shippo tells us about a purchase we
-- did not initiate, and we have to match it to an order. Everything below
-- exists to make that match reliable.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. THE MATCHING KEY
--
-- shippo_order_id is the authoritative join between the two systems. When a
-- label is bought in Shippo's dashboard, the transaction_created webhook
-- carries the Shippo ORDER id, and that is what identifies our order.
--
-- Matching on customer name or email would be wrong and quietly so: a repeat
-- customer with two open orders would have the label cost attached to whichever
-- row happened to be found first, silently corrupting the profit figures on
-- both. Matching on order_number is a usable fallback because we set it, but it
-- is a string Shippo echoes rather than an id it owns, so it is second choice.
-- ---------------------------------------------------------------------------
alter table if exists public.orders
  add column if not exists shippo_order_id text;

-- Every inbound transaction_created event looks up an order by this column, so
-- it must not be a sequential scan of the whole orders table.
create unique index if not exists idx_orders_shippo_order_id
  on public.orders (shippo_order_id)
  where shippo_order_id is not null;

-- ---------------------------------------------------------------------------
-- 2. SYNC STATE
--
-- Pushing to Shippo can fail (network, auth, an address Shippo rejects). A
-- failed sync must be visible and retryable rather than silent: an order that
-- never reached Shippo is an order that never ships, and the customer has
-- already paid.
--
-- shippo_sync_claimed_at is the same exactly-once claim used for the label
-- purchase and for paid side-effects. Creating a Shippo order is not free of
-- consequence -- a duplicate produces two identical shipments in the Orders tab
-- with no way to tell which to use -- so concurrent callers must not both push.
-- ---------------------------------------------------------------------------
alter table if exists public.orders
  add column if not exists shippo_sync_status text,           -- pending | synced | error
  add column if not exists shippo_sync_error text,
  add column if not exists shippo_synced_at timestamptz,
  add column if not exists shippo_sync_claimed_at timestamptz,
  add column if not exists shippo_sync_attempts integer not null default 0;

-- The admin's "failed to reach Shippo" queue. Partial, so it stays small.
create index if not exists idx_orders_shippo_sync_failed
  on public.orders (order_id)
  where shippo_sync_status = 'error';

-- Orders that are paid but have not been pushed yet -- what a retry sweep reads.
create index if not exists idx_orders_shippo_sync_pending
  on public.orders (order_id)
  where shippo_order_id is null;

-- ---------------------------------------------------------------------------
-- 3. WEBHOOK EVENT LOG
--
-- shippo_webhook_events (self-fulfillment-shippo.sql) already dedupes by event
-- key. This adds the audit trail the owner needs when a label cost does not
-- appear: which event arrived, what it was for, whether it matched an order,
-- and why not.
--
-- An unmatched transaction_created is the important case. It means a label was
-- bought -- real money spent -- that we could not attribute. That must never be
-- silently discarded; it is logged here for manual reconciliation.
-- ---------------------------------------------------------------------------
alter table if exists public.shippo_webhook_events
  add column if not exists event_type text,
  add column if not exists order_id text,
  add column if not exists shippo_object_id text,
  add column if not exists matched boolean,
  add column if not exists error text,
  add column if not exists retry_count integer not null default 0;

-- The reconciliation queue: paid labels we could not attribute to an order.
create index if not exists idx_shippo_webhook_events_unmatched
  on public.shippo_webhook_events (received_at desc)
  where matched = false;

-- ---------------------------------------------------------------------------
-- 4. SHIPPING PROFIT
--
-- What the customer paid for shipping and what the label actually cost are
-- different numbers, and the difference is a real line in the P&L. Free
-- shipping makes it negative, which is the point: it should be visible, not
-- averaged away.
--
--   shipping_profit = shipping_charged_to_customer - actual_label_cost
--
-- Stored as a generated column so it cannot drift from its inputs. postage_cost
-- _cents comes from the label purchase (self-fulfillment-shippo.sql); shipping
-- _amount is what was charged at checkout, in dollars, so it is converted here.
--
-- NULL until a label is bought -- deliberately not 0. A zero would read as
-- "broke even on shipping" for every unshipped order and quietly overstate
-- margin across the whole dashboard.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name = 'shipping_profit_cents'
  ) then
    alter table public.orders
      add column shipping_profit_cents integer
      generated always as (
        case
          when postage_cost_cents is null then null
          else round(coalesce(shipping_amount, 0) * 100)::integer - postage_cost_cents
        end
      ) stored;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. VERIFY
-- Every column must read true before the sync is expected to work.
-- ---------------------------------------------------------------------------
select
  to_regclass('public.shippo_webhook_events') is not null                      as webhook_events_table_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='shippo_order_id')                                      as shippo_order_id_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='shippo_sync_status')                                   as sync_status_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='shippo_sync_claimed_at')                               as sync_claim_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='orders'
       and column_name='shipping_profit_cents')                                as shipping_profit_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='shippo_webhook_events'
       and column_name='matched')                                              as event_matched_ok,
  to_regclass('public.idx_orders_shippo_order_id') is not null                  as order_id_index_ok;
