-- ============================================================================
-- VANTA LABS — EVO CATALOG (GROUPED: one product, pick your dose)
-- 37 products, each with its mg-strength doses as selectable variants (51 doses
-- total), priced + costed from the EVO wholesale sheet. This is the layout you
-- asked for: the storefront shows ONE product per peptide, and the dose
-- selector on the product page switches price/cost/stock.
--
-- Safe to re-run (upsert by slug + by dose). It PRESERVES any photo already set
-- on a matching product (never overwrites image_url). It does NOT delete
-- anything. Supabase -> SQL Editor -> New query -> paste -> Run.
--
-- NOTE: run fix-product-columns.sql FIRST (it guarantees the cost/dose columns
-- this script writes to exist).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Parent products (one per peptide). Parent price = the default (lowest) dose.
--    On conflict we refresh name/category/price/cost but KEEP the existing photo.
-- ---------------------------------------------------------------------------
insert into public.products
  (slug, name, category, price_cents, product_cost_cents, is_featured, position,
   is_published, is_enabled, is_active, is_archived, stock_status, inventory_quantity)
select v.slug, v.name, v.category, v.price_cents, v.cost_cents, v.is_featured, v.position,
       true, true, true, false, 'In Stock', 100
from (values
  ('glp-1-semaglutide',    'GLP-1 Semaglutide',      'GLP Research',    4299, 2456, true,  0),
  ('glp-2-tirzepatide',    'GLP-2 Tirzepatide',      'GLP Research',    4799, 2376, true,  1),
  ('glp-3-retatrutide',    'GLP-3 Retatrutide',      'GLP Research',    5499, 2306, true,  2),
  ('cagrilintide',         'Cagrilintide',           'GLP Research',    7999, 3500, false, 3),
  ('klow',                 'KLOW',                   'Blends',         10999, 3500, false, 4),
  ('glow',                 'GLOW',                   'Blends',          9499, 3500, false, 5),
  ('bpc-157',              'BPC-157',                'Healing',         4299, 2506, true,  6),
  ('bpc-157-tb-500',       'BPC-157 + TB-500',       'Healing',         7499, 3398, false, 7),
  ('kpv',                  'KPV',                    'Healing',         4999, 3147, false, 8),
  ('ghk-cu',               'GHK-Cu',                 'Healing',         4799, 2288, false, 9),
  ('thymosin-alpha-1',     'Thymosin Alpha-1',       'Healing',         5999, 3350, false, 10),
  ('cjc-1295-ipamorelin',  'CJC-1295 + Ipamorelin',  'Growth Hormone',  6499, 2914, true,  11),
  ('cjc-1295-no-dac',      'CJC-1295 no DAC',        'Growth Hormone',  5999, 3500, false, 12),
  ('tesamorelin',          'Tesamorelin',            'Growth Hormone',  7499, 3414, false, 13),
  ('ghrp-6',               'GHRP-6',                 'Growth Hormone',  4799, 3300, false, 14),
  ('ghrp-2',               'GHRP-2',                 'Growth Hormone',  4799, 3300, false, 15),
  ('hgh-gh-191',           'HGH GH-191',             'Growth Hormone',  9999, 2804, false, 16),
  ('igf-1-lr3',            'IGF-1 LR3',              'Growth Hormone',  7499, 3500, false, 17),
  ('nad',                  'NAD+',                   'Longevity',       5499, 2687, true,  18),
  ('ss-31',                'SS-31',                  'Longevity',       7499, 3309, false, 19),
  ('mots-c',               'MOTS-C',                 'Longevity',       5499, 2520, false, 20),
  ('epithalon',            'Epithalon',              'Longevity',       4999, 3300, false, 21),
  ('glutathione',          'Glutathione',            'Longevity',       5499, 3330, false, 22),
  ('semax',                'Semax',                  'Cognitive',       4999, 3039, false, 23),
  ('selank',               'Selank',                 'Cognitive',       4999, 3264, false, 24),
  ('cerebrolysin',         'Cerebrolysin',           'Cognitive',       7499, 3500, false, 25),
  ('pinealon',             'Pinealon',               'Cognitive',       4999, 3500, false, 26),
  ('dsip',                 'DSIP',                   'Cognitive',       4499, 3300, false, 27),
  ('5-amino-1mq',          '5-Amino-1MQ',            'Metabolic',       5999, 3300, false, 28),
  ('l-carnitine',          'L-Carnitine',            'Metabolic',       4999, 3300, false, 29),
  ('lipo-c',               'LIPO-C',                 'Metabolic',       4999, 3300, false, 30),
  ('b12',                  'B12',                    'Metabolic',       4999, 3300, false, 31),
  ('pt-141',               'PT-141',                 'Specialty',       4999, 3094, false, 32),
  ('mt-2-melanotan-ii',    'MT-2 Melanotan II',      'Specialty',       4799, 2783, false, 33),
  ('kisspeptin',           'Kisspeptin',             'Specialty',       5499, 3450, false, 34),
  ('hcg',                  'HCG',                    'Specialty',       5499, 3300, false, 35),
  ('snap-8',               'SNAP-8',                 'Specialty',       4499, 3300, false, 36)
) as v(slug, name, category, price_cents, cost_cents, is_featured, position)
on conflict (slug) do update set
  name=excluded.name, category=excluded.category, price_cents=excluded.price_cents,
  product_cost_cents=excluded.product_cost_cents, is_featured=excluded.is_featured,
  is_published=true, is_enabled=true, is_active=true, is_archived=false,
  stock_status='In Stock', updated_at=now();
  -- (image_url intentionally NOT updated → existing product photos are preserved)

