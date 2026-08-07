-- ============================================================================
-- VANTA LABS — SELF-FULFILLMENT VIA SHIPPO
-- The store now packs and ships every order itself and buys postage directly
-- from Shippo. Nothing is handed to an outside fulfiller any more, so the
-- database has to hold the facts a 3PL used to hold for us:
--
--   * how much a packed unit WEIGHS and what box it goes in  — Shippo cannot
--     rate a shipment without a parcel, and a wrong weight is a wrong price on
--     a real credit card;
--   * the Shippo shipment / rate / transaction ids, the label, and the EXACT
--     postage paid, so profit is finalized from what was actually charged
--     rather than an estimate;
--   * an exactly-once claim for the label purchase — a double-clicked "Buy
--     label" button must not buy (and pay for) two labels;
--   * webhook idempotency + a status audit trail, because Shippo tracking
--     events are at-least-once and arrive OUT OF ORDER.
--
-- Additive and idempotent throughout: every column/table/index is guarded, no
-- existing column is dropped, retyped or backfilled, and no constraint is added
-- that could reject a row that is already in the table. Safe to re-run.
--
-- RUN THIS BEFORE DEPLOYING THE CODE THAT READS IT. Deployed first, the label
-- purchase would run without its claim column — which is precisely the case
-- that buys two labels.
--
-- Supabase -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Packed weight per unit
--
-- Shippo prices a parcel, not a cart, so every sellable line needs a weight in
-- ounces. The default of 0.18 oz is a typical single vial — it exists so an
-- under-configured catalog still rates and ships instead of erroring at the
-- counter; the owner corrects it per product in Admin -> Products.
--
-- A dose row inherits the parent product's weight when its own is NULL (a
-- 5 mg and a 10 mg vial usually weigh the same), which is why this column is
-- deliberately nullable with NO default: NULL means "inherit", and a default
-- would silently pin every variant to 0.18 and hide the parent's real value.
-- The resolution order lives in src/lib/shippo/parcel.ts.
--
-- 0.18 oz is a 3ml peptide vial at 5g, the owner's figure, rounded up from
-- 0.1764 so the declaration never lands under the real weight. Not yet weighed.
-- roughly 10-15g. It is a STARTING POINT to be replaced by a real scale
-- reading, not an estimate to rely on. Erring high is not the safe direction:
-- USPS Ground Advantage prices in weight tiers, so phantom ounces multiplied
-- across a multi-vial order can push a parcel into a higher tier and overcharge
-- on every shipment. Heavier goods (bacteriostatic water, larger bottles) must
-- have their real weight entered per product — 30ml of water alone is ~1.2 oz
-- before the bottle.
--
-- Packaging tare is NOT included here. It lives on the package preset and is
-- added once per parcel, so it must never be baked into a per-unit weight.
-- ---------------------------------------------------------------------------
alter table if exists public.products
  add column if not exists shipping_weight_oz numeric default 0.18;

alter table if exists public.product_doses
  add column if not exists shipping_weight_oz numeric;

comment on column public.products.shipping_weight_oz is
  'Packaged weight of ONE unit in ounces, used to build the Shippo parcel.';
comment on column public.product_doses.shipping_weight_oz is
  'Packaged weight of ONE unit in ounces; NULL inherits products.shipping_weight_oz.';

