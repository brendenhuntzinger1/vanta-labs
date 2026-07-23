-- ============================================================================
-- VANTA LABS — FEATURE TOP SELLERS + CLEAR TWO WRONG IMAGES
-- Marks the best-selling peptides as featured (they sort first under the
-- "Featured" view and can headline the homepage), and clears the mismatched
-- images on KLOW and BPC-157 + TB-500 so they fall back to a clean placeholder
-- until the correct vial photo is uploaded in Admin. Idempotent.
-- ============================================================================

-- Top sellers → featured (clean slate first, then set the winners).
update public.products set is_featured = false where is_featured = true;
update public.products set is_featured = true, updated_at = now()
where slug in (
  'glp-1-semaglutide','glp-2-tirzepatide','glp-3-retatrutide',
  'bpc-157','bpc-157-tb-500','cjc-1295-ipamorelin','nad','ghk-cu','klow','glow'
);

-- Clear the wrong (screenshot) images on these two so the card shows a clean
-- placeholder instead. Re-upload the correct vial in Admin -> Products.
update public.products set image_url = null, updated_at = now()
where slug in ('klow','bpc-157-tb-500');
delete from public.product_images
where product_id in (select id from public.products where slug in ('klow','bpc-157-tb-500'));
