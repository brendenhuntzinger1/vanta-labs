-- BAC Water: make the URL say what the page says.
--
-- The product has always displayed as "BAC Water (0.9% Benzyl Alcohol)" and its
-- descriptions have always said BAC Water. Only the slug still read
-- "bacteriostatic-water", and a slug is not an internal detail: Next echoes it
-- into the canonical tag, og:url, the BreadcrumbList, the Product schema's
-- `sku`, and the sitemap entry.
--
-- Counted on production before this change, every occurrence of the long word
-- on the public site traced back to this one string:
--
--     /products                          5
--     /products/bacteriostatic-water    14
--     /sitemap.xml                       1
--     /api/catalog/products              1
--
-- Nothing else in the database carries it. products.name, the descriptions, the
-- SEO fields, the SKU and product_doses were all checked and are already clean.
--
-- WHAT ELSE MOVES WITH IT
--
--   * middleware.ts sends /products/bacteriostatic-water to /products/bac-water
--     with a 308, BEFORE the catalog gate — otherwise an old link would reach
--     the login page and then 404 after signing in. The old address keeps
--     working for a shared link, a bookmark and Google's index.
--   * lib/bac-water.ts lists "bac-water" first in BAC_WATER_SLUG_CANDIDATES and
--     keeps the old slugs resolvable. isBacWater() already matched
--     /bac[-\s]?water/ so the upsell's self-exclusion is unaffected.
--
-- CARTS SURVIVE. A cart line carries `slug::variantId` but validation resolves
-- by dose id whenever a variantId is present, and this product's lines always
-- have one. An in-flight basket is not orphaned by the rename.
--
-- ORDER HISTORY IS NOT TOUCHED. order_items.product_name is a record of what
-- was actually sold under the name it was sold under, and rewriting it would
-- falsify a receipt. It reads "BAC Water" already.

begin;

update public.products
   set slug = 'bac-water',
       updated_at = now()
 where slug = 'bacteriostatic-water';

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
--
--   select slug, name from public.products where name ilike '%bac water%';
--     expected: bac-water | BAC Water (0.9% Benzyl Alcohol)
--
--   select count(*) from public.products
--    where (name || coalesce(slug,'') || coalesce(short_description,'')
--           || coalesce(long_description,'') || coalesce(description,'')
--           || coalesce(seo_title,'') || coalesce(seo_description,''))
--          ~* 'bacteriostatic';
--     expected: 0
--
-- Then, on the deployed site:
--   curl -sI https://www.vantalabsresearch.com/products/bacteriostatic-water
--     expected: 308, Location: /products/bac-water
--   curl -s  https://www.vantalabsresearch.com/sitemap.xml | grep -c bacteriostatic
--     expected: 0
-- ---------------------------------------------------------------------------

-- ROLLBACK:
--   update public.products set slug='bacteriostatic-water', updated_at=now()
--    where slug='bac-water';
-- The middleware redirect is harmless either way: it would simply point at a
-- slug that no longer exists, so remove that entry at the same time.
