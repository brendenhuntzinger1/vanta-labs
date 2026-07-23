-- ============================================================================
-- VANTA LABS — ENSURE ALL PRODUCT COLUMNS EXIST
-- Fixes an empty admin product list caused by the app querying columns the
-- database is missing. When the admin loads products it asks Postgres for the
-- full column set (cost/margin, premium spec, SEO, COA). If even ONE of those
-- columns is missing, the whole query errors and the admin shows "no products
-- available" — even though your products are still safely in the table.
--
-- This adds ONLY missing columns. It never touches, moves, or deletes your
-- existing products, doses, or photos. Every statement is idempotent and safe
-- to re-run. Expect: "Success. No rows returned."
-- Supabase -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

alter table if exists public.products
  -- core descriptive / pricing fields (present on almost every DB; no-ops here)
  add column if not exists short_description text,
  add column if not exists long_description text,
  add column if not exists description text,
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
  -- COA / testing fields
  add column if not exists batch_number text,
  add column if not exists purity_result text,
  add column if not exists image_url text,
  add column if not exists testing_date date,
  add column if not exists lab_name text,
  add column if not exists coa_url text,
  -- premium research-data spec fields (customer-facing)
  add column if not exists molecular_formula text,
  add column if not exists molecular_weight text,
  add column if not exists cas_number text,
  add column if not exists peptide_sequence text,
  add column if not exists storage_recommendation text,
  add column if not exists reconstitution_note text,
  add column if not exists product_faq jsonb not null default '[]'::jsonb,
  -- SEO fields
  add column if not exists seo_title text,
  add column if not exists seo_description text,
  -- hidden admin cost / margin fields (feed the profit guard; never shown to customers)
  add column if not exists product_cost_cents integer,
  add column if not exists suggested_retail_cents integer,
  add column if not exists min_selling_price_cents integer,
  add column if not exists min_profit_cents integer,
  add column if not exists min_profit_percent numeric,
  add column if not exists shipping_cost_cents integer,
  add column if not exists commission_cost_cents integer,
  -- inventory / status fields the catalog relies on
  add column if not exists low_stock_threshold integer not null default 5,
  add column if not exists is_active boolean not null default true;

-- Dose variants: ensure the columns the admin + catalog read all exist too.
alter table if exists public.product_doses
  add column if not exists sku text,
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
  add column if not exists low_stock_threshold integer not null default 5,
  -- per-dose cost / margin (a 5mg and 30mg vial cost different amounts)
  add column if not exists product_cost_cents integer,
  add column if not exists suggested_retail_cents integer,
  add column if not exists min_selling_price_cents integer,
  add column if not exists min_profit_cents integer,
  add column if not exists min_profit_percent numeric;

-- Product images: the admin filters on is_enabled; make sure it exists.
alter table if exists public.product_images
  add column if not exists alt_text text,
  add column if not exists is_primary boolean not null default false,
  add column if not exists is_enabled boolean not null default true,
  add column if not exists position integer not null default 0;
