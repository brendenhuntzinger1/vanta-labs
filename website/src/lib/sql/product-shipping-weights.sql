-- ---------------------------------------------------------------------------
-- VANTA LABS — REAL SHIPPING WEIGHTS
--
-- Sets the measured weights so fulfillment never types one in by hand.
-- Additive, idempotent, and it touches nothing but weight columns.
--
--   peptide vial (3 mL glass)      10 g  ->  0.36 oz
--   bacteriostatic water 10 mL     30 g  ->  1.06 oz
--   bacteriostatic water 30 mL     65 g  ->  2.30 oz
--   bubble mailer + packing        30 g  ->  1.06 oz   (parcel tare, once)
--
-- Grams are the unit these were actually weighed in. Ounces are what Shippo
-- takes, and the conversion rounds UP at every step -- an under-declared parcel
-- earns a carrier adjustment that costs far more than the hundredth of an ounce
-- rounding down would have saved. This matches gramsToOz() in
-- src/lib/shippo/parcel.ts exactly, deliberately: two rounding rules would put
-- the admin display and the label at different numbers.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. PREVIEW — run this ALONE first and read it.
--
-- Section 2 decides "is this a peptide?" by exclusion: everything that is not
-- bacteriostatic water. That is right for the catalogue as it stands, and it
-- would be wrong the moment a heavy non-peptide SKU is added. So look at the
-- list before writing to it.
-- ---------------------------------------------------------------------------
select
  p.slug,
  p.name,
  p.shipping_weight_oz                              as current_oz,
  case when p.slug = 'bacteriostatic-water' then 'water (per-dose, see below)'
       else '0.36 oz  (10 g vial)' end              as will_become
from public.products p
order by (p.slug = 'bacteriostatic-water') desc, p.name;

-- ---------------------------------------------------------------------------
-- 2. Peptide vials — 10 g each.
--
-- Bacteriostatic water is excluded here because its weight is per-SIZE, not
-- per-product: a 10 mL and a 30 mL bottle share one products row.
-- ---------------------------------------------------------------------------
update public.products
   set shipping_weight_oz = 0.36
 where slug is distinct from 'bacteriostatic-water'
   and shipping_weight_oz is distinct from 0.36;

-- ---------------------------------------------------------------------------
-- 3. Bacteriostatic water — weight lives on the dose row.
--
-- product_doses.shipping_weight_oz overrides the parent when set, so the parent
-- row's own value is never consulted for a sized purchase. It is still given a
-- sane figure below, as the fallback if a dose is ever added without a weight.
-- Matching is on slug_suffix, which is the stable key; label is display text
-- and can be re-worded.
-- ---------------------------------------------------------------------------
update public.product_doses d
   set shipping_weight_oz = case d.slug_suffix
                              when '10ml' then 1.06   -- 30 g
                              when '30ml' then 2.30   -- 65 g
                            end
  from public.products p
 where p.id = d.product_id
   and p.slug = 'bacteriostatic-water'
   and d.slug_suffix in ('10ml', '30ml');

update public.products
   set shipping_weight_oz = 1.06
 where slug = 'bacteriostatic-water'
   and shipping_weight_oz is distinct from 1.06;

-- ---------------------------------------------------------------------------
-- 4. Packaging tare — 30 g, added ONCE per parcel.
--
-- Only the default preset is touched. Any other box the owner has configured
-- has its own real tare and must keep it; overwriting every row with the
-- mailer's weight would make a boxed shipment declare light.
-- ---------------------------------------------------------------------------
update public.shipping_package_presets
   set empty_weight_oz = 1.06,
       updated_at      = now()
 where is_default
   and empty_weight_oz is distinct from 1.06;

-- ---------------------------------------------------------------------------
-- VERIFY — every row below should read as expected, and no weight may be null
-- or zero. A null here is what makes an order flag "Weight review required".
-- ---------------------------------------------------------------------------
select 'product' as kind, p.name as item, p.shipping_weight_oz as oz
  from public.products p
 where p.slug is distinct from 'bacteriostatic-water'
union all
select 'water dose', p.name || ' ' || d.label, d.shipping_weight_oz
  from public.product_doses d
  join public.products p on p.id = d.product_id
 where p.slug = 'bacteriostatic-water'
union all
select 'packaging', name, empty_weight_oz
  from public.shipping_package_presets
 where is_default
 order by kind, item;
