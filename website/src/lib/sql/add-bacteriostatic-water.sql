-- ============================================================================
-- VANTA LABS — ADD BACTERIOSTATIC WATER (0.9% Benzyl Alcohol)
-- One product, two size variants: 10mL ($14.99, cost $8.00) and
-- 30mL ($24.99, cost $14.00). Category: Solvents & Solutions.
--
-- Safe to re-run (upsert by slug + by dose). It PRESERVES any photo already
-- set on the product (never overwrites image_url). It does NOT delete
-- anything. Supabase -> SQL Editor -> New query -> paste -> Run.
-- ============================================================================
--
-- NOTE: The cost values in this seed are historical seed estimates.
-- `src/lib/sql/product-cogs.sql` is the authoritative landed-cost source.
-- Re-running this file will deliberately NOT touch product_cost_cents on rows
-- that already exist — see the ON CONFLICT clauses below for cost handling.
--
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Parent product. Parent price = the default (lowest) size.
--    On conflict we refresh name/category/price but KEEP the existing photo
--    and cost.
-- ---------------------------------------------------------------------------
insert into public.products
  (slug, name, category, price_cents, product_cost_cents, is_featured, position,
   is_published, is_enabled, is_active, is_archived, stock_status, inventory_quantity)
values
  -- Name says "BAC Water", never the full compound name: owner decision, and
  -- the same rule the storefront copy guard enforces in
  -- src/components/research-use-copy.test.ts. It matters HERE because this
  -- script is idempotent and re-applies name=excluded.name below, so a re-run
  -- with the old literal would silently revert the catalogue. The slug stays
  -- 'bacteriostatic-water' — it is the detection key for isBacWater() and the
  -- live URL, and changing it would switch the cross-sell off and 404 the page.
  ('bacteriostatic-water', 'BAC Water (0.9% Benzyl Alcohol)',
   'Solvents & Solutions', 1499, 800, false, 37,
   true, true, true, false, 'In Stock', 100)
on conflict (slug) do update set
  name=excluded.name, category=excluded.category, price_cents=excluded.price_cents,
  is_featured=excluded.is_featured,
  is_published=true, is_enabled=true, is_active=true, is_archived=false,
  stock_status='In Stock', updated_at=now();
  -- (image_url and product_cost_cents intentionally NOT updated → existing photo and cost are preserved)

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
  ('bacteriostatic-water', '10mL', '10ml', 1499,  800, true,  0),
  ('bacteriostatic-water', '30mL', '30ml', 2499, 1400, false, 1)
) as d(parent_slug, label, slug_suffix, price_cents, cost_cents, is_default, position)
join public.products p on p.slug = d.parent_slug
on conflict (product_id, slug_suffix) do update set
  label=excluded.label, price_cents=excluded.price_cents,
  is_default=excluded.is_default,
  is_enabled=true, stock_status='In Stock', updated_at=now();

-- ---------------------------------------------------------------------------
-- 3. Compliant descriptions (research use only; no health claims). Idempotent.
-- ---------------------------------------------------------------------------
-- These describe WHAT THE MATERIAL IS, never what it is used for. The previous
-- text said "multi-dose diluent … ideal for reconstituting lyophilized research
-- compounds", which is preparation-for-use guidance: reconstitution is the step
-- that only matters if someone intends to use the material, and "multi-dose" is
-- dose language. On a research-use-only catalogue that is the one inference the
-- copy must not invite, however firm the disclaimer that follows it.
--
-- All three columns matter and all three are overwritten on every run: catalog.ts
-- resolves the public description as `long_description ?? description`, and
-- short_description feeds the card and the meta description. Leaving any one of
-- them on the old text just moves the problem to whichever rung the next operator
-- clears in Admin.
update public.products set
  short_description='BAC Water (0.9% benzyl alcohol) in sterile glass vials, supplied for laboratory research applications. For laboratory research use only.',
  long_description='BAC Water (0.9% benzyl alcohol) is a sterile solution supplied for laboratory research applications. Available in 10 mL and 30 mL sterile glass vials. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.',
  description='BAC Water (0.9% benzyl alcohol) is a sterile solution supplied for laboratory research applications. Available in 10 mL and 30 mL sterile glass vials. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.',
  updated_at=now()
where slug='bacteriostatic-water';

-- ---------------------------------------------------------------------------
-- 4. Verify (optional): should return 1 product and 2 doses.
--   select count(*) from public.products where slug='bacteriostatic-water';
--   select count(*) from public.product_doses d
--     join public.products p on p.id=d.product_id
--     where p.slug='bacteriostatic-water';
-- ---------------------------------------------------------------------------
