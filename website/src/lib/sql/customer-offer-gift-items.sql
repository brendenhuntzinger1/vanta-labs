-- ===========================================================================
-- A GIFT THAT GRANTS MORE THAN ONE KIND OF THING.
--
-- WHAT WAS MISSING. An offer could grant N units of ONE product: `product_slug`
-- is a single column and `quantity` counts units of it. That covers "two BAC
-- Water" and cannot express "a GLOW and a GHK-Cu and a BAC Water", which is the
-- top tier of the cart-recovery ladder.
--
-- WHY IT MATTERS COMMERCIALLY. At this store's real dose costs a gift is the
-- cheapest thing it can give: GHK-Cu costs $3.65 and shows the customer $39.99,
-- BAC Water costs $1.43 and shows $14.99. A percentage costs ~12-14% of
-- contribution on any cart. So the efficient recovery offer is MORE PRODUCT and
-- LESS DISCOUNT — and stacking products is exactly what the schema could not do.
--
-- THE SHAPE. `gift_items` is an array of {slug, quantity, variantId?}:
--
--   [{"slug":"klow","quantity":1},
--    {"slug":"ghk-cu","quantity":1},
--    {"slug":"bac-water","quantity":1}]
--
-- Two new reward kinds use it, and nothing else changes:
--
--   free_products          the items, no percentage
--   free_products_percent  the items, plus a percentage
--
-- WHY NOT REUSE free_product WITH AN ARRAY. Because the existing kinds are load
-- bearing in code that must keep working unchanged: `product_slug` is read by
-- quoteOrder, the cart banner, marketing-source attribution and every offer
-- minted before today. Adding kinds leaves all of that untouched — an old row
-- still says exactly what it always said.
--
-- THE CHECK IS EXTENDED, NOT REPLACED. Its job is to make an impossible reward
-- unstorable: a percentage kind with no percentage, a product kind with no
-- product. The two new rows say the same thing about gift_items — it must be a
-- non-empty array, and the single-product columns must be null so there is
-- never a row with two different answers to "what does this grant".
--
-- Idempotent and safe to re-run.
-- ===========================================================================

alter table if exists public.customer_offers
  add column if not exists gift_items jsonb;

comment on column public.customer_offers.gift_items is
  'For the free_products / free_products_percent kinds: the products this gift grants, as [{slug, quantity, variantId?}]. Null for every single-product kind, which uses product_slug and quantity instead.';

-- The reward-shape rule, restated whole so the two new kinds sit beside the
-- four that already existed rather than in a second constraint that could
-- disagree with this one.
alter table public.customer_offers
  drop constraint if exists customer_offers_reward_shape;

alter table public.customer_offers
  add constraint customer_offers_reward_shape check (
    (reward_kind = 'free_product'
      and product_slug is not null and percent_off is null and gift_items is null)
    or (reward_kind = 'free_shipping'
      and product_slug is null and percent_off is null and gift_items is null)
    or (reward_kind = any (array['free_shipping_percent', 'percent'])
      and product_slug is null and gift_items is null
      and percent_off is not null and percent_off > 0 and percent_off <= 100)
    or (reward_kind = 'free_product_percent'
      and product_slug is not null and gift_items is null
      and percent_off is not null and percent_off > 0 and percent_off <= 100)
    -- NEW: several different products, with and without a percentage.
    or (reward_kind = 'free_products'
      and product_slug is null and quantity is null and percent_off is null
      and jsonb_typeof(gift_items) = 'array' and jsonb_array_length(gift_items) > 0)
    or (reward_kind = 'free_products_percent'
      and product_slug is null and quantity is null
      and percent_off is not null and percent_off > 0 and percent_off <= 100
      and jsonb_typeof(gift_items) = 'array' and jsonb_array_length(gift_items) > 0)
  );

-- `quantity` counts units of the single `product_slug`, so it stays tied to it.
-- The multi-product kinds carry their counts INSIDE gift_items, which is why
-- the constraint above requires quantity to be null for them.
alter table public.customer_offers
  drop constraint if exists customer_offers_quantity_shape;

alter table public.customer_offers
  add constraint customer_offers_quantity_shape check (
    (quantity is null or quantity >= 1)
    and (quantity is null or product_slug is not null)
  );
