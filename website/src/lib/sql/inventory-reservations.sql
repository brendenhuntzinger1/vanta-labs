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
--
-- TRACKED vs UNTRACKED is an EXPLICIT flag (track_inventory), NOT a count of 0.
-- A tracked item is enforced at every level including exactly 0 (sold out); an
-- untracked item (3PL-authority catalog, the default) is never held or blocked
-- and stays freely purchasable. To start enforcing a real count on a product or
-- dose, set track_inventory = true and its inventory_quantity.
--
-- Idempotent: a page refresh or duplicate checkout request for the same order
-- line never double-holds or extends the hold. Safe to run more than once.
-- ============================================================================

alter table public.products      add column if not exists reserved_quantity integer not null default 0;
alter table public.product_doses add column if not exists reserved_quantity integer not null default 0;
alter table public.products      add column if not exists track_inventory boolean not null default false;
alter table public.product_doses add column if not exists track_inventory boolean not null default false;

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

-- One hold per (order, line): the idempotency backstop for retries/refreshes.
create unique index if not exists inventory_reservations_order_line_key
  on public.inventory_reservations (order_id, slug, coalesce(variant_id, ''));

create index if not exists inventory_reservations_active_expiry
  on public.inventory_reservations (status, expires_at);

-- ----------------------------------------------------------------------------
-- reserve_inventory: hold ONE line atomically.
--   true  => held, OR the item is untracked (track_inventory = false)
--   false => a TRACKED item with insufficient available stock (incl. sold out)
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
  -- Only TRACKED items are enforced (track_inventory = true), at every level
  -- including exactly 0.
  if p_variant_id is not null and p_variant_id <> '' then
    update public.product_doses
       set reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
     where id::text = p_variant_id
       and track_inventory = true
       and inventory_quantity - reserved_quantity >= p_quantity;
    get diagnostics moved = row_count;
    if moved = 0 then
      select track_inventory into is_tracked from public.product_doses where id::text = p_variant_id;
    end if;
  else
    update public.products
       set reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
     where slug = p_slug
       and track_inventory = true
       and inventory_quantity - reserved_quantity >= p_quantity;
    get diagnostics moved = row_count;
    if moved = 0 then
      select track_inventory into is_tracked from public.products where slug = p_slug;
    end if;
  end if;

  if moved > 0 then
    insert into public.inventory_reservations (order_id, slug, variant_id, quantity, status, expires_at)
      values (p_order_id, p_slug, nullif(p_variant_id, ''), p_quantity, 'active', p_expires_at)
      on conflict (order_id, slug, coalesce(variant_id, '')) do update
        set status = 'active', quantity = excluded.quantity, expires_at = excluded.expires_at, updated_at = now();
    return true;
  end if;

  -- moved = 0: untracked => allow with no hold; tracked but insufficient (incl.
  -- a sold-to-0 item) => block.
  if is_tracked is not true then
    return true;
  end if;
  return false;
end;
$$;

-- ----------------------------------------------------------------------------
-- finalize_inventory_for_order: a verified payment permanently deducts every
-- active hold for the order (idempotent — a replay finds them 'finalized').
-- Marks a tracked item Out of Stock when it reaches 0. Returns the number of
-- lines whose stock actually moved (a deleted product/dose counts as 0 so the
-- caller's fallback decrement can still cover it).
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
  line_moved integer := 0;
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
             stock_status = case when inventory_quantity - r.quantity <= 0 and track_inventory then 'Out of Stock' else stock_status end,
             updated_at = now()
       where id::text = r.variant_id;
      get diagnostics line_moved = row_count;
    else
      update public.products
         set inventory_quantity = greatest(0, inventory_quantity - r.quantity),
             reserved_quantity  = greatest(0, reserved_quantity  - r.quantity),
             stock_status = case when inventory_quantity - r.quantity <= 0 and track_inventory then 'Out of Stock' else stock_status end,
             updated_at = now()
       where slug = r.slug;
      get diagnostics line_moved = row_count;
    end if;
    -- The hold is consumed regardless (order is paid); only count lines that
    -- actually moved stock, so a deleted product doesn't suppress the fallback.
    update public.inventory_reservations set status = 'finalized', updated_at = now() where id = r.id;
    if line_moved > 0 then
      n := n + 1;
    end if;
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
-- expire_stale_reservations: release every active hold past its expiry (called
-- by the scheduled sweep). SKIP LOCKED so it never blocks a live checkout, and
-- it NEVER touches a hold whose order is already paid/settling — that order's
-- holds are being finalized, so releasing one would under-deduct its stock.
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
    select res.id, res.slug, res.variant_id, res.quantity
      from public.inventory_reservations res
     where res.status = 'active' and res.expires_at < now()
       and not exists (
         select 1 from public.orders o
          where o.order_id = res.order_id
            and o.payment_status in ('paid', 'partially_refunded')
       )
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

-- ---------------------------------------------------------------------------
-- I-11 — close these to anon on creation, rather than sweeping up afterwards.
--
-- Supabase's default privilege grants EXECUTE on every function created in
-- `public` to `anon` and `authenticated`. A SECURITY DEFINER function is
-- therefore reachable by anyone holding the public anon key the moment it
-- exists. That is exactly how `create_partner_invite` became an
-- unauthenticated, RLS-bypassing write into the affiliate money tables (I-07).
--
-- Production is currently clean, because migration 20260825003037 swept every
-- function that existed at that moment. But a sweep is point-in-time and the
-- default is still armed — HALF of it cannot even be disarmed from this
-- project's access (see sql/rpc-default-privilege-lockdown.sql for the proof).
-- So re-running this file in a fresh environment would create these
-- world-executable, and the sweep would have to be remembered again.
--
-- rpc-security-posture.test.ts fails the build if a new function arrives here
-- without one of these lines.
-- ---------------------------------------------------------------------------
revoke all on function public.expire_stale_reservations() from public, anon, authenticated;
grant execute on function public.expire_stale_reservations() to service_role;
revoke all on function public.finalize_inventory_for_order(text) from public, anon, authenticated;
grant execute on function public.finalize_inventory_for_order(text) to service_role;
revoke all on function public.release_inventory_for_order(text) from public, anon, authenticated;
grant execute on function public.release_inventory_for_order(text) to service_role;
revoke all on function public.reserve_inventory(text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_inventory(text, text, text, integer, timestamptz) to service_role;
