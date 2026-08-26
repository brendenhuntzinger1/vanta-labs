-- ===========================================================================
-- G-02 + G-04/I-12 + K-17 — make returning stock possible at all.
--
-- THREE FINDINGS, ONE MISSING PAIR. Verified against production this session:
--
--   orders.inventory_restocked_at   ABSENT   (information_schema.columns)
--   adjust_inventory_on_sale        ABSENT   (pg_proc, every schema — 22 functions
--                                             exist in public and this is not one)
--
-- G-02  `restockInventoryForOrder` is gated behind `claimInventoryRestock`,
--       which flips `orders.inventory_restocked_at` from NULL. The column is not
--       there, so the claim errors 42703 and — by its own documented fail-safe —
--       returns false, and the caller does not restock. The safe branch is the
--       ONLY branch that ever runs. Inventory tracking is ON in production, so
--       every refund and every cancellation permanently destroys its units and
--       the product reads "Out of Stock" while sitting on the shelf.
--
-- G-04  `applyInventoryDelta` calls `adjust_inventory_on_sale`, which does not
--       exist, so even a claim that succeeded would move nothing.
--       (I-12 filed this as "paid orders never decrement stock". That is NOT
--       true — the paid path decrements through `finalize_inventory_for_order`,
--       which production does have. This function is only the FALLBACK, and the
--       return path.)
--
-- K-17  `returnInventoryForCancelledOrder` — added to fix "cancelling a paid
--       order permanently destroys its stock" — routes through BOTH of the
--       above. That fix is currently inert in production, twice over. Block K
--       had no database and could not have seen it.
--
-- So one migration closes all three, and none of them closes without it.
--
-- WHY THE FUNCTION IS NOT COPIED VERBATIM FROM deploy-run-once.sql:941.
-- That definition moves `inventory_quantity` and nothing else. On the way DOWN
-- that is fine. On the way UP it is a bug: `finalize_inventory_for_order` stamps
-- `stock_status = 'Out of Stock'` when a sale empties a line, and nothing would
-- ever stamp it back — so a refunded unit would return to the shelf with the
-- count correct and the storefront still refusing to sell it.
--
-- The repository already answers this, in `inventory-operations.ts:102-108`,
-- for the admin receive-stock path:
--
--     "Move the STATUS with the quantity, or receiving a shipment does not put
--      the product back on sale. … Only the automatic pair is touched.
--      'Limited' and 'Reserved' are set deliberately in the product editor and
--      must survive a stock movement."
--
-- The same rule is applied here, so the two paths cannot disagree.
--
-- BLAST RADIUS. One nullable column, one partial index, one new function. No
-- existing row changes. The claim column starts NULL everywhere, which means
-- "not yet restocked" — correct for every historical order, including the ones
-- that were refunded and never restocked. Those are NOT retroactively adjusted:
-- see the note at the bottom.
-- ===========================================================================

-- ---- 1. the exactly-once restock claim -----------------------------------
alter table public.orders
  add column if not exists inventory_restocked_at timestamptz;

comment on column public.orders.inventory_restocked_at is
  'Set once, by whichever refund/cancellation first claims the restock. NULL '
  'means stock has not been returned for this order. Mirrors '
  'paid_side_effects_at: the claim is the update itself, so a concurrent or '
  'duplicate refund cannot return the same units twice.';

-- Only unclaimed orders are ever looked up by it.
create index if not exists orders_inventory_restock_pending_idx
  on public.orders (order_id)
  where inventory_restocked_at is null;

-- ---- 2. the delta function, with the status rule -------------------------
create or replace function public.adjust_inventory_on_sale(
  p_slug text,
  p_variant_id text,
  p_qty integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  moved integer;
begin
  if p_qty is null or p_qty = 0 then
    return false;
  end if;

  if p_variant_id is not null and p_variant_id <> '' then
    update public.product_doses
       set inventory_quantity = inventory_quantity + p_qty,
           -- Move the status with the quantity, but only the automatic pair.
           -- 'Limited' and 'Reserved' are deliberate editorial states and must
           -- survive a stock movement (inventory-operations.ts:102-108).
           stock_status = case
             when stock_status in ('In Stock', 'Out of Stock')
               then case when inventory_quantity + p_qty > 0 then 'In Stock' else 'Out of Stock' end
             else stock_status
           end,
           updated_at = now()
     where id::text = p_variant_id
       -- Never below zero. A delta that would go negative applies to nothing,
       -- which is what makes the decrement safe under concurrency.
       and inventory_quantity + p_qty >= 0;
    get diagnostics moved = row_count;
  else
    update public.products
       set inventory_quantity = inventory_quantity + p_qty,
           stock_status = case
             when stock_status in ('In Stock', 'Out of Stock')
               then case when inventory_quantity + p_qty > 0 then 'In Stock' else 'Out of Stock' end
             else stock_status
           end,
           updated_at = now()
     where slug = p_slug
       and inventory_quantity + p_qty >= 0;
    get diagnostics moved = row_count;
  end if;

  return moved > 0;
end;
$$;

do $rpc_lockdown$
begin
  -- Guarded so this file also runs against a throwaway Postgres: anon,
  -- authenticated and service_role are Supabase-managed roles that do not exist
  -- in a bare cluster. Without this, a database-backed test executing this file
  -- dies on the grant rather than on whatever it was testing.
  if exists (select 1 from pg_roles where rolname='anon') then
    execute $q$revoke all on function public.adjust_inventory_on_sale(text, text, integer) from public, anon, authenticated;$q$;
  end if;
  if exists (select 1 from pg_roles where rolname='service_role') then
    execute $q$grant execute on function public.adjust_inventory_on_sale(text, text, integer) to service_role;$q$;
  end if;
end
$rpc_lockdown$;


-- ---- 3. what is NOT done here --------------------------------------------
-- Historical refunds are not replayed. Any order refunded before this runs has
-- already lost its units, and inventory_restocked_at will be NULL for it — which
-- reads as "not restocked" and is true. Restoring those counts is a data
-- decision (which orders, and does the physical shelf agree?), not a migration.
-- Production has 15 orders; the affected set is small enough to inspect by hand.
--
-- To see it:
--   select order_id, payment_status, refund_amount
--   from public.orders
--   where payment_status in ('refunded','partially_refunded','canceled','cancelled');
