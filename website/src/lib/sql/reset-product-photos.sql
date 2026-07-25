-- ============================================================================
-- VANTA LABS — RESET ALL PRODUCT PHOTOS (start from scratch)
-- Clears every product's photo references so new covers can be added cleanly.
-- Only DB references are cleared; files already in Storage are NOT deleted,
-- so this is recoverable. Supabase -> SQL Editor -> paste -> Run.
-- ============================================================================
begin;

-- Cover fallback on the product itself
update public.products set image_url = null, updated_at = now()
 where image_url is not null;

-- Per-dose images (the storefront cover comes from the default dose)
update public.product_doses set image_url = null, updated_at = now()
 where image_url is not null;

-- Gallery / primary image rows
delete from public.product_images;

commit;

-- Verify: everything should read 0.
select
  (select count(*) from public.products      where image_url is not null) as products_with_photo,
  (select count(*) from public.product_doses  where image_url is not null) as doses_with_photo,
  (select count(*) from public.product_images) as gallery_rows;
