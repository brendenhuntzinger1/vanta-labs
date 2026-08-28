-- Production column parity for the local harness.
--
-- Regenerated from information_schema.columns, which records a column's type
-- and default but NOT its nullability -- so every line below came out nullable
-- regardless of how the owning migration declared it. Six columns are HAND-
-- EDITED back to `not null` to match their migrations, which the harness never
-- runs (they are not in setup-local-harness.sh's feature loop, so this file is
-- the only thing that creates them): coupons.member_scope,
-- orders.shippo_sync_attempts, product_doses.incoming_quantity,
-- products.incoming_quantity, products.requires_reconstitution and
-- shippo_webhook_events.retry_count. Each carries a DEFAULT, so adding the
-- column NOT NULL is safe. Preserve them if this file is ever regenerated.
alter table public.ambassador_wallet_ledger add column if not exists id uuid default gen_random_uuid();
alter table public.ambassador_wallet_ledger add column if not exists user_id uuid;
alter table public.ambassador_wallet_ledger add column if not exists amount_cents integer;
alter table public.ambassador_wallet_ledger add column if not exists reason text;
alter table public.ambassador_wallet_ledger add column if not exists order_id text;
alter table public.ambassador_wallet_ledger add column if not exists note text;
alter table public.ambassador_wallet_ledger add column if not exists created_by text;
alter table public.ambassador_wallet_ledger add column if not exists created_at timestamptz default now();
alter table public.ambassadors add column if not exists first_name text;
alter table public.ambassadors add column if not exists last_name text;
alter table public.ambassadors add column if not exists phone text;
alter table public.ambassadors add column if not exists social text;
alter table public.ambassadors add column if not exists follower_count integer;
alter table public.ambassadors add column if not exists preferred_referral_code text;
alter table public.ambassadors add column if not exists customer_discount_percent numeric(5,2);
alter table public.back_in_stock_requests add column if not exists variant_id text;
alter table public.back_in_stock_requests add column if not exists notified_at timestamptz;
alter table public.commissions add column if not exists customer_discount_percent numeric(5,2);
alter table public.coupons add column if not exists member_scope text not null default 'all'::text;
alter table public.customer_memberships add column if not exists veyra_membership_id text;
alter table public.customer_preferences add column if not exists phone text;
alter table public.fulfillment_events add column if not exists provider text;
alter table public.fulfillment_events add column if not exists direction text;
alter table public.fulfillment_events add column if not exists status_code integer;
alter table public.fulfillment_events add column if not exists ok boolean default true;
alter table public.fulfillment_events add column if not exists message text;
alter table public.fulfillment_orders add column if not exists order_number text;
alter table public.fulfillment_orders add column if not exists external_id text;
alter table public.fulfillment_orders add column if not exists tracking_number text;
alter table public.fulfillment_orders add column if not exists tracking_url text;
alter table public.fulfillment_orders add column if not exists carrier text;
alter table public.fulfillment_orders add column if not exists last_error text;
alter table public.fulfillment_orders add column if not exists transmitted_at timestamptz;
alter table public.fulfillment_orders add column if not exists last_synced_at timestamptz;
alter table public.fulfillment_orders add column if not exists payload jsonb;
alter table public.fulfillment_payouts add column if not exists order_number text;
alter table public.fulfillment_payouts add column if not exists provider text;
alter table public.fulfillment_payouts add column if not exists units integer default 0;
alter table public.fulfillment_payouts add column if not exists model text default 'per_unit'::text;
alter table public.fulfillment_payouts add column if not exists rate numeric(12,2) default 0;
alter table public.fulfillment_payouts add column if not exists amount_owed numeric(12,2) default 0;
alter table public.fulfillment_payouts add column if not exists paid_at timestamptz;
alter table public.fulfillment_payouts add column if not exists reference text;
alter table public.fulfillment_payouts add column if not exists updated_at timestamptz default now();
alter table public.membership_billing_events add column if not exists tier_id uuid;
alter table public.membership_billing_events add column if not exists status text;
alter table public.membership_billing_events add column if not exists provider_charge_id text;
alter table public.membership_billing_events add column if not exists failure_reason text;
alter table public.orders add column if not exists refund_amount numeric(12,2) default 0;
alter table public.orders add column if not exists refunded_at timestamptz;
alter table public.orders add column if not exists state text;
alter table public.orders add column if not exists phone text;
alter table public.orders add column if not exists ambassador_credit_redeemed_cents integer default 0;
alter table public.orders add column if not exists shippo_order_id text;
alter table public.orders add column if not exists shippo_sync_status text;
alter table public.orders add column if not exists shippo_sync_error text;
alter table public.orders add column if not exists shippo_synced_at timestamptz;
alter table public.orders add column if not exists shippo_sync_claimed_at timestamptz;
alter table public.orders add column if not exists shippo_sync_attempts integer not null default 0;
alter table public.orders add column if not exists shipping_profit_cents integer generated always as (case when postage_cost_cents is null then null::integer else (round(coalesce(shipping_amount,0::numeric)*100::numeric))::integer - postage_cost_cents end) stored;
alter table public.orders add column if not exists parcel_preset_id uuid;
alter table public.orders add column if not exists parcel_preset_name text;
alter table public.orders add column if not exists parcel_length_in numeric;
alter table public.orders add column if not exists parcel_width_in numeric;
alter table public.orders add column if not exists parcel_height_in numeric;
alter table public.orders add column if not exists parcel_merchandise_oz numeric;
alter table public.orders add column if not exists parcel_packaging_oz numeric;
alter table public.orders add column if not exists parcel_declared_oz numeric;
alter table public.orders add column if not exists parcel_weight_estimated boolean;
alter table public.orders add column if not exists shipping_address_2 text;
alter table public.partners add column if not exists first_name text;
alter table public.partners add column if not exists last_name text;
alter table public.partners add column if not exists phone text;
alter table public.partners add column if not exists social text;
alter table public.partners add column if not exists follower_count integer;
alter table public.partners add column if not exists preferred_referral_code text;
alter table public.partners add column if not exists customer_discount_percent numeric(5,2);
alter table public.product_doses add column if not exists incoming_quantity integer not null default 0;
alter table public.product_subscriptions add column if not exists email text;
alter table public.product_subscriptions add column if not exists variant_id text;
alter table public.product_subscriptions add column if not exists frequency_days integer default 30;
alter table public.product_subscriptions add column if not exists discount_percent numeric(5,2) default 0;
alter table public.product_subscriptions add column if not exists updated_at timestamptz default now();
alter table public.products add column if not exists shipping_cost_cents integer;
alter table public.products add column if not exists commission_cost_cents integer;
alter table public.products add column if not exists incoming_quantity integer not null default 0;
alter table public.products add column if not exists requires_reconstitution boolean not null default false;
alter table public.referral_orders add column if not exists original_subtotal numeric(12,2);
alter table public.referral_orders add column if not exists customer_discount numeric(12,2);
alter table public.referral_orders add column if not exists payout_status text default 'unpaid'::text;
alter table public.referral_orders add column if not exists tier_name text;
alter table public.referral_orders add column if not exists ineligible_reason text;
alter table public.referral_orders add column if not exists fraud_reason text;
alter table public.referral_orders add column if not exists customer_discount_percent numeric(5,2);
alter table public.shippo_webhook_events add column if not exists event_type text;
alter table public.shippo_webhook_events add column if not exists order_id text;
alter table public.shippo_webhook_events add column if not exists shippo_object_id text;
alter table public.shippo_webhook_events add column if not exists matched boolean;
alter table public.shippo_webhook_events add column if not exists error text;
alter table public.shippo_webhook_events add column if not exists retry_count integer not null default 0;
create table if not exists public.order_attribution (
  order_id text primary key, visitor_id text, session_id text,
  first_touch_at timestamptz, first_utm_source text, first_utm_medium text, first_utm_campaign text,
  first_utm_content text, first_utm_term text, first_ttclid text, first_fbclid text, first_gclid text,
  first_landing_path text, first_referrer text, last_touch_at timestamptz, last_utm_source text,
  last_utm_medium text, last_utm_campaign text, last_utm_content text, last_utm_term text,
  last_ttclid text, last_fbclid text, last_gclid text, last_landing_path text, last_referrer text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
