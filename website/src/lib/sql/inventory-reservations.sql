-- ============================================================================
-- Enterprise inventory reservation.
--
-- Holds stock atomically the instant a checkout/payment session is created (an
-- order row exists), releases it automatically on failure/cancel/expiry, and
-- permanently deducts it only on a verified paid webhook. Concurrent customers
-- can NEVER oversell: the hold is a single row-locked conditional UPDATE, so at
-- the last unit exactly one checkout wins.
--
-- Model: available = inventory_quantity - reserved_quantity.
--   reserve()  : reserved_quantity += qty   (checkout begins)
--   finalize() : inventory_quantity -= qty, reserved_quantity -= qty   (paid)
--   release()  : reserved_quantity -= qty   (fail / cancel / expire)
-- An UNTRACKED item (inventory_quantity <= 0, i.e. 3PL-authority catalog) is
-- never held or blocked — it stays freely purchasable, exactly as today.
--
-- Idempotent: a page refresh or duplicate checkout request for the same order
-- line never double-holds or extends the hold. Safe to run more than once.
-- ============================================================================

alter table public.products      add column if not exists reserved_quantity integer not null default 0;
alter table public.product_doses add column if not exists reserved_quantity integer not null default 0;

create table if not exists public.inventory_reservations (
  id          uuid primary key default gen_random_uuid(),
  order_id    text not null,
  slug        text not null,
  variant_id  text,
  quantity    integer not null check (quantity > 0),
  status      text not null default 'active',   -- active | finalized | released
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One hold per (order, line). coalesce() makes the nullable variant part of the
-- key so a product-level line can't be inserted twice — this is the idempotency
-- backstop for retries/refreshes.
create unique index if not exists inventory_reservations_order_line_key
  on public.inventory_reservations (order_id, slug, coalesce(variant_id, ''));

create index if not exists inventory_reservations_active_expiry
  on public.inventory_reservations (status, expires_at);

-- ----------------------------------------------------------------------------
-- reserve_inventory: hold ONE line atomically.
--   returns true  => held, OR the item is untracked (nothing to hold)
--   returns false => tracked item with insufficient available stock (blocked)
-- ----------------------------------------------------------------------------
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
  inv integer;
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

  -- Atomic gate: the WHERE clause makes the availability check and the hold a
  -- single row-locked statement, so concurrent checkouts serialize and the last
  -- unit is claimed exactly once. Only positive tracked counts are enforced.
  if p_variant_id is not null and p_variant_id <> '' then
    update public.product_doses
       set reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
     where id::text = p_variant_id
       and inventory_quantity > 0
       and inventory_quantity - reserved_quantity >= p_quantity;
    get diagnostics moved = row_count;
    if moved = 0 then
      select inventory_quantity into inv from public.product_doses where id::text = p_variant_id;
    end if;
  else
    update public.products
       set reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
     where slug = p_slug
       and inventory_quantity > 0
       and inventory_quantity - reserved_quantity >= p_quantity;
    get diagnostics moved = row_count;
    if moved = 0 then
      select inventory_quantity into inv from public.products where slug = p_slug;
    end if;
  end if;

  if moved > 0 then
    insert into public.inventory_reservations (order_id, slug, variant_id, quantity, status, expires_at)
      values (p_order_id, p_slug, nullif(p_variant_id, ''), p_quantity, 'active', p_expires_at)
      on conflict (order_id, slug, coalesce(variant_id, '')) do update
        set status = 'active', quantity = excluded.quantity, expires_at = excluded.expires_at, updated_at = now();
    return true;
  end if;

  -- moved = 0: untracked (no positive count) => allow with no hold;
  --            tracked but insufficient => block.
  if inv is null or inv <= 0 then
    return true;
  end if;
  return false;
end;
$$;

-- ----------------------------------------------------------------------------
-- finalize_inventory_for_order: a verified payment permanently deducts every
-- active hold for the order (idempotent — a replay finds them 'finalized').
-- Returns the number of lines finalized.
-- ----------------------------------------------------------------------------
create or replace function public.finalize_inventory_for_order(p_order_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select id, slug, variant_id, quantity
      from public.inventory_reservations
     where order_id = p_order_id and status = 'active'
     for update
  loop
    if r.variant_id is not null and r.variant_id <> '' then
      update public.product_doses
         set inventory_quantity = greatest(0, inventory_quantity - r.quantity),
             reserved_quantity  = greatest(0, reserved_quantity  - r.quantity),
             updated_at = now()
       where id::text = r.variant_id;
    else
      update public.products
         set inventory_quantity = greatest(0, inventory_quantity - r.quantity),
             reserved_quantity  = greatest(0, reserved_quantity  - r.quantity),
             updated_at = now()
       where slug = r.slug;
    end if;
    update public.inventory_reservations set status = 'finalized', updated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ----------------------------------------------------------------------------
-- release_inventory_for_order: return every active hold for the order (failed /
-- canceled / abandoned checkout). Idempotent; returns the number released.
-- ----------------------------------------------------------------------------
create or replace function public.release_inventory_for_order(p_order_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select id, slug, variant_id, quantity
      from public.inventory_reservations
     where order_id = p_order_id and status = 'active'
     for update
  loop
    if r.variant_id is not null and r.variant_id <> '' then
      update public.product_doses
         set reserved_quantity = greatest(0, reserved_quantity - r.quantity), updated_at = now()
       where id::text = r.variant_id;
    else
      update public.products
         set reserved_quantity = greatest(0, reserved_quantity - r.quantity), updated_at = now()
       where slug = r.slug;
    end if;
    update public.inventory_reservations set status = 'released', updated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ----------------------------------------------------------------------------
-- expire_stale_reservations: release every active hold past its expiry. Called
-- by the scheduled sweep. SKIP LOCKED so it never blocks a live checkout.
-- Returns the number expired.
-- ----------------------------------------------------------------------------
create or replace function public.expire_stale_reservations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select id, slug, variant_id, quantity
      from public.inventory_reservations
     where status = 'active' and expires_at < now()
     for update skip locked
  loop
    if r.variant_id is not null and r.variant_id <> '' then
      update public.product_doses
         set reserved_quantity = greatest(0, reserved_quantity - r.quantity), updated_at = now()
       where id::text = r.variant_id;
    else
      update public.products
         set reserved_quantity = greatest(0, reserved_quantity - r.quantity), updated_at = now()
       where slug = r.slug;
    end if;
    update public.inventory_reservations set status = 'released', updated_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

grant execute on function public.reserve_inventory(text, text, text, integer, timestamptz) to service_role;
grant execute on function public.finalize_inventory_for_order(text) to service_role;
grant execute on function public.release_inventory_for_order(text) to service_role;
grant execute on function public.expire_stale_reservations() to service_role;