-- ---------------------------------------------------------------------------
-- 2. Dose variants (51). Each carries its own price + wholesale cost so the
--    profit guard is correct per strength. Upsert by (product_id, slug_suffix).
-- ---------------------------------------------------------------------------
insert into public.product_doses
  (product_id, label, slug_suffix, price_cents, product_cost_cents,
   is_default, is_enabled, position, stock_status, inventory_quantity)
select p.id, d.label, d.slug_suffix, d.price_cents, d.cost_cents,
       d.is_default, true, d.position, 'In Stock', 100
from (values
  -- GLP Research
  ('glp-1-semaglutide','5mg','5mg',   4299, 2456, true,  0),
  ('glp-1-semaglutide','10mg','10mg', 6499, 2537, false, 1),
  ('glp-1-semaglutide','20mg','20mg',10999, 2690, false, 2),
  ('glp-1-semaglutide','30mg','30mg',14499, 2780, false, 3),
  ('glp-2-tirzepatide','5mg','5mg',   4799, 2376, true,  0),
  ('glp-2-tirzepatide','10mg','10mg', 7499, 2484, false, 1),
  ('glp-2-tirzepatide','20mg','20mg',12499, 2646, false, 2),
  ('glp-2-tirzepatide','30mg','30mg',16499, 2826, false, 3),
  ('glp-3-retatrutide','5mg','5mg',   5499, 2306, true,  0),
  ('glp-3-retatrutide','10mg','10mg', 9499, 2405, false, 1),
  ('glp-3-retatrutide','20mg','20mg',15499, 2729, false, 2),
  ('glp-3-retatrutide','30mg','30mg',19999, 3026, false, 3),
  ('cagrilintide','10mg','10mg',      7999, 3500, true,  0),
  -- Blends
  ('klow','80mg','80mg',             10999, 3500, true,  0),
  ('glow','70mg','70mg',              9499, 3500, true,  0),
  -- Healing
  ('bpc-157','5mg','5mg',             4299, 2506, true,  0),
  ('bpc-157','10mg','10mg',           5999, 2569, false, 1),
  ('bpc-157-tb-500','20mg','20mg',    7499, 3398, true,  0),
  ('kpv','10mg','10mg',               4999, 3147, true,  0),
  ('ghk-cu','50mg','50mg',            4799, 2288, true,  0),
  ('ghk-cu','100mg','100mg',          7499, 2882, false, 1),
  ('thymosin-alpha-1','5mg','5mg',    5999, 3350, true,  0),
  -- Growth Hormone
  ('cjc-1295-ipamorelin','10mg','10mg',6499, 2914, true, 0),
  ('cjc-1295-no-dac','10mg','10mg',   5999, 3500, true,  0),
  ('tesamorelin','10mg','10mg',       7499, 3414, true,  0),
  ('ghrp-6','10mg','10mg',            4799, 3300, true,  0),
  ('ghrp-2','5mg','5mg',              4799, 3300, true,  0),
  ('hgh-gh-191','24iu','24iu',        9999, 2804, true,  0),
  ('hgh-gh-191','36iu','36iu',       13999, 3074, false, 1),
  ('igf-1-lr3','1mg','1mg',           7499, 3500, true,  0),
  -- Longevity
  ('nad','500mg','500mg',             5499, 2687, true,  0),
  ('nad','1000mg','1000mg',           8999, 2921, false, 1),
  ('ss-31','10mg','10mg',             7499, 3309, true,  0),
  ('mots-c','10mg','10mg',            5499, 2520, true,  0),
  ('epithalon','10mg','10mg',         4999, 3300, true,  0),
  ('glutathione','1500mg','1500mg',   5499, 3330, true,  0),
  -- Cognitive
  ('semax','10mg','10mg',             4999, 3039, true,  0),
  ('selank','10mg','10mg',            4999, 3264, true,  0),
  ('cerebrolysin','60mg','60mg',      7499, 3500, true,  0),
  ('pinealon','10mg','10mg',          4999, 3500, true,  0),
  ('dsip','10mg','10mg',              4499, 3300, true,  0),
  ('dsip','15mg','15mg',              5499, 3300, false, 1),
  -- Metabolic
  ('5-amino-1mq','50mg','50mg',       5999, 3300, true,  0),
  ('l-carnitine','6000mg','6000mg',   4999, 3300, true,  0),
  ('lipo-c','10mL','10ml',            4999, 3300, true,  0),
  ('b12','10mL','10ml',               4999, 3300, true,  0),
  -- Specialty
  ('pt-141','10mg','10mg',            4999, 3094, true,  0),
  ('mt-2-melanotan-ii','10mg','10mg', 4799, 2783, true,  0),
  ('kisspeptin','10mg','10mg',        5499, 3450, true,  0),
  ('hcg','5000iu','5000iu',           5499, 3300, true,  0),
  ('snap-8','10mg','10mg',            4499, 3300, true,  0)
) as d(parent_slug, label, slug_suffix, price_cents, cost_cents, is_default, position)
join public.products p on p.slug = d.parent_slug
on conflict (product_id, slug_suffix) do update set
  label=excluded.label, price_cents=excluded.price_cents,
  product_cost_cents=excluded.product_cost_cents, is_default=excluded.is_default,
  is_enabled=true, stock_status='In Stock', updated_at=now();

-- ---------------------------------------------------------------------------
-- 3. Verify (optional): should return 37 products and 51 doses.
--   select count(*) from public.products where slug in
--     ('glp-1-semaglutide','glp-2-tirzepatide','glp-3-retatrutide','cagrilintide',
--      'klow','glow','bpc-157','bpc-157-tb-500','kpv','ghk-cu','thymosin-alpha-1',
--      'cjc-1295-ipamorelin','cjc-1295-no-dac','tesamorelin','ghrp-6','ghrp-2',
--      'hgh-gh-191','igf-1-lr3','nad','ss-31','mots-c','epithalon','glutathione',
--      'semax','selank','cerebrolysin','pinealon','dsip','5-amino-1mq','l-carnitine',
--      'lipo-c','b12','pt-141','mt-2-melanotan-ii','kisspeptin','hcg','snap-8');
-- ---------------------------------------------------------------------------
