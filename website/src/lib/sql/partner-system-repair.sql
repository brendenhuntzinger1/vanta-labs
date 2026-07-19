-- Partner system repair migration
-- Safe to run repeatedly.

-- Canonical affiliate tables
create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  name text not null,
  email text,
  referral_code text not null unique,
  status text not null default 'pending',
  commission_percent numeric(5,2) not null default 10,
  invited_at timestamptz,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  referral_code text not null,
  event_type text not null default 'click',
  order_id text,
  landing_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

create table if not exists public.commissions (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  order_id text not null unique,
  referral_code text,
  commission_percent numeric(5,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.partners(id) on delete cascade,
  amount numeric(12,2) not null,
  note text,
  processed_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.partner_program_stats (
  key text primary key,
  value_numeric numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

-- Compatibility / existing tables used by current app
create table if not exists public.ambassadors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  referral_code text not null unique,
  status text not null default 'pending',
  commission_percent numeric(5,2) not null default 10,
  auth_user_id uuid,
  invited_at timestamptz,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.partner_clicks (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null,
  referral_code text not null,
  landing_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  referrer text,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

create table if not exists public.partner_payouts (
  id uuid primary key default gen_random_uuid(),
  ambassador_id uuid not null,
  amount numeric(12,2) not null,
  note text,
  processed_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  target_table text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_credentials (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_salt text not null,
  password_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_login_attempts (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  ip_address text,
  user_agent text,
  success boolean not null default false,
  attempted_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category text not null,
  short_description text,
  long_description text,
  price_cents integer not null default 0,
  compare_at_price_cents integer not null default 0,
  sale_price_cents integer not null default 0,
  inventory_quantity integer not null default 0,
  sku text,
  is_published boolean not null default false,
  is_enabled boolean not null default true,
  is_archived boolean not null default false,
  is_featured boolean not null default false,
  badge text,
  position integer not null default 0,
  stock_status text not null default 'In Stock',
  batch_number text,
  purity_result text,
  description text,
  image_url text,
  testing_date date,
  lab_name text,
  coa_url text,
  molecular_formula text,
  seo_title text,
  seo_description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  image_url text not null,
  alt_text text,
  is_primary boolean not null default false,
  is_enabled boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_doses (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  label text not null,
  slug_suffix text not null,
  sku text,
  price_cents integer not null default 0,
  compare_at_price_cents integer not null default 0,
  sale_price_cents integer not null default 0,
  inventory_quantity integer not null default 0,
  stock_status text not null default 'In Stock',
  batch_number text,
  coa_url text,
  image_url text,
  purity_result text,
  is_default boolean not null default false,
  is_enabled boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, slug_suffix)
);

alter table if exists public.products
  add column if not exists slug text,
  add column if not exists name text,
  add column if not exists category text,
  add column if not exists short_description text,
  add column if not exists long_description text,
  add column if not exists price_cents integer not null default 0,
  add column if not exists compare_at_price_cents integer not null default 0,
  add column if not exists sale_price_cents integer not null default 0,
  add column if not exists inventory_quantity integer not null default 0,
  add column if not exists sku text,
  add column if not exists is_published boolean not null default false,
  add column if not exists is_enabled boolean not null default true,
  add column if not exists is_archived boolean not null default false,
  add column if not exists is_featured boolean not null default false,
  add column if not exists badge text,
  add column if not exists position integer not null default 0,
  add column if not exists stock_status text not null default 'In Stock',
  add column if not exists batch_number text,
  add column if not exists purity_result text,
  add column if not exists description text,
  add column if not exists image_url text,
  add column if not exists testing_date date,
  add column if not exists lab_name text,
  add column if not exists coa_url text,
  add column if not exists molecular_formula text,
  add column if not exists seo_title text,
  add column if not exists seo_description text,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.product_images
  add column if not exists image_url text,
  add column if not exists alt_text text,
  add column if not exists is_primary boolean not null default false,
  add column if not exists is_enabled boolean not null default true,
  add column if not exists position integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.product_doses
  add column if not exists label text,
  add column if not exists slug_suffix text,
  add column if not exists sku text,
  add column if not exists price_cents integer not null default 0,
  add column if not exists compare_at_price_cents integer not null default 0,
  add column if not exists sale_price_cents integer not null default 0,
  add column if not exists inventory_quantity integer not null default 0,
  add column if not exists stock_status text not null default 'In Stock',
  add column if not exists batch_number text,
  add column if not exists coa_url text,
  add column if not exists image_url text,
  add column if not exists purity_result text,
  add column if not exists is_default boolean not null default false,
  add column if not exists is_enabled boolean not null default true,
  add column if not exists position integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.admin_credentials
  add column if not exists username text,
  add column if not exists password_salt text,
  add column if not exists password_hash text,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.admin_sessions
  add column if not exists username text,
  add column if not exists token_hash text,
  add column if not exists expires_at timestamptz,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists created_at timestamptz not null default now();

alter table if exists public.admin_login_attempts
  add column if not exists username text,
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists success boolean not null default false,
  add column if not exists attempted_at timestamptz not null default now();

insert into public.admin_credentials (username, password_salt, password_hash, is_active, updated_at)
values (
  'q7m.vr91xk_admin',
  'e78b29be7a79956208490c779348c966',
  '4a8a6af70ef5ba96d54e205ba448c8c58c7b285b9cd4429fcae2bdd2c69d6c696392dde65b0c9a6d82e66bcfe2dbdb9d3ec311cef9a8f7dba6077812b8fe25f1',
  true,
  now()
)
on conflict (username)
do update set
  password_salt = excluded.password_salt,
  password_hash = excluded.password_hash,
  is_active = true,
  updated_at = now();

-- Ensure required columns exist for legacy table shapes
alter table if exists public.partners
  add column if not exists auth_user_id uuid,
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists referral_code text,
  add column if not exists status text not null default 'pending',
  add column if not exists commission_percent numeric(5,2) not null default 10,
  add column if not exists invited_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.ambassadors
  add column if not exists auth_user_id uuid,
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists referral_code text,
  add column if not exists status text not null default 'pending',
  add column if not exists commission_percent numeric(5,2) not null default 10,
  add column if not exists invited_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists disabled_at timestamptz,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Create core order tables if this is a fresh database
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  payment_id text,
  customer_email text,
  customer_name text,
  shipping_address text,
  city text,
  postal_code text,
  currency text not null default 'USD',
  subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  referral_code text,
  ambassador_id uuid,
  payment_status text not null default 'pending_payment',
  fulfillment_status text not null default 'pending',
  tracking_number text,
  paid_at timestamptz,
  provider_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.orders(order_id) on delete cascade,
  product_id text,
  product_name text,
  unit_price numeric(12,2) not null default 0,
  quantity integer not null default 0,
  line_total numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_events (
  event_id text primary key,
  order_id text not null,
  status text not null,
  processed_at timestamptz not null default now()
);

-- Ensure required columns exist
alter table if exists public.orders
  add column if not exists referral_code text,
  add column if not exists ambassador_id uuid,
  add column if not exists payment_status text not null default 'pending_payment',
  add column if not exists amount_paid numeric(12,2) not null default 0,
  add column if not exists created_at timestamptz not null default now();

create table if not exists public.referral_orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  ambassador_id uuid,
  referral_code text,
  commission_percent numeric(5,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  payment_id text,
  payment_status text not null default 'pending',
  approved_for_payout_at timestamptz,
  commission_paid_at timestamptz,
  reversed_at timestamptz,
  provider_event_id text,
  review_required boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.referral_orders
  add column if not exists ambassador_id uuid,
  add column if not exists referral_code text,
  add column if not exists commission_percent numeric(5,2) not null default 0,
  add column if not exists commission_amount numeric(12,2) not null default 0,
  add column if not exists amount_paid numeric(12,2) not null default 0,
  add column if not exists payment_id text,
  add column if not exists payment_status text not null default 'pending',
  add column if not exists approved_for_payout_at timestamptz,
  add column if not exists commission_paid_at timestamptz,
  add column if not exists reversed_at timestamptz,
  add column if not exists provider_event_id text,
  add column if not exists review_required boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.referral_orders
set payment_status = 'paid', commission_paid_at = coalesce(commission_paid_at, now())
where payment_status = 'commission_paid';

update public.commissions
set status = 'paid', updated_at = now()
where status = 'commission_paid';

-- Indexes
create index if not exists idx_partners_status on public.partners(status);
create index if not exists idx_partners_auth_user_id on public.partners(auth_user_id);
create index if not exists idx_partners_referral_code on public.partners(referral_code);
create index if not exists idx_referrals_partner_id on public.referrals(partner_id);
create index if not exists idx_referrals_order_id on public.referrals(order_id);
create index if not exists idx_commissions_partner_id on public.commissions(partner_id);
create index if not exists idx_commissions_status on public.commissions(status);
create index if not exists idx_payouts_partner_id on public.payouts(partner_id);
create unique index if not exists idx_products_slug on public.products(slug);
create index if not exists idx_products_is_active on public.products(is_active);
create index if not exists idx_products_category on public.products(category);
create index if not exists idx_products_position on public.products(position);
create index if not exists idx_products_is_published on public.products(is_published);
create index if not exists idx_products_is_enabled on public.products(is_enabled);
create index if not exists idx_products_is_archived on public.products(is_archived);
create unique index if not exists idx_admin_credentials_username on public.admin_credentials(username);
create unique index if not exists idx_admin_sessions_token_hash on public.admin_sessions(token_hash);
create index if not exists idx_admin_sessions_expires_at on public.admin_sessions(expires_at);
create index if not exists idx_admin_login_attempts_username_attempted_at on public.admin_login_attempts(username, attempted_at desc);
create index if not exists idx_admin_login_attempts_ip_attempted_at on public.admin_login_attempts(ip_address, attempted_at desc);
create index if not exists idx_product_images_product_id on public.product_images(product_id);
create index if not exists idx_product_images_position on public.product_images(position);
create index if not exists idx_product_doses_product_id on public.product_doses(product_id);
create index if not exists idx_product_doses_position on public.product_doses(position);
create unique index if not exists idx_product_doses_product_slug_suffix on public.product_doses(product_id, slug_suffix);
create index if not exists idx_ambassadors_referral_code on public.ambassadors(referral_code);
create index if not exists idx_ambassadors_auth_user_id on public.ambassadors(auth_user_id);
create index if not exists idx_partner_clicks_ambassador_id on public.partner_clicks(ambassador_id);
create index if not exists idx_partner_payouts_ambassador_id on public.partner_payouts(ambassador_id);
create index if not exists idx_referral_orders_ambassador_id on public.referral_orders(ambassador_id);
create index if not exists idx_referral_orders_order_id on public.referral_orders(order_id);
create index if not exists idx_orders_ambassador_id on public.orders(ambassador_id);
create index if not exists idx_orders_referral_code on public.orders(referral_code);

-- RLS enablement
alter table public.partners enable row level security;
alter table public.referrals enable row level security;
alter table public.commissions enable row level security;
alter table public.payouts enable row level security;
alter table public.partner_program_stats enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.product_doses enable row level security;
alter table public.ambassadors enable row level security;
alter table public.partner_clicks enable row level security;
alter table public.partner_payouts enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.admin_credentials enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_login_attempts enable row level security;
alter table public.referral_orders enable row level security;

-- Core policies for canonical tables
drop policy if exists partners_select_owner_or_admin on public.partners;
create policy partners_select_owner_or_admin on public.partners
for select using (auth.uid() = auth_user_id or auth.jwt() ->> 'role' = 'admin');

drop policy if exists partners_insert_admin on public.partners;
create policy partners_insert_admin on public.partners
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partners_update_admin on public.partners;
create policy partners_update_admin on public.partners
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists referrals_select_owner_or_admin on public.referrals;
create policy referrals_select_owner_or_admin on public.referrals
for select using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists referrals_insert_any on public.referrals;
create policy referrals_insert_any on public.referrals
for insert with check (true);

drop policy if exists commissions_select_owner_or_admin on public.commissions;
create policy commissions_select_owner_or_admin on public.commissions
for select using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists commissions_insert_admin on public.commissions;
create policy commissions_insert_admin on public.commissions
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists commissions_update_admin on public.commissions;
create policy commissions_update_admin on public.commissions
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists payouts_select_owner_or_admin on public.payouts;
create policy payouts_select_owner_or_admin on public.payouts
for select using (
  partner_id in (select id from public.partners where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists payouts_insert_admin on public.payouts;
create policy payouts_insert_admin on public.payouts
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partner_program_stats_select_public on public.partner_program_stats;
create policy partner_program_stats_select_public on public.partner_program_stats
for select using (true);

drop policy if exists partner_program_stats_insert_admin on public.partner_program_stats;
create policy partner_program_stats_insert_admin on public.partner_program_stats
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partner_program_stats_update_admin on public.partner_program_stats;
create policy partner_program_stats_update_admin on public.partner_program_stats
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists products_select_public on public.products;
create policy products_select_public on public.products
for select using ((is_active = true and is_archived = false and is_enabled = true and is_published = true) or auth.jwt() ->> 'role' = 'admin');

drop policy if exists products_insert_admin on public.products;
create policy products_insert_admin on public.products
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists products_update_admin on public.products;
create policy products_update_admin on public.products
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists product_images_select_public on public.product_images;
create policy product_images_select_public on public.product_images
for select using (
  exists (
    select 1
    from public.products p
    where p.id = product_id
      and (
        (p.is_active = true and p.is_archived = false and p.is_enabled = true and p.is_published = true)
        or auth.jwt() ->> 'role' = 'admin'
      )
  )
);

drop policy if exists product_images_insert_admin on public.product_images;
create policy product_images_insert_admin on public.product_images
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists product_images_update_admin on public.product_images;
create policy product_images_update_admin on public.product_images
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists product_images_delete_admin on public.product_images;
create policy product_images_delete_admin on public.product_images
for delete using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists product_doses_select_public on public.product_doses;
create policy product_doses_select_public on public.product_doses
for select using (
  exists (
    select 1
    from public.products p
    where p.id = product_id
      and (
        (p.is_active = true and p.is_archived = false and p.is_enabled = true and p.is_published = true)
        or auth.jwt() ->> 'role' = 'admin'
      )
  )
);

drop policy if exists product_doses_insert_admin on public.product_doses;
create policy product_doses_insert_admin on public.product_doses
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists product_doses_update_admin on public.product_doses;
create policy product_doses_update_admin on public.product_doses
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists product_doses_delete_admin on public.product_doses;
create policy product_doses_delete_admin on public.product_doses
for delete using (auth.jwt() ->> 'role' = 'admin');

-- Keep legacy mirrors readable/writable for admin workflows
drop policy if exists ambassadors_select_owner_or_admin on public.ambassadors;
create policy ambassadors_select_owner_or_admin on public.ambassadors
for select using (auth.uid() = auth_user_id or auth.jwt() ->> 'role' = 'admin');

drop policy if exists ambassadors_insert_admin on public.ambassadors;
create policy ambassadors_insert_admin on public.ambassadors
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists ambassadors_update_admin on public.ambassadors;
create policy ambassadors_update_admin on public.ambassadors
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists partner_clicks_select_owner_or_admin on public.partner_clicks;
create policy partner_clicks_select_owner_or_admin on public.partner_clicks
for select using (
  ambassador_id in (select id from public.ambassadors where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists partner_clicks_insert_any on public.partner_clicks;
create policy partner_clicks_insert_any on public.partner_clicks
for insert with check (true);

drop policy if exists partner_payouts_select_owner_or_admin on public.partner_payouts;
create policy partner_payouts_select_owner_or_admin on public.partner_payouts
for select using (
  ambassador_id in (select id from public.ambassadors where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists partner_payouts_insert_admin on public.partner_payouts;
create policy partner_payouts_insert_admin on public.partner_payouts
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_audit_logs_admin_only on public.admin_audit_logs;
create policy admin_audit_logs_admin_only on public.admin_audit_logs
for select using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_audit_logs_insert_admin on public.admin_audit_logs;
create policy admin_audit_logs_insert_admin on public.admin_audit_logs
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_credentials_admin_only on public.admin_credentials;
create policy admin_credentials_admin_only on public.admin_credentials
for select using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_credentials_admin_update on public.admin_credentials;
create policy admin_credentials_admin_update on public.admin_credentials
for update using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_sessions_admin_only on public.admin_sessions;
create policy admin_sessions_admin_only on public.admin_sessions
for select using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_sessions_admin_insert on public.admin_sessions;
create policy admin_sessions_admin_insert on public.admin_sessions
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_sessions_admin_delete on public.admin_sessions;
create policy admin_sessions_admin_delete on public.admin_sessions
for delete using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_login_attempts_admin_only on public.admin_login_attempts;
create policy admin_login_attempts_admin_only on public.admin_login_attempts
for select using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_login_attempts_admin_insert on public.admin_login_attempts;
create policy admin_login_attempts_admin_insert on public.admin_login_attempts
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists admin_login_attempts_admin_delete on public.admin_login_attempts;
create policy admin_login_attempts_admin_delete on public.admin_login_attempts
for delete using (auth.jwt() ->> 'role' = 'admin');

drop policy if exists referral_orders_select_owner_or_admin on public.referral_orders;
create policy referral_orders_select_owner_or_admin on public.referral_orders
for select using (
  ambassador_id in (select id from public.ambassadors where auth_user_id = auth.uid())
  or auth.jwt() ->> 'role' = 'admin'
);

drop policy if exists referral_orders_insert_admin on public.referral_orders;
create policy referral_orders_insert_admin on public.referral_orders
for insert with check (auth.jwt() ->> 'role' = 'admin');

drop policy if exists referral_orders_update_admin on public.referral_orders;
create policy referral_orders_update_admin on public.referral_orders
for update using (auth.jwt() ->> 'role' = 'admin');
