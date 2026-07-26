-- ============================================================================
-- Inventory: enforce reservations whenever a REAL positive stock count exists.
--
-- Previously reserve_inventory only enforced when track_inventory = true, and
-- nothing ever set that flag — so the whole reservation/oversell-prevention
-- layer was dormant and concurrent last-unit checkouts could oversell. This:
--   1. Redefines reserve_inventory to enforce when track_inventory = true OR
--      inventory_quantity > 0 (a positive count is always protected). Items with
--      no positive count AND the flag off stay unenforced (unlimited / made-to-
--      order), exactly 0 with the flag on still blocks (explicitly out of stock).
--   2. Backfills track_inventory = true for every product/dose that currently
--      holds a positive stock count.
--   3. Locks the SECURITY DEFINER function down (REVOKE default PUBLIC execute).
--
-- Atomic + idempotent + self-expiring behavior is unchanged. Safe to re-run.
-- ============================================================================

create or replace function public.reserve_inventory(
  p_slug       text,
  p_variant_id text,
  p_order_id   text,
  p_quantity   integer,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing_status text;
  moved integer := 0;
  is_tracked boolean;
begin
  if p_quantity is null or p_quantity <= 0 then
    return true;
  end if;

  -- Idempotency: an active/finalized hold for this order line already exists
  -- (a refresh or retry) — never hold again or extend it.
  select status into existing_status
    from public.inventory_reservations
   where order_id = p_order_id
     and slug = p_slug
     and coalesce(variant_id, '') = coalesce(p_variant_id, '')
   limit 1;
  if existing_status in ('active', 'finalized') then
    return true;
  end if;

  -- Atomic gate: availability check + hold in a single row-locked statement, so
  -- concurrent checkouts serialize and the last unit is claimed exactly once.
  -- Enforced whenever the item is tracked OR carries a positive stock count.
  if p_variant_id is not null and p_variant_id <> '' then
    update public.product_doses
       set reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
     where id::text = p_variant_id
       and (track_inventory = true or inventory_quantity > 0)
       and inventory_quantity - reserved_quantity >= p_quantity;
    get diagnostics moved = row_count;
    if moved = 0 then
      select (track_inventory = true or inventory_quantity > 0) into is_tracked
        from public.product_doses where id::text = p_variant_id;
    end if;
  else
    update public.products
       set reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
     where slug = p_slug
       and (track_inventory = true or inventory_quantity > 0)
       and inventory_quantity - reserved_quantity >= p_quantity;
    get diagnostics moved = row_count;
    if moved = 0 then
      select (track_inventory = true or inventory_quantity > 0) into is_tracked
        from public.products where slug = p_slug;
    end if;
  end if;

  if moved > 0 then
    insert into public.inventory_reservations (order_id, slug, variant_id, quantity, status, expires_at)
      values (p_order_id, p_slug, nullif(p_variant_id, ''), p_quantity, 'active', p_expires_at)
      on conflict (order_id, slug, coalesce(variant_id, '')) do update
        set status = 'active', quantity = excluded.quantity, expires_at = excluded.expires_at, updated_at = now();
    return true;
  end if;

  -- moved = 0: unenforced (no positive count, flag off) => allow with no hold;
  -- enforced but insufficient (incl. a positive item sold down to < requested,
  -- or a tracked item at 0) => block.
  if is_tracked is not true then
    return true;
  end if;
  return false;
end;
$$;

revoke all on function public.reserve_inventory(text, text, text, integer, timestamptz) from public;
grant execute on function public.reserve_inventory(text, text, text, integer, timestamptz) to service_role;

-- Backfill: every product/dose that currently has real stock becomes tracked,
-- so the "out of stock at 0" behavior applies to it going forward too.
update public.products
   set track_inventory = true, updated_at = now()
 where inventory_quantity > 0 and track_inventory is not true;

update public.product_doses
   set track_inventory = true, updated_at = now()
 where inventory_quantity > 0 and track_inventory is not true;
