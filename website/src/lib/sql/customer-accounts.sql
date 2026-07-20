-- Phase 5: customer accounts.
--
-- public.orders has no user_id/auth link (checkout has always been
-- guest-friendly, keyed only on customer_email) - this adds an RLS policy
-- that lets a signed-in customer read their own order rows by matching
-- their JWT's email claim, alongside three new owner-scoped tables for
-- saved addresses, wishlist, and notification preferences.
--
-- The account pages (src/app/account/*) read orders via the service-role
-- client server-side, so they do not strictly depend on this RLS policy
-- today, but it is added for defense-in-depth and any future client-side
-- Supabase access, matching the pattern in orders-rls.sql.
--
-- Run after orders-rls.sql. Idempotent.

create or replace function public.current_auth_email()
returns text
language sql
stable
as $$
  select lower(auth.jwt() ->> 'email');
$$;

drop policy if exists orders_select_own on public.orders;
create policy orders_select_own on public.orders
for select
using (lower(customer_email) = (select public.current_auth_email()));

drop policy if exists order_items_select_own on public.order_items;
create policy order_items_select_own on public.order_items
for select
using (
  exists (
    select 1 from public.orders o
    where o.order_id = order_items.order_id
    and lower(o.customer_email) = (select public.current_auth_email())
  )
);

create table if not exists public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text,
  full_name text not null,
  address text not null,
  city text not null,
  postal_code text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_customer_addresses_user_id on public.customer_addresses(user_id);

alter table public.customer_addresses enable row level security;

drop policy if exists customer_addresses_owner on public.customer_addresses;
create policy customer_addresses_owner on public.customer_addresses
for all
using (user_id = (select public.current_auth_uid()))
with check (user_id = (select public.current_auth_uid()));

create table if not exists public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null,
  created_at timestamptz not null default now(),
  unique (user_id, product_slug)
);

create index if not exists idx_wishlist_items_user_id on public.wishlist_items(user_id);

alter table public.wishlist_items enable row level security;

drop policy if exists wishlist_items_owner on public.wishlist_items;
create policy wishlist_items_owner on public.wishlist_items
for all
using (user_id = (select public.current_auth_uid()))
with check (user_id = (select public.current_auth_uid()));

create table if not exists public.customer_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  order_update_emails boolean not null default true,
  marketing_emails boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.customer_preferences enable row level security;

drop policy if exists customer_preferences_owner on public.customer_preferences;
create policy customer_preferences_owner on public.customer_preferences
for all
using (user_id = (select public.current_auth_uid()))
with check (user_id = (select public.current_auth_uid()));
