-- ===========================================================================
-- INVENTORY RESET — DESTRUCTIVE. DO NOT RUN UNTIL END-TO-END TESTING IS DONE.
-- ===========================================================================
--
-- Sets every product and dose quantity to 0 so real counts can be entered from
-- a clean slate, without the numbers the former 3PL supplied.
--
-- WHY THIS IS HELD BACK
-- Zeroing inventory makes products unpurchasable the moment enforcement is on,
-- which would block the test order that has to be placed first. Run it AFTER
-- the end-to-end test passes, immediately before entering real counts.
--
-- WHAT IT DOES NOT TOUCH -- verify this yourself before running:
--   * no product is deleted; names, prices, images, descriptions, SKUs,
--     variants and weights are all untouched
--   * no order, order item, payment, refund or customer row is read or written
--   * no account, membership or ambassador data is involved
--   * shipping_weight_oz is NOT reset -- weighing is separate work and losing
--     it would silently misprice postage on every order afterwards
--
-- RUN THE SECTIONS IN ORDER. Section 1 changes nothing.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- SECTION 1 — DRY RUN. Read-only. Run this FIRST and read the output.
--
-- Shows exactly what section 3 would change. If these numbers surprise you,
-- stop.
-- ---------------------------------------------------------------------------
select
  'products'                                              as table_name,
  count(*)                                                as rows_total,
  count(*) filter (where coalesce(inventory_quantity,0) <> 0) as rows_that_would_change,
  coalesce(sum(inventory_quantity), 0)                    as units_to_be_cleared
from public.products
union all
select
  'product_doses',
  count(*),
  count(*) filter (where coalesce(inventory_quantity,0) <> 0),
  coalesce(sum(inventory_quantity), 0)
from public.product_doses;


-- ---------------------------------------------------------------------------
-- SECTION 2 — SAFETY CHECK. Read-only.
--
-- Confirms nothing is mid-flight. A non-zero count here means stock is
-- RESERVED for an order that is paid but not yet shipped: zeroing now would
-- destroy the record of goods already sold and owed to a customer.
--
-- If either number is above zero, ship or cancel those orders first.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.orders
    where payment_status = 'paid'
      and coalesce(fulfillment_status,'') not in
          ('delivered','cancelled','refunded','returned','shipped'))  as unshipped_paid_orders,
  (select count(*) from public.inventory_reservations
    where status = 'active')                                          as active_reservations;


-- ---------------------------------------------------------------------------
-- SECTION 3 — THE RESET. Run only after 1 and 2 look right.
--
-- Every statement is scoped to the quantity columns alone. There is no DELETE
-- anywhere in this file by design: a product with zero stock is a product you
-- can still sell tomorrow, whereas a deleted one takes its price history,
-- images and COA links with it.
--
-- The `where` clauses make this idempotent and keep the ledger honest — a row
-- already at 0 is not rewritten, so re-running does not generate a second wave
-- of no-op audit entries.
-- ---------------------------------------------------------------------------

-- Record what is about to be cleared, BEFORE clearing it. Written first so the
-- ledger keeps the pre-reset quantity even though the update follows.
insert into public.inventory_transactions
  (product_id, dose_id, sku, transaction_type, delta, quantity_before, quantity_after, reason, actor)
select
  p.id::text, null, null, 'correction',
  -coalesce(p.inventory_quantity, 0), coalesce(p.inventory_quantity, 0), 0,
  'Inventory reset — clearing counts inherited from the previous fulfillment provider',
  'inventory_reset'
from public.products p
where coalesce(p.inventory_quantity, 0) <> 0;

insert into public.inventory_transactions
  (product_id, dose_id, sku, transaction_type, delta, quantity_before, quantity_after, reason, actor)
select
  d.product_id::text, d.id::text, d.sku, 'correction',
  -coalesce(d.inventory_quantity, 0), coalesce(d.inventory_quantity, 0), 0,
  'Inventory reset — clearing counts inherited from the previous fulfillment provider',
  'inventory_reset'
from public.product_doses d
where coalesce(d.inventory_quantity, 0) <> 0;

update public.products
   set inventory_quantity = 0,
       updated_at = now()
 where coalesce(inventory_quantity, 0) <> 0;

update public.product_doses
   set inventory_quantity = 0,
       updated_at = now()
 where coalesce(inventory_quantity, 0) <> 0;

-- Stock status is deliberately NOT forced to 'Out of Stock'.
--
-- While enforcement is off, resolveStockStatus() in src/lib/catalog.ts already
-- reports everything as In Stock regardless of this column, so writing it would
-- change nothing visible. Once enforcement is turned on, quantity is what
-- gates the sale. Setting it here would only clobber deliberate 'Limited' and
-- 'Reserved' values the product editor uses.


-- ---------------------------------------------------------------------------
-- SECTION 4 — VERIFY. Read-only. Both counts must be 0.
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.products      where coalesce(inventory_quantity,0) <> 0) as products_left,
  (select count(*) from public.product_doses where coalesce(inventory_quantity,0) <> 0) as doses_left,
  (select count(*) from public.inventory_transactions where actor = 'inventory_reset')  as reset_rows_logged;
