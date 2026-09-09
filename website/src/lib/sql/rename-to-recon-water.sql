-- Recon Water: retire "BAC water" / "bacteriostatic water" everywhere a
-- customer can read it.
--
-- The catalogue row was already renamed by hand in admin before this ran:
--   products.name             "Recon water (0.9% Benzyl Alcohol)"
--   short_description         "Recon water (0.9% benzyl alcohol) ..."
--   long_description          "Recon water (0.9% benzyl alcohol) ..."
-- Only the SLUG still said bac-water, and a slug is not an internal detail --
-- Next echoes it into the canonical tag, og:url, the BreadcrumbList, the
-- Product schema's `sku` and the sitemap. Same reasoning as
-- rename-bac-water-slug.sql, one rename further along.
--
-- WHAT ELSE MOVES WITH IT, AND WHY EACH ONE MATTERS
--
--   * customer_offers.product_slug -- 5 LIVE, UNREDEEMED offers point at
--     "bac-water". quote-order resolves a gift by exact slug match, so
--     renaming the product without these would promise a free vial and ship
--     none. That is not hypothetical: the comment in offers/customer-offers.ts
--     records it happening during the LAST rename, and the suite stayed green
--     because the mock carried the same stale literal.
--
--   * abandoned_carts.items -- a cart snapshot stores the name, slug AND image
--     as they were when the cart was abandoned. 16 rows carry
--     "Bacteriostatic Water (0.9% Benzyl Alcohol)" and an image_url this
--     migration is about to delete, so an untouched row would send a recovery
--     email showing the retired name next to a broken image. 10 of them
--     (active + held) can still send.
--
--   * email_automations.winback_30 -- a LIVE automation whose body reads
--     "plus a free BAC Water on us". It keeps sending until it is changed.
--
-- WHAT IS DELIBERATELY NOT TOUCHED
--
--   * order_items.product_name -- a receipt records what was sold under the
--     name it was sold under. Rewriting it would falsify it. 20 rows keep the
--     old name, exactly as rename-bac-water-slug.sql decided last time.
--
--   * inventory_reservations.slug -- 20 rows, every one already 'finalized'
--     or 'released'. Historical ledger, nothing live reads them.
--
--   * back_in_stock_requests / wishlist_items / product_subscriptions -- all
--     checked, zero rows carry any old slug.

begin;

-- ---------------------------------------------------------------------------
-- 1. The product's public address.
-- ---------------------------------------------------------------------------
update public.products
   set slug = 'recon-water',
       updated_at = now()
 where slug = 'bac-water';

-- ---------------------------------------------------------------------------
-- 2. Live gift offers must keep resolving to a real catalogue row.
-- ---------------------------------------------------------------------------
update public.customer_offers
   set product_slug = 'recon-water'
 where product_slug in ('bac-water', 'bacteriostatic-water', 'bac-water-30ml');

-- ---------------------------------------------------------------------------
-- 3. Forgotten-cart snapshots: name, slug and image, in place, order kept.
--
-- The image is repointed at the one surviving product photo; the five it used
-- to be able to point at are deleted in step 5 and would 404 in the email.
-- ---------------------------------------------------------------------------
update public.abandoned_carts ac
   set items = sub.new_items
  from (
    select inner_ac.id,
           jsonb_agg(
             case
               when elem->>'slug' in ('bac-water', 'bacteriostatic-water', 'bac-water-30ml')
                 then elem || jsonb_build_object(
                        'slug', 'recon-water',
                        'name', 'Recon water (0.9% Benzyl Alcohol)',
                        'image', 'https://mlpimwgkwuqpsvsrlpqv.supabase.co/storage/v1/object/public/product-images/b123e67e-a02f-4958-9a34-f2c535c45991/1788991133320-f5e787fa-112a-45d7-98f0-c817f9b934ea.jpg')
               else elem
             end
             order by ord
           ) as new_items
      from public.abandoned_carts inner_ac,
           lateral jsonb_array_elements(inner_ac.items) with ordinality as t(elem, ord)
     where inner_ac.items::text ~* 'bac[ _-]?water|bacteriostatic'
     group by inner_ac.id
  ) sub
 where ac.id = sub.id;

-- ---------------------------------------------------------------------------
-- 4. The live win-back automation stops promising "a free BAC Water".
-- ---------------------------------------------------------------------------
update public.email_automations
   set body     = replace(replace(body,     'BAC Water', 'Recon Water'), 'BAC water', 'Recon water'),
       subject  = replace(replace(subject,  'BAC Water', 'Recon Water'), 'BAC water', 'Recon water'),
       headline = replace(replace(headline, 'BAC Water', 'Recon Water'), 'BAC water', 'Recon water')
 where (coalesce(body, '') || coalesce(subject, '') || coalesce(headline, ''))
       ~ 'BAC [Ww]ater';

-- ---------------------------------------------------------------------------
-- 5. One product photo: the new Recon Water shot.
--
-- Five older images are removed. Position 4 was already a 0-byte upload
-- rendering as a broken thumbnail on the live product page.
-- ---------------------------------------------------------------------------
delete from public.product_images
 where product_id = 'b123e67e-a02f-4958-9a34-f2c535c45991'
   and id <> 'af977fb7-3183-4bb9-ae5d-df3ff13e5b29';

update public.product_images
   set is_primary = true,
       "position" = 1
 where id = 'af977fb7-3183-4bb9-ae5d-df3ff13e5b29';

commit;

-- ---------------------------------------------------------------------------
-- VERIFY
--
--   select slug, name from public.products
--    where id = 'b123e67e-a02f-4958-9a34-f2c535c45991';
--     expected: recon-water | Recon water (0.9% Benzyl Alcohol)
--
--   select count(*) from public.customer_offers
--    where product_slug ~* 'bac[ _-]?water|bacteriostatic';
--     expected: 0
--
--   select count(*) from public.abandoned_carts
--    where items::text ~* 'BAC [Ww]ater|[Bb]acteriostatic';
--     expected: 0
--
--   select count(*) from public.email_automations
--    where (coalesce(body,'')||coalesce(subject,'')||coalesce(headline,''))
--          ~* 'bac[ _-]?water|bacteriostatic';
--     expected: 0
--
--   select count(*), bool_and(is_primary) from public.product_images
--    where product_id = 'b123e67e-a02f-4958-9a34-f2c535c45991';
--     expected: 1 | true
--
-- Then, on the deployed site:
--   curl -sI https://www.vantalabsresearch.com/products/bac-water
--     expected: 308, Location: /products/recon-water
--   curl -s https://www.vantalabsresearch.com/sitemap.xml | grep -ci 'bac-water'
--     expected: 0
-- ---------------------------------------------------------------------------

-- ROLLBACK (slug and offers only -- the deleted images cannot be restored
-- from here, and the storage objects they pointed at still exist):
--   update public.products set slug='bac-water', updated_at=now()
--    where slug='recon-water';
--   update public.customer_offers set product_slug='bac-water'
--    where product_slug='recon-water';
-- Remove the ["/products/bac-water", "/products/recon-water"] entry from
-- middleware.ts at the same time, or it will redirect to a dead slug.
