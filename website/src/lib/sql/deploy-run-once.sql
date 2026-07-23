-- ============================================================================
-- VANTA LABS — RUN-ONCE DEPLOY MIGRATION
-- Paste into: Supabase -> SQL Editor -> New query -> Run.
-- Expect: "Success. No rows returned."
-- Idempotent + safe on a fresh OR existing database + safe to re-run.
--
-- If pasting the whole file fails with "syntax error at end of input", your
-- copy was truncated — run it in the three chunks marked "CHUNK 1/2/3" below,
-- one at a time.
-- ============================================================================


-- ============================ CHUNK 1 — TABLES ==============================

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null,
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
  partner_id uuid not null,
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
  partner_id uuid not null,
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
  role text not null default 'super_admin',
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
  low_stock_threshold integer not null default 5,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null,
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
  product_id uuid not null,
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
  low_stock_threshold integer not null default 5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, slug_suffix)
);

create table if not exists public.ambassadors (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid,
  name text,
  email text,
  referral_code text,
  status text not null default 'pending',
  commission_percent numeric(5,2) not null default 10,
  commission_percent_locked boolean not null default false,
  invited_at timestamptz,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.partners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  name text not null,
  email text,
  referral_code text not null unique,
  status text not null default 'pending',
  commission_percent numeric(5,2) not null default 10,
  commission_percent_locked boolean not null default false,
  invited_at timestamptz,
  approved_at timestamptz,
  disabled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
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

create table if not exists public.website_analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  page_path text,
  page_url text,
  referrer text,
  session_id text,
  visitor_id text,
  user_agent text,
  ip_address text,
  country text,
  city text,
  device_type text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  order_number text,
  payment_id text,
  customer_email text,
  customer_name text,
  customer_user_id uuid,
  shipping_address text,
  city text,
  country text,
  postal_code text,
  currency text not null default 'USD',
  subtotal numeric(12,2) not null default 0,
  shipping_amount numeric(12,2) not null default 0,
  handling_fee numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  coupon_code text,
  referral_code text,
  ambassador_id uuid,
  payment_method text,
  payment_status text not null default 'pending_payment',
  fulfillment_status text not null default 'pending',
  order_type text not null default 'product',
  membership_tier_id uuid,
  membership_cycle text,
  bulk_discount_tier text,
  priority boolean not null default false,
  card_processing_fee numeric(12,2) not null default 0,
  card_processing_fee_percent numeric(5,2) not null default 0,
  payment_reference text,
  payment_proof_url text,
  payment_submitted_at timestamptz,
  verified_at timestamptz,
  verified_by text,
  rejection_reason text,
  payment_rejected_at timestamptz,
  points_redeemed integer not null default 0,
  points_earned integer not null default 0,
  tracking_number text,
  paid_at timestamptz,
  provider_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
  fraud_flag boolean not null default false,
  review_required boolean not null default false,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_shipments (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  carrier text,
  tracking_number text,
  shipping_status text not null default 'pending',
  estimated_delivery timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_type text not null default 'percent',
  discount_value numeric(12,2) not null,
  assigned_email text,
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer,
  redemptions_count integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_queue (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  recipient text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  product_id text not null unique,
  sku text,
  quantity_on_hand integer not null default 0,
  reorder_level integer not null default 0,
  status text not null default 'active',
  updated_at timestamptz not null default now()
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

create table if not exists public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null,
  created_at timestamptz not null default now(),
  unique (user_id, product_slug)
);

create table if not exists public.customer_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  order_update_emails boolean not null default true,
  marketing_emails boolean not null default false,
  birthday date,
  birthday_bonus_year integer,
  referral_code text unique,
  referred_by_code text,
  updated_at timestamptz not null default now()
);

create table if not exists public.membership_tiers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  monthly_price_cents integer not null default 0,
  annual_price_cents integer not null default 0,
  points_per_dollar numeric(6,2) not null default 1,
  free_shipping boolean not null default false,
  priority_shipping boolean not null default false,
  early_access boolean not null default false,
  exclusive_pricing boolean not null default false,
  referral_bonus_points integer not null default 0,
  benefits jsonb not null default '[]'::jsonb,
  intro_price_cents integer not null default 100,
  intro_duration_days integer not null default 7,
  intro_offer_enabled boolean not null default true,
  member_discount_percent numeric(5,2) not null default 0,
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier_id uuid not null,
  billing_cycle text not null default 'monthly',
  status text not null default 'active',
  intro_status text not null default 'none',
  intro_ends_at timestamptz,
  next_billing_at timestamptz,
  started_at timestamptz not null default now(),
  renews_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.membership_billing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  event_type text not null,
  amount_cents integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null,
  reason text not null,
  order_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.promotional_point_events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  multiplier numeric(6,2) not null default 2,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.email_suppressions (
  email text primary key,
  reason text not null default 'unsubscribed',
  created_at timestamptz not null default now()
);

create table if not exists public.email_send_log (
  id uuid primary key default gen_random_uuid(),
  campaign_type text not null,
  reference_id text,
  recipient_email text not null,
  template_key text not null,
  sent_at timestamptz not null default now(),
  opened_at timestamptz,
  clicked_at timestamptz
);

create table if not exists public.abandoned_carts (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  customer_user_id uuid references auth.users(id) on delete set null,
  email text not null,
  customer_name text,
  items jsonb not null default '[]'::jsonb,
  cart_value_cents integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  status text not null default 'active',
  recovered_order_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.abandoned_cart_emails (
  id uuid primary key default gen_random_uuid(),
  abandoned_cart_id uuid not null,
  stage text not null,
  sent_at timestamptz not null default now(),
  opened_at timestamptz,
  clicked_at timestamptz,
  coupon_id uuid
);

create table if not exists public.commission_tier_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  min_monthly_sales integer not null default 0,
  commission_percent numeric(5,2) not null,
  position integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fulfillment_orders (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  provider text,
  provider_order_id text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.fulfillment_events (
  id uuid primary key default gen_random_uuid(),
  order_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.fulfillment_payouts (
  id uuid primary key default gen_random_uuid(),
  order_id text,
  amount numeric(12,2) not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.back_in_stock_requests (
  id uuid primary key default gen_random_uuid(),
  product_slug text not null,
  email text not null,
  notified boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.product_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  product_slug text not null,
  status text not null default 'active',
  interval_days integer not null default 30,
  next_order_at timestamptz,
  created_at timestamptz not null default now()
);


-- =================== CHUNK 2 — COLUMN BACKFILLS + INDEXES ===================
-- Brings pre-existing tables (from earlier development) up to the current
-- shape. Harmless if the tables were just created above.

alter table if exists public.admin_credentials
  add column if not exists role text not null default 'super_admin';
alter table public.admin_credentials drop constraint if exists admin_credentials_role_check;
alter table public.admin_credentials
  add constraint admin_credentials_role_check check (role in ('staff', 'manager', 'super_admin'));

alter table if exists public.products
  add column if not exists low_stock_threshold integer not null default 5;
alter table if exists public.product_doses
  add column if not exists low_stock_threshold integer not null default 5;

alter table if exists public.ambassadors
  add column if not exists commission_percent_locked boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();
alter table if exists public.partners
  add column if not exists commission_percent_locked boolean not null default false;

alter table if exists public.commissions
  add column if not exists tier_name text,
  add column if not exists ineligible_reason text,
  add column if not exists fraud_flag boolean not null default false,
  add column if not exists fraud_reason text;

alter table if exists public.coupons
  add column if not exists assigned_email text;

alter table if exists public.membership_tiers
  add column if not exists intro_price_cents integer not null default 100,
  add column if not exists intro_duration_days integer not null default 7,
  add column if not exists intro_offer_enabled boolean not null default true,
  add column if not exists member_discount_percent numeric(5,2) not null default 0;

alter table if exists public.customer_memberships
  add column if not exists intro_status text not null default 'none',
  add column if not exists intro_ends_at timestamptz,
  add column if not exists next_billing_at timestamptz;

alter table if exists public.customer_preferences
  add column if not exists birthday date,
  add column if not exists birthday_bonus_year integer,
  add column if not exists referral_code text unique,
  add column if not exists referred_by_code text;

alter table if exists public.orders
  add column if not exists order_number text,
  add column if not exists customer_user_id uuid,
  add column if not exists country text,
  add column if not exists handling_fee numeric(12,2) not null default 0,
  add column if not exists tax_amount numeric(12,2) not null default 0,
  add column if not exists coupon_code text,
  add column if not exists payment_method text,
  add column if not exists order_type text not null default 'product',
  add column if not exists membership_tier_id uuid,
  add column if not exists membership_cycle text,
  add column if not exists bulk_discount_tier text,
  add column if not exists priority boolean not null default false,
  add column if not exists card_processing_fee numeric(12,2) not null default 0,
  add column if not exists card_processing_fee_percent numeric(5,2) not null default 0,
  add column if not exists payment_reference text,
  add column if not exists payment_proof_url text,
  add column if not exists payment_submitted_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by text,
  add column if not exists rejection_reason text,
  add column if not exists payment_rejected_at timestamptz,
  add column if not exists points_redeemed integer not null default 0,
  add column if not exists points_earned integer not null default 0;

alter table if exists public.referral_orders
  add column if not exists approved_for_payout_at timestamptz,
  add column if not exists commission_paid_at timestamptz,
  add column if not exists reversed_at timestamptz,
  add column if not exists fraud_flag boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_shipments_order_id_key') then
    alter table public.order_shipments add constraint order_shipments_order_id_key unique (order_id);
  end if;
end;
$$;

create index if not exists idx_partners_auth_user_id on public.partners(auth_user_id);
create index if not exists idx_partners_referral_code on public.partners(referral_code);
create index if not exists idx_partners_status on public.partners(status);
create index if not exists idx_partners_updated_at on public.partners(updated_at desc);
create index if not exists idx_referrals_partner_id on public.referrals(partner_id);
create index if not exists idx_referrals_order_id on public.referrals(order_id);
create index if not exists idx_referrals_event_type on public.referrals(event_type);
create index if not exists idx_referrals_created_at on public.referrals(created_at desc);
create index if not exists idx_commissions_partner_id on public.commissions(partner_id);
create index if not exists idx_commissions_status on public.commissions(status);
create index if not exists idx_payouts_partner_id on public.payouts(partner_id);
create index if not exists idx_payouts_created_at on public.payouts(created_at desc);
create unique index if not exists idx_products_slug on public.products(slug);
create index if not exists idx_products_is_active on public.products(is_active);
create index if not exists idx_products_category on public.products(category);
create index if not exists idx_products_position on public.products(position);
create index if not exists idx_products_is_published on public.products(is_published);
create index if not exists idx_products_is_enabled on public.products(is_enabled);
create index if not exists idx_products_is_archived on public.products(is_archived);
create unique index if not exists idx_admin_credentials_username on public.admin_credentials(username);
create index if not exists idx_admin_credentials_role on public.admin_credentials(role);
create unique index if not exists idx_admin_sessions_token_hash on public.admin_sessions(token_hash);
create index if not exists idx_admin_sessions_expires_at on public.admin_sessions(expires_at);
create index if not exists idx_admin_login_attempts_username_attempted_at on public.admin_login_attempts(username, attempted_at desc);
create index if not exists idx_admin_login_attempts_ip_attempted_at on public.admin_login_attempts(ip_address, attempted_at desc);
create index if not exists idx_admin_audit_logs_actor on public.admin_audit_logs(actor_user_id);
create index if not exists idx_admin_audit_logs_created_at on public.admin_audit_logs(created_at desc);
create index if not exists idx_product_images_product_id on public.product_images(product_id);
create index if not exists idx_product_images_position on public.product_images(position);
create index if not exists idx_product_doses_product_id on public.product_doses(product_id);
create index if not exists idx_product_doses_position on public.product_doses(position);
create unique index if not exists idx_product_doses_product_slug_suffix on public.product_doses(product_id, slug_suffix);
create index if not exists idx_ambassadors_referral_code on public.ambassadors(referral_code);
create index if not exists idx_ambassadors_auth_user_id on public.ambassadors(auth_user_id);
create index if not exists idx_ambassadors_status on public.ambassadors(status);
create index if not exists idx_ambassadors_updated_at on public.ambassadors(updated_at desc);
create index if not exists idx_partner_clicks_ambassador_id on public.partner_clicks(ambassador_id);
create index if not exists idx_partner_clicks_created_at on public.partner_clicks(created_at desc);
create index if not exists idx_partner_clicks_referral_code on public.partner_clicks(referral_code);
create index if not exists idx_partner_payouts_ambassador_id on public.partner_payouts(ambassador_id);
create index if not exists idx_partner_payouts_created_at on public.partner_payouts(created_at desc);
create index if not exists idx_referral_orders_ambassador_id on public.referral_orders(ambassador_id);
create index if not exists idx_referral_orders_order_id on public.referral_orders(order_id);
create index if not exists idx_referral_orders_payment_status on public.referral_orders(payment_status);
create index if not exists idx_referral_orders_fraud_flag on public.referral_orders(fraud_flag) where fraud_flag = true;
create index if not exists idx_orders_created_at on public.orders(created_at desc);
create index if not exists idx_orders_payment_status on public.orders(payment_status);
create index if not exists idx_orders_customer_email on public.orders(customer_email);
create index if not exists idx_orders_ambassador_id on public.orders(ambassador_id);
create index if not exists idx_orders_referral_code on public.orders(referral_code);
create index if not exists idx_orders_paid_at on public.orders(paid_at) where paid_at is not null;
create index if not exists idx_orders_coupon_code on public.orders(coupon_code) where coupon_code is not null;
create index if not exists idx_orders_payment_method on public.orders(payment_method);
create index if not exists idx_orders_order_type on public.orders(order_type);
create index if not exists idx_orders_customer_user_id on public.orders(customer_user_id) where customer_user_id is not null;
create index if not exists idx_orders_bulk_discount_tier on public.orders(bulk_discount_tier) where bulk_discount_tier is not null;
create index if not exists idx_orders_priority on public.orders(priority) where priority = true;
create index if not exists idx_payment_events_order_id on public.payment_events(order_id);
create index if not exists idx_website_analytics_events_created_at on public.website_analytics_events(created_at desc);
create index if not exists idx_website_analytics_events_event_type on public.website_analytics_events(event_type);
create index if not exists idx_website_analytics_events_page_path on public.website_analytics_events(page_path);
create index if not exists idx_website_analytics_events_session_id on public.website_analytics_events(session_id);
create index if not exists idx_customer_addresses_user_id on public.customer_addresses(user_id);
create index if not exists idx_wishlist_items_user_id on public.wishlist_items(user_id);
create index if not exists idx_order_shipments_order_id on public.order_shipments(order_id);
create index if not exists idx_notification_queue_status on public.notification_queue(status, created_at);
create index if not exists idx_customer_memberships_tier_id on public.customer_memberships(tier_id);
create index if not exists idx_customer_memberships_next_billing_at on public.customer_memberships(next_billing_at) where next_billing_at is not null;
create index if not exists idx_customer_memberships_intro_ends_at on public.customer_memberships(intro_ends_at) where intro_status = 'active';
create index if not exists idx_membership_billing_events_user_id on public.membership_billing_events(user_id, created_at desc);
create index if not exists idx_membership_billing_events_type on public.membership_billing_events(event_type, created_at desc);
create index if not exists idx_points_ledger_user_id on public.points_ledger(user_id, created_at desc);
create index if not exists idx_points_ledger_order_id on public.points_ledger(order_id) where order_id is not null;
create index if not exists idx_email_send_log_reference on public.email_send_log(reference_id);
create index if not exists idx_email_send_log_campaign_type on public.email_send_log(campaign_type, sent_at desc);
create index if not exists idx_email_send_log_recipient on public.email_send_log(recipient_email);
create index if not exists idx_coupons_assigned_email on public.coupons(assigned_email) where assigned_email is not null;
create index if not exists idx_abandoned_carts_email on public.abandoned_carts(email);
create index if not exists idx_abandoned_carts_status on public.abandoned_carts(status, first_seen_at);
create index if not exists idx_abandoned_carts_recovered_order on public.abandoned_carts(recovered_order_id) where recovered_order_id is not null;
create index if not exists idx_commission_tier_rules_min_sales on public.commission_tier_rules(min_monthly_sales);
create index if not exists idx_fulfillment_orders_status on public.fulfillment_orders(status);
create index if not exists idx_fulfillment_orders_provider on public.fulfillment_orders(provider);
create index if not exists idx_fulfillment_events_order_id on public.fulfillment_events(order_id);
create index if not exists idx_fulfillment_events_created_at on public.fulfillment_events(created_at desc);
create index if not exists idx_fulfillment_payouts_status on public.fulfillment_payouts(status);
create index if not exists idx_bis_product on public.back_in_stock_requests(product_slug) where notified = false;
create index if not exists idx_product_subscriptions_user on public.product_subscriptions(user_id);
create index if not exists idx_product_subscriptions_status on public.product_subscriptions(status);


-- ========================= CHUNK 3 — FUNCTIONS =============================

create or replace function public.redeem_coupon(input_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_count integer;
begin
  update public.coupons
     set redemptions_count = coalesce(redemptions_count, 0) + 1
   where code = upper(trim(input_code))
     and active = true
     and (max_redemptions is null or coalesce(redemptions_count, 0) < max_redemptions)
   returning redemptions_count into new_count;

  if new_count is null then
    return jsonb_build_object('redeemed', false);
  end if;

  return jsonb_build_object('redeemed', true, 'redemptions_count', new_count);
end;
$$;
grant execute on function public.redeem_coupon(text) to service_role;

create or replace function public.validate_referral_code(input_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'valid', true,
    'referral_code', a.referral_code,
    'ambassador_id', a.id,
    'ambassador_name', a.name,
    'commission_percent', a.commission_percent
  )
  into result
  from public.ambassadors a
  where a.referral_code = upper(trim(input_code))
    and a.status = 'approved'
  limit 1;

  if result is null then
    return jsonb_build_object('valid', false);
  end if;

  return result;
end;
$$;
grant execute on function public.validate_referral_code(text) to anon, authenticated;


-- ==================== CHUNK 4 — SECURITY HARDENING (2025 audit) ==============
-- Added by the platform audit. Idempotent and safe to re-run.

-- 4a. Admin console second factor: 6-digit passcode (scrypt salt+hash).
--     See src/lib/admin-passcode.ts and src/lib/sql/admin-passcode-2fa.sql.
alter table if exists public.admin_credentials
  add column if not exists passcode_salt text,
  add column if not exists passcode_hash text,
  add column if not exists passcode_updated_at timestamptz;

-- 4b. Deny-by-default Row Level Security on every public table. The app reads
--     and writes through the service-role key (BYPASSRLS), so this only closes
--     direct anon/authenticated access via the public NEXT_PUBLIC anon key.
--     See src/lib/sql/rls-enforce-all-tables.sql for the full rationale.
do $$
declare
  target text;
  tables text[] := array[
    'admin_credentials', 'admin_sessions', 'admin_login_attempts', 'admin_audit_logs',
    'orders', 'order_items', 'order_shipments', 'payment_events', 'payouts',
    'partner_payouts', 'fulfillment_payouts', 'commissions', 'commission_tier_rules',
    'customer_addresses', 'customer_preferences', 'customer_memberships',
    'store_credit_ledger', 'points_ledger', 'promotional_point_events',
    'products', 'product_doses', 'product_images', 'product_subscriptions',
    'inventory_items', 'coupons', 'membership_tiers', 'membership_billing_events',
    'ambassadors', 'partners', 'partner_clicks', 'partner_program_stats',
    'referrals', 'referral_orders',
    'abandoned_carts', 'abandoned_cart_emails', 'back_in_stock_requests',
    'wishlist_items', 'email_send_log', 'email_suppressions', 'notification_queue',
    'fulfillment_orders', 'fulfillment_events', 'website_analytics_events'
  ];
begin
  foreach target in array tables loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = target
    ) then
      execute format('alter table public.%I enable row level security;', target);
    end if;
  end loop;
end $$;