-- ---------------------------------------------------------------------------
-- 2. Package presets
--
-- The dimensions half of the parcel. The owner ships out of a small number of
-- box/mailer types, so they are rows rather than hard-coded constants: postage
-- is dimension-sensitive (dimensional weight, USPS cubic tiers), and changing a
-- box should be a settings edit, not a deploy.
--
-- empty_weight_oz is the packaging tare — it is added ONCE to the parcel, on
-- top of the per-unit product weights, so a 1-item and a 6-item order both
-- carry the mailer's own weight exactly once.
-- ---------------------------------------------------------------------------
create table if not exists public.shipping_package_presets (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,                      -- shown in the admin picker
  length_in       numeric not null,
  width_in        numeric not null,
  height_in       numeric not null,
  empty_weight_oz numeric not null default 0,          -- tare weight of the empty box
  is_default      boolean not null default false,      -- used when an order names no preset
  is_active       boolean not null default true,       -- retire a box without losing history
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Exactly one default, enforced by the database rather than by admin code:
-- parcel math resolves "no preset on the order" to THE default preset, and two
-- defaults would make that resolution non-deterministic (a rate quoted from one
-- box, a label bought against another). Partial so the many non-default rows
-- stay unconstrained.
create unique index if not exists shipping_package_presets_single_default
  on public.shipping_package_presets (is_default)
  where is_default;

create index if not exists idx_shipping_package_presets_active
  on public.shipping_package_presets (is_active, name);

-- Seed the house mailer, but ONLY into an empty table. Keying the guard on
-- emptiness rather than on the name means a re-run can never (a) resurrect a
-- preset the owner deleted, nor (b) collide with the single-default index by
-- flagging a second default alongside the box they chose. An empty table has no
-- default at all, which would leave parcel math with no dimensions — so that
-- one case is worth seeding.
insert into public.shipping_package_presets
  (name, length_in, width_in, height_in, empty_weight_oz, is_default, is_active)
select 'Standard Vanta Mailer', 9, 6, 3, 1.5, true, true
where not exists (select 1 from public.shipping_package_presets);

-- ---------------------------------------------------------------------------
-- 3. Per-order Shippo state
--
-- All nullable: an order is created (and paid) long before a label exists, and
-- legacy orders shipped under the old arrangement never get one.
--
--   shippo_shipment_id / shippo_rate_id  the quote the owner picked, kept so a
--                                        purchase can be re-attempted or
--                                        audited against what was shown;
--   shippo_transaction_id                the bought label — the SHORT-CIRCUIT
--                                        for a repeat purchase request;
--   postage_cost_cents                   the EXACT amount Shippo charged, in
--                                        integer cents. Never 0 as a stand-in
--                                        for "unknown": unknown stays NULL and
--                                        the UI renders "Pending", because a
--                                        stored 0 would quietly inflate profit;
--   parcel_weight_oz_override            replaces (not adds to) the computed
--                                        total for the odd order the math gets
--                                        wrong — e.g. extra cold packs.
-- ---------------------------------------------------------------------------
alter table if exists public.orders
  add column if not exists shippo_shipment_id        text,
  add column if not exists shippo_transaction_id     text,
  add column if not exists shippo_rate_id            text,
  add column if not exists shipping_carrier          text,      -- USPS | UPS | FedEx
  add column if not exists shipping_service          text,      -- servicelevel token/name
  add column if not exists label_url                 text,
  add column if not exists label_purchased_at        timestamptz,
  add column if not exists label_voided_at           timestamptz,
  add column if not exists postage_cost_cents        integer,
  add column if not exists package_preset_id         uuid,
  add column if not exists parcel_weight_oz_override numeric,
  add column if not exists packed_at                 timestamptz,
  add column if not exists shipped_at                timestamptz,
  add column if not exists delivered_at              timestamptz;

-- The FK is added separately from the column so a database where the column
-- already exists (partial earlier run) still gets the constraint.
-- ON DELETE SET NULL: retiring a box must never delete or block an order; the
-- order keeps its bought label and simply loses the pointer to the box type.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orders_package_preset_id_fkey') then
    alter table public.orders
      add constraint orders_package_preset_id_fkey
      foreign key (package_preset_id)
      references public.shipping_package_presets(id)
      on delete set null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3a. EXACTLY-ONCE LABEL PURCHASE CLAIM
--
-- The single most expensive race in the system: two concurrent "Buy label"
-- requests (double-click, refresh, HTTP retry, two admins) would each call
-- Shippo and each be charged for postage, and only one label can ship.
--
-- Same proven pattern as orders.inventory_restocked_at (add-inventory-restock-
-- claim.sql) and orders.paid_side_effects_at (order-paid-side-effects.sql):
--
--   update orders set label_purchase_claimed_at = now()
--    where order_id = $1 and label_purchase_claimed_at is null returning id
--
-- Postgres serializes the two updates on the row lock, so exactly one caller
-- sees a returned row and may talk to Shippo. Losers return the EXISTING label
-- rather than an error. If the Shippo call fails, the winner sets the column
-- back to NULL so a genuine retry can proceed — which is why this is a
-- nullable timestamp and not a boolean.
--
-- Nullable with no backfill: existing orders stay NULL, meaning "no label
-- bought yet", which is exactly right for every historical row.
-- ---------------------------------------------------------------------------
alter table if exists public.orders
  add column if not exists label_purchase_claimed_at timestamptz;

-- Keeps the admin "needs a label" queue from scanning every historical order;
-- mirrors idx_orders_inventory_restock_pending.
create index if not exists idx_orders_label_purchase_pending
  on public.orders (order_id)
  where label_purchase_claimed_at is null;

-- Tracking webhooks identify an order by the Shippo transaction or the carrier
-- tracking number, never by our order_id — both lookups run on every event.
create index if not exists idx_orders_shippo_transaction_id
  on public.orders (shippo_transaction_id)
  where shippo_transaction_id is not null;

create index if not exists idx_orders_tracking_number
  on public.orders (tracking_number)
  where tracking_number is not null;

-- NOTE — deliberately NO check constraint on orders.fulfillment_status.
-- Live rows still hold legacy values written before the pipeline existed
-- ('pending', 'awaiting_fulfillment', 'processing', 'fulfilled',
-- 'partially_fulfilled'), and more may exist in this database than the code
-- knows about. A CHECK is validated against EXISTING rows when added, so it
-- would fail the migration outright — or, worse, succeed here and then reject a
-- perfectly valid write on an old order in production. The allowed set is
-- enforced in one place instead: the transition function in
-- src/lib/order-pipeline.ts, which maps every legacy value forward.

-- ---------------------------------------------------------------------------
-- 4. Shippo webhook idempotency
--
-- Shippo retries deliveries and can send the same tracking event more than
-- once. event_key is a stable key derived from the payload (tracking number +
-- status + status_date), so a duplicate delivery collides on the primary key
-- and is dropped before it can re-run side effects such as the customer
-- shipping email.
--
-- received_at is written on claim, processed_at only once handling SUCCEEDS —
-- same split as payment_events (payment-events-reclaim.sql), so a crash
-- mid-handling leaves a claimed-but-unprocessed row that can be identified and
-- retaken rather than a silently swallowed event.
-- ---------------------------------------------------------------------------
create table if not exists public.shippo_webhook_events (
  event_key    text primary key,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- Finds stranded claims (received, never processed) and bounds the retention
-- sweep.
create index if not exists idx_shippo_webhook_events_unprocessed
  on public.shippo_webhook_events (received_at)
  where processed_at is null;

-- ---------------------------------------------------------------------------
-- 5. Order status history
--
-- Every fulfillment-status transition, with WHERE it came from. Two reasons
-- this is a real table rather than another admin_audit_logs row: tracking
-- events arrive out of order, so "why is this order still in_transit when it
-- was delivered?" is only answerable from an ordered event log; and the
-- customer-facing timeline reads it directly, which an admin audit table
-- should not serve.
--
-- source: 'admin' (a human clicked) | 'shippo' (a tracking webhook) |
-- 'system' (payment webhook, sweep, backfill). actor is the admin username
-- for 'admin', NULL for automated writes.
--
-- No FK to orders on purpose: this is an append-only audit trail. It must
-- neither block a status write (a webhook can land while the order row is
-- being written) nor be cascade-deleted with the order — the history of a
-- shipment outlives the record it describes.
-- ---------------------------------------------------------------------------
create table if not exists public.order_status_history (
  id          uuid primary key default gen_random_uuid(),
  order_id    text not null,
  from_status text,                       -- NULL for the first recorded status
  to_status   text not null,
  source      text not null,              -- admin | shippo | system
  actor       text,
  created_at  timestamptz not null default now()
);

-- The timeline query: one order, newest first.
create index if not exists idx_order_status_history_order_id
  on public.order_status_history (order_id, created_at desc);

create index if not exists idx_order_status_history_created_at
  on public.order_status_history (created_at desc);

-- ---------------------------------------------------------------------------
-- 6. RLS
--
-- All three tables are operational and reached exclusively through the
-- service-role client (src/lib/supabase-server.ts). RLS on with NO policies =
-- deny-by-default for anon/authenticated; the service role bypasses it. Presets
-- are included because a client able to write one could shrink the box under a
-- pending label purchase and change what the store is charged.
-- ---------------------------------------------------------------------------
alter table public.shipping_package_presets enable row level security;
alter table public.shippo_webhook_events    enable row level security;
alter table public.order_status_history     enable row level security;

-- ---------------------------------------------------------------------------
-- 7. Verification — every column below must come back `t`.
-- ---------------------------------------------------------------------------
select
  to_regclass('public.shipping_package_presets') is not null as presets_table_ok,
  to_regclass('public.shippo_webhook_events')    is not null as webhook_events_table_ok,
  to_regclass('public.order_status_history')     is not null as status_history_table_ok,
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='products'
             and column_name='shipping_weight_oz')            as product_weight_ok,
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='product_doses'
             and column_name='shipping_weight_oz')            as dose_weight_ok,
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='orders'
             and column_name='shippo_transaction_id')         as transaction_col_ok,
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='orders'
             and column_name='postage_cost_cents')            as postage_col_ok,
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='orders'
             and column_name='label_purchase_claimed_at')     as label_claim_ok,
  exists (select 1 from pg_indexes
           where schemaname='public'
             and indexname='shipping_package_presets_single_default') as single_default_ok,
  exists (select 1 from pg_constraint
           where conname='orders_package_preset_id_fkey')     as preset_fk_ok,
  (select count(*) from public.shipping_package_presets where is_default) = 1 as default_preset_ok;
