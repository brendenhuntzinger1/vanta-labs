-- ============================================================================
-- VANTA LABS — RECONCILE OLD CATALOG INTO THE EVO CATALOG
-- Moves photos from the old leftover products onto their new EVO equivalents,
-- then ARCHIVES (hides, never deletes) the leftovers. Idempotent + safe to
-- re-run. Nothing is deleted; archived products can be restored in Admin.
-- ============================================================================

with mapping(old_slug, new_slug) as (
  values
    ('glp-1',                    'glp-1-semaglutide'),
    ('glp-2',                    'glp-2-tirzepatide'),
    ('glp-3',                    'glp-3-retatrutide'),
    ('mt-2',                     'mt-2-melanotan-ii'),
    ('nad-plus',                 'nad'),
    ('hgh-191aa',                'hgh-gh-191'),
    ('cjc-1295-ipamorelin-blend','cjc-1295-ipamorelin')
)
-- 1. Move gallery images from each old product to its new one, but only if the
--    new product has no images yet (so we never mix or duplicate galleries).
update public.product_images pi
set product_id = np.id
from mapping m
join public.products op on op.slug = m.old_slug
join public.products np on np.slug = m.new_slug
where pi.product_id = op.id
  and not exists (select 1 from public.product_images x where x.product_id = np.id);

-- 2. Copy the cover photo onto the new product when it doesn't have one.
with mapping(old_slug, new_slug) as (
  values
    ('glp-1',                    'glp-1-semaglutide'),
    ('glp-2',                    'glp-2-tirzepatide'),
    ('glp-3',                    'glp-3-retatrutide'),
    ('mt-2',                     'mt-2-melanotan-ii'),
    ('nad-plus',                 'nad'),
    ('hgh-191aa',                'hgh-gh-191'),
    ('cjc-1295-ipamorelin-blend','cjc-1295-ipamorelin')
)
update public.products np
set image_url = op.image_url, updated_at = now()
from mapping m
join public.products op on op.slug = m.old_slug
where np.slug = m.new_slug
  and coalesce(np.image_url, '') = ''
  and coalesce(op.image_url, '') <> '';

-- 3. Archive the old leftovers (hidden from storefront + admin lists, not deleted).
update public.products
set is_archived = true, is_published = false, is_enabled = false, updated_at = now()
where slug in (
  'glp-1','glp-2','glp-3','mt-2','nad-plus','hgh-191aa','cjc-1295-ipamorelin-blend'
);

-- NOTE: 'ipamorelin' (standalone) is intentionally left ACTIVE — it has no EVO
-- equivalent. To also archive it, uncomment:
--   update public.products set is_archived=true, is_published=false, is_enabled=false, updated_at=now()
--   where slug='ipamorelin';
