-- ---------------------------------------------------------------------------
-- Inventory transaction ledger.
--
-- Additive and idempotent; safe to re-run. Creates no destructive operation and
-- changes no existing quantity.
--
-- WHY
-- A stock level is a running total with no memory. "Why does this say 3 when I
-- counted 5?" cannot be answered from it: a miscount, a double decrement, and
-- an adjustment somebody forgot making all look identical after the fact.
--
-- APPEND-ONLY BY INTENT. Nothing updates or deletes these rows. A ledger you
-- can edit answers no questions; a mistaken entry is corrected by writing a
-- compensating one so both remain visible.
-- ---------------------------------------------------------------------------

create table if not exists public.inventory_transactions (
  id           uuid primary key default gen_random_uuid(),

  -- The product, and the specific dose when the product has variants. A dose is
  -- tracked separately from its parent because "GLP-1 5 mg" and "GLP-1 20 mg"
  -- are different physical stock; sharing one number would let a sold-out dose
  -- keep selling.
  product_id   text not null,
  dose_id      text,
  sku          text,

  transaction_type text not null,     -- see INVENTORY_TRANSACTION_LABELS in
                                      -- src/lib/inventory-ledger.ts

  -- Signed. Negative removes stock. Stored alongside before/after rather than
  -- derived from them, because the surrounding rows may be written by concurrent
  -- callers and a derived delta would silently misattribute the difference.
  delta            integer not null,
  quantity_before  integer,
  quantity_after   integer,

  reason  text,
  -- Admin username, or a system marker such as 'payment_webhook'. Nullable
  -- because an automatic movement has no human behind it, and inventing one
  -- would make the audit trail lie.
  actor   text,
  -- Set for movements caused by an order, so a customer's inventory history can
  -- be reconstructed from their order id.
  order_id text,

  created_at timestamptz not null default now()
);

-- The admin reads this newest-first, filtered per product. Without these it is
-- a full scan of a table that only ever grows.
create index if not exists idx_inventory_transactions_created_at
  on public.inventory_transactions (created_at desc);

create index if not exists idx_inventory_transactions_product
  on public.inventory_transactions (product_id, created_at desc);

create index if not exists idx_inventory_transactions_order
  on public.inventory_transactions (order_id)
  where order_id is not null;

-- ---------------------------------------------------------------------------
-- RLS: service-role only.
--
-- Stock levels and their history are internal business data -- they expose
-- purchasing volume and margins. No storefront visitor and no signed-in
-- customer has any reason to read them, so no policy is granted to anon or
-- authenticated. The admin reaches this through the service-role key, which
-- bypasses RLS, so enabling it here locks the table to server code without
-- breaking the admin.
-- ---------------------------------------------------------------------------
alter table public.inventory_transactions enable row level security;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
select
  to_regclass('public.inventory_transactions') is not null           as ledger_table_ok,
  (select count(*) >= 3 from pg_indexes
     where schemaname='public' and tablename='inventory_transactions') as indexes_ok,
  (select relrowsecurity from pg_class
     where oid = 'public.inventory_transactions'::regclass)           as rls_enabled_ok;
