-- ---------------------------------------------------------------------------
-- VANTA LABS — LANDED COST PER UNIT (COGS)
--
-- Costs are per individual vial/unit and already include the supplier's $500
-- inbound shipping spread across the inventory, so nothing further is added.
--
-- Stored in CENTS. Money is never a float here: 18.75 is 1875, and the whole
-- profit system reads integer cents for the same reason.
--
-- WHERE IT LANDS
-- product_doses.product_cost_cents, not products. quote-order.ts resolves a
-- line's cost dose-first and only falls back to the parent, which is right for
-- this catalogue: cost varies per strength, and a single parent figure would be
-- wrong for every strength but one. The parent is set only for products that
-- have no dose rows at all.
--
-- WHAT IT DOES NOT DO
-- Nothing here touches an existing order. order_items.unit_cost_cents was
-- snapshotted when each order was placed, so historical profit is frozen at the
-- cost that applied then and re-running this can never move it. That is the
-- point of the snapshot.
--
-- Cerebrolysin, Pinealon and DSIP 15mg are deliberately absent -- they were not
-- on this invoice. They will keep whatever cost they already had (most likely
-- none), and any order containing them will report COGS as estimated rather
-- than quietly costing them at zero.
-- ---------------------------------------------------------------------------

create temporary table if not exists vl_cogs (
  product_match text not null,   -- matched against products.slug, then name
  dose_match    text,            -- matched against product_doses.label; null = product has no doses
  cost_cents    integer not null
) on commit preserve rows;

truncate vl_cogs;

insert into vl_cogs (product_match, dose_match, cost_cents) values
  -- GLP family
  ('glp-3', '30mg', 1875), ('glp-3', '20mg', 1521), ('glp-3', '10mg', 1047), ('glp-3', '5mg',  632),
  ('glp-2', '30mg', 1280), ('glp-2', '20mg',  963), ('glp-2', '10mg',  613), ('glp-2', '5mg',  438),
  ('glp-1', '30mg',  880), ('glp-1', '20mg',  724), ('glp-1', '10mg',  484), ('glp-1', '5mg',  383),
  -- Blends
  ('klow',  '80mg', 2507),
  ('glow',  '70mg', 2154),
  ('bb20',  '20mg', 1866),
  -- Repair / cosmetic
  ('bpc-157',          '10mg',  659), ('bpc-157', '5mg', 484),
  ('ghk-cu',           '50mg',  365),
  ('cp10',             '10mg', 1112),
  ('cnd',              '10mg', 1345),
  ('tesamorelin',      '10mg', 2033),
  ('cagrilintide',     '10mg', 2182),
  -- Metabolic / longevity
  ('nad',              '1000mg', 843), ('nad', '500mg', 696),
  ('hgh',              '24iu',  1200), ('hgh', '36iu', 1634),
  ('hcg',              '5000iu', 898),
  ('kisspeptin',       '10mg',   898),
  ('ss-31',            '10mg',   898),
  ('glutathione',      '1500mg', 880),
  ('b12',              '10ml',   595),
  ('lipo-c',           '10ml',  1308),
  ('5-amino-1mq',      '50mg',  1066),
  ('l-carnitine',      '10ml',   668),
  -- Growth-hormone secretagogues and peptides
  ('ghrp-6',           '10mg',   521), ('ghrp-6', '5mg', 337),
  ('ghrp-2',           '5mg',    484),
  ('mots-c',           '10mg',   768),
  ('kpv',              '10mg',   622),
  ('igf-1',            '1mg',   2396),
  ('selank',           '10mg',   678),
  ('dsip',             '10mg',   926),
  ('pt-141',           '10mg',   740),
  ('mt-2',             '10mg',   530),
  ('thymosin',         '5mg',   1010),
  ('semax',            '10mg',   586),
  ('epithalon',        '10mg',   549),
  ('snap-8',           '10mg',   484),
  -- Supplies
  ('bacteriostatic-water', '10ml', 143);

-- ---------------------------------------------------------------------------
-- 1. PREVIEW — run this and READ IT before section 2.
--
-- Matching is by name because the ids are yours and this file cannot know them.
-- Everything that matches is resolved to a real dose id below, so the write
-- itself is by id -- but a name match can still land on the wrong row, and the
-- only way to know is to look.
--
-- Check three things:
--   * every cost line found exactly one dose (matched_doses = 1)
--   * nothing you DID buy shows "NO MATCH"
--   * the resolved product name is the one you meant
-- ---------------------------------------------------------------------------
select
  c.product_match,
  c.dose_match,
  c.cost_cents / 100.0                                   as cost_dollars,
  count(d.id)                                            as matched_doses,
  coalesce(string_agg(p.name || ' — ' || d.label, ' | '), 'NO MATCH') as resolved
from vl_cogs c
left join public.products p
       on (p.slug ilike '%' || c.product_match || '%' or p.name ilike '%' || c.product_match || '%')
      and p.is_active = true
left join public.product_doses d
       on d.product_id = p.id
      and replace(lower(d.label), ' ', '') = replace(lower(c.dose_match), ' ', '')
group by c.product_match, c.dose_match, c.cost_cents
order by matched_doses, c.product_match;

-- ---------------------------------------------------------------------------
-- 2. APPLY — only after the preview reads correctly.
--
-- Writes by dose id, and only where a cost line matched EXACTLY ONE dose. An
-- ambiguous match is skipped rather than guessed: costing the wrong strength is
-- invisible in the admin and wrong in every margin thereafter.
-- ---------------------------------------------------------------------------
with resolved as (
  select d.id as dose_id, c.cost_cents,
         count(*) over (partition by c.product_match, c.dose_match) as matches
  from vl_cogs c
  join public.products p
    on (p.slug ilike '%' || c.product_match || '%' or p.name ilike '%' || c.product_match || '%')
   and p.is_active = true
  join public.product_doses d
    on d.product_id = p.id
   and replace(lower(d.label), ' ', '') = replace(lower(c.dose_match), ' ', '')
)
update public.product_doses d
   set product_cost_cents = r.cost_cents
  from resolved r
 where d.id = r.dose_id
   and r.matches = 1
   and d.product_cost_cents is distinct from r.cost_cents;

-- ---------------------------------------------------------------------------
-- 3. VERIFY — every priced dose, and anything still uncosted.
--
-- A null cost is not a failure to fix blindly: Cerebrolysin, Pinealon and
-- DSIP 15mg SHOULD appear here. Anything else in this list was missed.
-- ---------------------------------------------------------------------------
select
  p.name,
  d.label,
  d.product_cost_cents / 100.0 as cost_dollars,
  d.price_cents / 100.0        as price_dollars,
  case
    when d.product_cost_cents is null       then 'NO COST ON FILE'
    when d.product_cost_cents >= d.price_cents then 'SELLING AT OR BELOW COST'
    else 'ok'
  end                          as check
from public.product_doses d
join public.products p on p.id = d.product_id
where p.is_active = true and d.is_enabled = true
order by (d.product_cost_cents is null) desc, p.name, d.position;
