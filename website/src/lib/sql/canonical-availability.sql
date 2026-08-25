-- =============================================================================
-- THE CORRECT WAY TO ASK "WHAT CAN A CUSTOMER BUY RIGHT NOW?"
--
-- READ-ONLY. Nothing here writes. Run it before believing any claim about
-- stock, including one made by an audit.
--
-- WHY THIS FILE EXISTS
--
-- An audit reported "17 of 38 published products are sold out". It was wrong.
-- The query was:
--
--   select count(*) from products
--    where is_published and track_inventory and coalesce(inventory_quantity,0) <= 0;
--
-- products.inventory_quantity is NOT the shelf for a product sold through
-- doses. product_doses.inventory_quantity is. Of the seventeen it flagged,
-- FIFTEEN had stock sitting on their doses — 553 units the query could not
-- see. The true figure was two.
--
-- The application was never wrong. catalog.ts takes availability from the
-- DEFAULT DOSE when one exists and only falls back to the parent row for an
-- undosed product; quote-order.ts keys its oversell guard on the dose id; the
-- admin inventory screen emits one line per dose, which is why the owner's own
-- total (1139 units) reconciles against the dose table and not the parent one.
--
-- TWO PLACES STOCK CAN LIVE, AND ONE RULE FOR CHOOSING
--
--   product HAS an enabled dose  -> the default dose's count is the shelf
--   product has NO enabled dose  -> the parent row's count is the shelf
--
-- "Default dose" is the enabled dose ordered by (is_default desc, position asc).
-- Availability is on-hand MINUS reserved_quantity, floored at zero — a unit
-- someone is holding mid-checkout is not one this shopper can have.
-- =============================================================================

with dose_ranked as (
  select d.*,
         row_number() over (
           partition by d.product_id
           order by d.is_default desc nulls last, d.position asc nulls last, d.id asc
         ) as rn
  from public.product_doses d
  where coalesce(d.is_enabled, true)
),
default_dose as (select * from dose_ranked where rn = 1),
availability as (
  select p.slug,
         p.name,
         dd.id is not null as sold_via_doses,
         -- The shelf, chosen by the rule above.
         case when dd.id is not null
              then greatest(0, coalesce(dd.inventory_quantity, 0) - coalesce(dd.reserved_quantity, 0))
              else greatest(0, coalesce(p.inventory_quantity, 0)  - coalesce(p.reserved_quantity, 0))
         end as headline_available,
         -- Every enabled dose, because a shopper may pick any of them.
         coalesce((
           select sum(greatest(0, coalesce(x.inventory_quantity, 0) - coalesce(x.reserved_quantity, 0)))
             from public.product_doses x
            where x.product_id = p.id and coalesce(x.is_enabled, true)
         ), 0) as all_variants_available
  from public.products p
  left join default_dose dd on dd.product_id = p.id
  where p.is_published
)
select
  count(*)                                                   as published_products,
  count(*) filter (where headline_available > 0)             as buyable_now,
  count(*) filter (where headline_available = 0)             as out_of_stock,
  -- Should always be 0. A product whose headline reads empty while another
  -- variant has stock would show "Out of Stock" on the card and hide sellable
  -- units behind it.
  count(*) filter (where headline_available = 0 and all_variants_available > 0)
                                                             as hidden_sellable_variants,
  sum(all_variants_available)                                as total_sellable_units
from availability;

-- Per-product detail. Use this, not products.inventory_quantity, whenever the
-- question is "can someone buy this".
--
-- select slug, name, sold_via_doses, headline_available, all_variants_available
--   from availability order by headline_available, slug;
