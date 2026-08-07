-- ---------------------------------------------------------------------------
-- VANTA LABS — SECOND ADDRESS LINE (apartment / suite / unit)
--
-- Additive, idempotent, nullable. Nothing is read, changed or removed, and no
-- existing query needs to know this column exists.
--
-- WHY
-- Checkout captured one free-text address line, so an apartment number had to
-- be typed into the street field or not at all. Carriers do not reject that --
-- they accept it and attempt delivery -- which is exactly the problem: the
-- parcel reaches the building, finds no unit number, and comes back. The cost
-- is a return, a refund and a re-ship, and it surfaces a week later.
--
-- Nullable with no default, deliberately. Every order placed before this column
-- existed genuinely has no second line, and an empty string would be
-- indistinguishable from "the shopper left it blank" -- which matters because
-- Shippo treats a blank street2 as a validation failure and the sync omits the
-- field entirely when it is empty.
-- ---------------------------------------------------------------------------

alter table if exists public.orders
  add column if not exists shipping_address_2 text;

comment on column public.orders.shipping_address_2 is
  'Apartment / suite / unit. Sent to Shippo as address_to.street2; omitted when blank.';

-- ---------------------------------------------------------------------------
-- VERIFY — one row, true.
-- ---------------------------------------------------------------------------
select exists (
  select 1 from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'orders'
     and column_name  = 'shipping_address_2'
) as shipping_address_2_ok;
