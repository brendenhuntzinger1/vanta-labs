-- ============================================================================
-- VANTA LABS — GLP legal scrub + owner-agreed pricing (LIVE DB migration)
-- Removes the compound trade names from the storefront entirely: the GLP line
-- becomes simply GLP-1 / GLP-2 / GLP-3 in product names, URLs (slugs), copy,
-- and past order history. Also sets the agreed price schedule.
--   5mg / 10mg / 20mg / 30mg  =  $49.99 / $74.99 / $119.99 / $149.99
-- Idempotent + collision-safe. Nothing is deleted. Wrapped in a transaction.
-- Supabase -> SQL Editor -> paste -> Run.
-- ============================================================================
begin;

-- 1) Free the target slugs: park ANY leftover product already sitting on
--    glp-1/2/3 out of the way (kept + archived, never deleted). Guarded so it
--    only fires while the real product still needs that slug -> safe to re-run.
update public.products set slug='glp-1-legacy-'||id, is_archived=true, is_published=false, is_enabled=false, updated_at=now()
 where slug='glp-1' and exists (select 1 from public.products r where r.slug='glp-1-semaglutide');
update public.products set slug='glp-2-legacy-'||id, is_archived=true, is_published=false, is_enabled=false, updated_at=now()
 where slug='glp-2' and exists (select 1 from public.products r where r.slug='glp-2-tirzepatide');
update public.products set slug='glp-3-legacy-'||id, is_archived=true, is_published=false, is_enabled=false, updated_at=now()
 where slug='glp-3' and exists (select 1 from public.products r where r.slug='glp-3-retatrutide');

-- 2) Rename the active products to clean GLP names + URL slugs.
update public.products set slug='glp-1', name='GLP-1', updated_at=now() where slug='glp-1-semaglutide';
update public.products set slug='glp-2', name='GLP-2', updated_at=now() where slug='glp-2-tirzepatide';
update public.products set slug='glp-3', name='GLP-3', updated_at=now() where slug='glp-3-retatrutide';

-- 2b) Belt-and-suspenders: force the clean name on whatever now holds each slug
--     (covers a DB where the product was already at glp-1/2/3 with a trade name).
update public.products set name='GLP-1', updated_at=now() where slug='glp-1';
update public.products set name='GLP-2', updated_at=now() where slug='glp-2';
update public.products set name='GLP-3', updated_at=now() where slug='glp-3';

-- 3) Scrub the product descriptions (no trade names in the copy).
update public.products set short_description='A GLP-1 receptor agonist peptide. Supplied as a lyophilized powder, third-party batch-tested to >=99% purity. For laboratory research use only.', long_description='GLP-1 is a GLP-1 receptor agonist peptide offered by Vanta Labs as a lyophilized powder for laboratory and in-vitro research. Every batch is independently third-party tested and ships with a Certificate of Analysis confirming >=99% purity, with the lot number matched to its report. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.', description='GLP-1 is a GLP-1 receptor agonist peptide offered by Vanta Labs as a lyophilized powder for laboratory and in-vitro research. Every batch is independently third-party tested and ships with a Certificate of Analysis confirming >=99% purity, with the lot number matched to its report. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.', updated_at=now() where slug='glp-1';
update public.products set short_description='A dual GIP and GLP-1 receptor agonist peptide. Supplied as a lyophilized powder, third-party batch-tested to >=99% purity. For laboratory research use only.', long_description='GLP-2 is a dual GIP and GLP-1 receptor agonist peptide offered by Vanta Labs as a lyophilized powder for laboratory and in-vitro research. Every batch is independently third-party tested and ships with a Certificate of Analysis confirming >=99% purity, with the lot number matched to its report. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.', description='GLP-2 is a dual GIP and GLP-1 receptor agonist peptide offered by Vanta Labs as a lyophilized powder for laboratory and in-vitro research. Every batch is independently third-party tested and ships with a Certificate of Analysis confirming >=99% purity, with the lot number matched to its report. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.', updated_at=now() where slug='glp-2';
update public.products set short_description='A GIP, GLP-1 and glucagon receptor triagonist peptide. Supplied as a lyophilized powder, third-party batch-tested to >=99% purity. For laboratory research use only.', long_description='GLP-3 is a GIP, GLP-1 and glucagon receptor triagonist peptide offered by Vanta Labs as a lyophilized powder for laboratory and in-vitro research. Every batch is independently third-party tested and ships with a Certificate of Analysis confirming >=99% purity, with the lot number matched to its report. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.', description='GLP-3 is a GIP, GLP-1 and glucagon receptor triagonist peptide offered by Vanta Labs as a lyophilized powder for laboratory and in-vitro research. Every batch is independently third-party tested and ships with a Certificate of Analysis confirming >=99% purity, with the lot number matched to its report. For laboratory research use only. Not for human or veterinary consumption; not a drug, food, cosmetic, or dietary supplement, and not intended to diagnose, treat, cure, or prevent any condition.', updated_at=now() where slug='glp-3';

-- 4) Scrub the trade names out of past order-line snapshots (e.g. "GLP-1
--    Semaglutide 5mg" -> "GLP-1 5mg") so order history/admin never show them.
update public.order_items set product_name =
  replace(replace(replace(replace(replace(replace(product_name,
    'GLP-1 Semaglutide','GLP-1'),'GLP-2 Tirzepatide','GLP-2'),'GLP-3 Retatrutide','GLP-3'),
    'Semaglutide','GLP-1'),'Tirzepatide','GLP-2'),'Retatrutide','GLP-3')
where product_name ~* 'semaglutide|tirzepatide|retatrutide';

-- 5) Owner-agreed price schedule (per dose) + parent "starting at" price.
update public.product_doses d set price_cents=4999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug in ('glp-1','glp-2','glp-3') and d.slug_suffix='5mg';
update public.product_doses d set price_cents=7499,  updated_at=now() from public.products p where p.id=d.product_id and p.slug in ('glp-1','glp-2','glp-3') and d.slug_suffix='10mg';
update public.product_doses d set price_cents=11999, updated_at=now() from public.products p where p.id=d.product_id and p.slug in ('glp-1','glp-2','glp-3') and d.slug_suffix='20mg';
update public.product_doses d set price_cents=14999, updated_at=now() from public.products p where p.id=d.product_id and p.slug in ('glp-1','glp-2','glp-3') and d.slug_suffix='30mg';
update public.products set price_cents=4999, updated_at=now() where slug in ('glp-1','glp-2','glp-3');

commit;

-- Verify: names, slugs, and per-dose prices should all read GLP-1/2/3.
select p.slug, p.name, d.slug_suffix, d.price_cents
  from public.product_doses d
  join public.products p on p.id=d.product_id
 where p.slug in ('glp-1','glp-2','glp-3')
 order by p.slug, d.position;
