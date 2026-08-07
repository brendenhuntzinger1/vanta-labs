-- ---------------------------------------------------------------------------
-- RLS on the fulfillment tables that were missing it.
--
-- Additive and idempotent. No data is read, changed or removed.
--
-- WHY
-- With RLS disabled, a table is reachable by the ANON key subject only to
-- table grants -- which is the key shipped to every browser on the storefront.
-- None of these tables should be readable by a shopper:
--
--   order_status_history      every order id in the store, and its progress
--   shippo_webhook_events     order ids paired with Shippo object ids
--   inventory_reservations    what is selling and how fast
--
-- None hold names or addresses, so this is not a customer-data breach. It is a
-- business-data leak: order volume, sell-through and fulfillment cadence are
-- all inferable, and none of it is a shopper's business.
--
-- The admin reaches these through the SERVICE-ROLE key, which bypasses RLS
-- entirely. So enabling it here locks the tables to server code without
-- changing a single admin behaviour. No policy is granted to anon or
-- authenticated, deliberately: there is no legitimate customer read.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.order_status_history') is not null then
    execute 'alter table public.order_status_history enable row level security';
  end if;
  if to_regclass('public.shippo_webhook_events') is not null then
    execute 'alter table public.shippo_webhook_events enable row level security';
  end if;
  if to_regclass('public.inventory_reservations') is not null then
    execute 'alter table public.inventory_reservations enable row level security';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- VERIFY -- all three true.
-- ---------------------------------------------------------------------------
select
  (select relrowsecurity from pg_class where oid = 'public.order_status_history'::regclass)   as status_history_rls_ok,
  (select relrowsecurity from pg_class where oid = 'public.shippo_webhook_events'::regclass)  as webhook_events_rls_ok,
  (select relrowsecurity from pg_class where oid = 'public.inventory_reservations'::regclass) as reservations_rls_ok;
