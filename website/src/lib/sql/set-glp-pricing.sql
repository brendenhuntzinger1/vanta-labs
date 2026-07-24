-- ============================================================================
-- Vanta Labs — set GLP line to owner-agreed pricing (surgical, idempotent).
--   5mg / 10mg / 20mg / 30mg  =  $49.99 / $74.99 / $119.99 / $149.99
--   Applies to all three GLP compounds: glp-1, glp-2, glp-3.
-- Safe to run against production: touches ONLY the GLP products/doses below.
-- Supabase -> SQL Editor -> paste -> Run. Re-runnable.
-- ============================================================================

-- Dose-level prices (what the site shows per selected dose)
update public.product_doses d set price_cents=4999,  updated_at=now()
  from public.products p
 where p.id=d.product_id
   and p.slug in ('glp-1','glp-2','glp-3')
   and d.slug_suffix='5mg';
update public.product_doses d set price_cents=7499,  updated_at=now()
  from public.products p
 where p.id=d.product_id
   and p.slug in ('glp-1','glp-2','glp-3')
   and d.slug_suffix='10mg';
update public.product_doses d set price_cents=11999, updated_at=now()
  from public.products p
 where p.id=d.product_id
   and p.slug in ('glp-1','glp-2','glp-3')
   and d.slug_suffix='20mg';
update public.product_doses d set price_cents=14999, updated_at=now()
  from public.products p
 where p.id=d.product_id
   and p.slug in ('glp-1','glp-2','glp-3')
   and d.slug_suffix='30mg';

-- Parent "starting at" price = the 5mg default
update public.products set price_cents=4999, updated_at=now()
 where slug in ('glp-1','glp-2','glp-3');

-- Verify
select p.slug, d.slug_suffix, d.price_cents
  from public.product_doses d
  join public.products p on p.id=d.product_id
 where p.slug in ('glp-1','glp-2','glp-3')
 order by p.slug, d.position;
