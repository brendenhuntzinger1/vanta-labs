-- =========================================================================
-- VANTA LABS — per-vial COST (COGS) load, cost-only.
--
-- Sets product_cost_cents for every dose (vial) and every product to the
-- wholesale cost per vial from the EVO sheet. This is the all-in cost the
-- profit engine subtracts (product + fulfillment + packaging).
--
-- COST ONLY: this script never touches prices, photos, stock, categories, or
-- anything else — it only writes product_cost_cents. Safe to re-run.
--
-- Supabase → SQL Editor → New query → paste → Run.
-- =========================================================================

-- 1. Per-dose (per-vial) cost. Matched by product slug + dose slug_suffix.
update public.product_doses d
set product_cost_cents = c.cost_cents,
    updated_at = now()
from (values
  -- GLP Research
  ('glp-1','5mg',2456), ('glp-1','10mg',2537), ('glp-1','20mg',2690), ('glp-1','30mg',2780),
  ('glp-2','5mg',2376), ('glp-2','10mg',2484), ('glp-2','20mg',2646), ('glp-2','30mg',2826),
  ('glp-3','5mg',2306), ('glp-3','10mg',2405), ('glp-3','20mg',2729), ('glp-3','30mg',3026),
  ('cagrilintide','10mg',3500),
  -- Blends
  ('klow','80mg',3500),
  ('glow','70mg',3500),
  -- Tissue Research
  ('bpc-157','5mg',2506), ('bpc-157','10mg',2569),
  ('bpc-157-tb-500','20mg',3398),
  ('kpv','10mg',3147),
  ('ghk-cu','50mg',2288), ('ghk-cu','100mg',2882),
  ('thymosin-alpha-1','5mg',3350),
  -- Growth Hormone
  ('cjc-1295-ipamorelin','10mg',2914),
  ('cjc-1295-no-dac','10mg',3500),
  ('tesamorelin','10mg',3414),
  ('ghrp-6','10mg',3300),
  ('ghrp-2','5mg',3300),
  ('hgh-gh-191','24iu',2804), ('hgh-gh-191','36iu',3074),
  ('igf-1-lr3','1mg',3500),
  -- Longevity
  ('nad','500mg',2687), ('nad','1000mg',2921),
  ('ss-31','10mg',3309),
  ('mots-c','10mg',2520),
  ('epithalon','10mg',3300),
  ('glutathione','1500mg',3330),
  -- Cognitive
  ('semax','10mg',3039),
  ('selank','10mg',3264),
  ('cerebrolysin','60mg',3500),
  ('pinealon','10mg',3500),
  ('dsip','10mg',3300), ('dsip','15mg',3300),
  -- Metabolic
  ('5-amino-1mq','50mg',3300),
  ('l-carnitine','6000mg',3300),
  ('lipo-c','10ml',3300),
  ('b12','10ml',3300),
  -- Specialty
  ('pt-141','10mg',3094),
  ('mt-2-melanotan-ii','10mg',2783),
  ('kisspeptin','10mg',3450),
  ('hcg','5000iu',3300),
  ('snap-8','10mg',3300)
) as c(parent_slug, slug_suffix, cost_cents)
join public.products p on p.slug = c.parent_slug
where d.product_id = p.id
  -- Match on the dose suffix, case-insensitively, falling back to the label so
  -- it works whether the vial is stored as "10ml"/"10mL" etc.
  and (lower(d.slug_suffix) = c.slug_suffix or lower(d.label) = c.slug_suffix);

-- 2. Product-level cost = the default (lowest) dose's cost, so a product with no
--    dose selected still costs correctly. Only touches the products above.
update public.products p
set product_cost_cents = d.product_cost_cents,
    updated_at = now()
from public.product_doses d
where d.product_id = p.id
  and d.is_default = true
  and p.slug in (
    'glp-1','glp-2','glp-3','cagrilintide','klow','glow','bpc-157','bpc-157-tb-500',
    'kpv','ghk-cu','thymosin-alpha-1','cjc-1295-ipamorelin','cjc-1295-no-dac',
    'tesamorelin','ghrp-6','ghrp-2','hgh-gh-191','igf-1-lr3','nad','ss-31','mots-c',
    'epithalon','glutathione','semax','selank','cerebrolysin','pinealon','dsip',
    '5-amino-1mq','l-carnitine','lipo-c','b12','pt-141','mt-2-melanotan-ii',
    'kisspeptin','hcg','snap-8'
  );

-- 3. Verify (optional): every dose should now have a cost. Expect 0 rows.
--   select p.slug, d.label, d.product_cost_cents
--   from public.product_doses d join public.products p on p.id = d.product_id
--   where d.product_cost_cents is null or d.product_cost_cents = 0;
