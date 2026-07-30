-- ============================================================================
-- VANTA LABS — ADD BACTERIOSTATIC WATER (0.9% Benzyl Alcohol)
-- One product, two size variants: 10mL ($15.00, cost $8.00) and
-- 30mL ($25.00, cost $14.00). Category: Solvents & Solutions.
--
-- Safe to re-run (upsert by slug + by dose). It PRESERVES any photo already
-- set on the product (never overwrites image_url). It does NOT delete
-- anything. Supabase -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Parent product. Parent price = the default (lowest) size.
--    On conflict we refresh name/category/price/cost but KEEP the existing photo.
-- ---------------------------------------------------------------------------
insert into public.products
  (slug, name, category, price_cents, product_cost_cents, is_featured, position,
   is_published, is_enabled, is_active, is_archived, stock_status, inventory_quantity)
values
  ('bacteriostatic-water', 'Bacteriostatic Water (0.9% Benzyl Alcohol)',
   'Solvents & Solutions', 1500, 800, false, 37,
   true, true, true, false, 'In Stock', 100)
on conflict (slug) do update set
  name=excluded.name, category=excluded.category, price_cents=excluded.price_cents,
  product_cost_cents=excluded.product_cost_cents, is_featured=excluded.is_featured,
  is_published=true, is_enabled=true, is_active=true, is_archived=false,
  stock_status='In Stock', updated_at=now();
  -- (image_url intentionally NOT updated → an existing product photo is preserved)

-- ---------------------------------------------------------------------------
-- 2. Size variants. Each carries its own price + wholesale cost so the
--    profit guard is correct per size. Upsert by (product_id, slug_suffix).
-- ---------------------------------------------------------------------------
insert into public.product_doses
  (product_id, label, slug_suffix, price_cents, product_cost_cents,
   is_default, is_enabled, position, stock_status, inventory_quantity)
select p.id, d.label, d.slug_suffix, d.price_cents, d.cost_cents,
       d.is_default, true, d.position, 'In Stock', 100
from (values
  ('bacteriostatic-water', '10mL', '10ml', 1500,  800, true,  0),
  ('bacteriostatic-water', '30mL', '30ml', 2500, 1400, false, 1)
) as d(parent_slug, label, slug_suffix, price_cents, cost_cents, is_default, position)
join public.products p on p.slug = d.parent_slug
on conflict (product_id, slug_suffix) do update set
  label=excluded.label, price_cents=excluded.price_cents,
  product_cost_cents=excluded.product_cost_cents, is_default=excluded.is_default,
  is_enabled=true, stock_status='In Stock', updated_at=now();

-- ---------------------------------------------------------------------------
-- 3. Compliant descriptions (research use only; no health claims). Idempotent.
-- ---------------------------------------------------------------------------
update public.products set
  short_description='Sterile multi-dose diluent (0.9% benzyl alcohol) designed for research applications. Ideal for reconstituting lyophilized research compounds. For laboratory research use only.',
  long_description='Bacteriostatic Water (0.9% benzyl alcohol) is a sterile multi-dose diluent designed for research applications, ideal for reconstituting lyophilized research compounds. Available in both 10 mL and 30 mL sterile glass vials. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.',
  description='Bacteriostatic Water (0.9% benzyl alcohol) is a sterile multi-dose diluent designed for research applications, ideal for reconstituting lyophilized research compounds. Available in both 10 mL and 30 mL sterile glass vials. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.',
  updated_at=now()
where slug='bacteriostatic-water';

-- ---------------------------------------------------------------------------
-- 4. Verify (optional): should return 1 product and 2 doses.
--   select count(*) from public.products where slug='bacteriostatic-water';
--   select count(*) from public.product_doses d
--     join public.products p on p.id=d.product_id
--     where p.slug='bacteriostatic-water';
-- ---------------------------------------------------------------------------
