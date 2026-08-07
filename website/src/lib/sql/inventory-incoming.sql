-- ---------------------------------------------------------------------------
-- Incoming inventory.
--
-- Additive and idempotent; safe to re-run. Nothing is deleted and no existing
-- quantity is changed.
--
-- WHY A SEPARATE COLUMN
-- Stock that has been ORDERED from a supplier is not stock you can sell. Adding
-- it to inventory_quantity on the purchase order would let customers buy vials
-- sitting in a van, and the first sign of trouble would be an order you cannot
-- fill.
--
-- So incoming is tracked apart and only moves into inventory_quantity when the
-- box is physically opened and the owner presses Receive. One number means
-- "sellable right now", the other means "expected".
-- ---------------------------------------------------------------------------

alter table if exists public.products
  add column if not exists incoming_quantity integer not null default 0;

alter table if exists public.product_doses
  add column if not exists incoming_quantity integer not null default 0;

-- Incoming can never be negative: it is a count of units expected, and a
-- negative expectation is a data error rather than a meaningful state. Enforced
-- in the database because the admin UI is not the only writer -- a future
-- import or script would otherwise be able to corrupt it silently.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_incoming_quantity_nonneg') then
    alter table public.products
      add constraint products_incoming_quantity_nonneg check (incoming_quantity >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'product_doses_incoming_quantity_nonneg') then
    alter table public.product_doses
      add constraint product_doses_incoming_quantity_nonneg check (incoming_quantity >= 0);
  end if;
end;
$$;

-- The "what is on its way" view the header counts. Partial, so it stays cheap
-- once most rows are back to zero.
create index if not exists idx_products_incoming
  on public.products (id) where incoming_quantity > 0;

create index if not exists idx_product_doses_incoming
  on public.product_doses (id) where incoming_quantity > 0;

-- ---------------------------------------------------------------------------
-- VERIFY -- all true.
-- ---------------------------------------------------------------------------
select
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='products'
       and column_name='incoming_quantity')                    as products_incoming_ok,
  (select count(*) = 1 from information_schema.columns
     where table_schema='public' and table_name='product_doses'
       and column_name='incoming_quantity')                    as doses_incoming_ok,
  (select count(*) = 2 from pg_constraint
     where conname in ('products_incoming_quantity_nonneg',
                       'product_doses_incoming_quantity_nonneg')) as constraints_ok;
