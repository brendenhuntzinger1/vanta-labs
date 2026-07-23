-- ============================================================================
-- VANTA LABS — APPLY RECOMMENDED PRICING
-- Raises 21 standalone products to a ~52% margin floor at base EVO cost and
-- syncs each parent product's headline price to its default dose. Hero-line
-- entry doses (GLP 5mg, BPC-157 5mg, GHK-Cu 50mg, NAD+ 500mg) are intentionally
-- left as loss-leaders. Fully reversible in Admin -> Products. Idempotent.
-- Run in Supabase -> SQL Editor. See PRICING_STRATEGY.md for the rationale.
-- ============================================================================

update public.product_doses d set price_cents=6599, updated_at=now() from public.products p where p.id=d.product_id and p.slug='kpv' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6999, updated_at=now() from public.products p where p.id=d.product_id and p.slug='thymosin-alpha-1' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=7299, updated_at=now() from public.products p where p.id=d.product_id and p.slug='cjc-1295-no-dac' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='ghrp-6' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='ghrp-2' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='epithalon' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6999, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glutathione' and d.slug_suffix='1500mg';
update public.product_doses d set price_cents=6399, updated_at=now() from public.products p where p.id=d.product_id and p.slug='semax' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='selank' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=7299, updated_at=now() from public.products p where p.id=d.product_id and p.slug='pinealon' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='dsip' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='dsip' and d.slug_suffix='15mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='5-amino-1mq' and d.slug_suffix='50mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='l-carnitine' and d.slug_suffix='6000mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='lipo-c' and d.slug_suffix='10ml';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='b12' and d.slug_suffix='10ml';
update public.product_doses d set price_cents=6499, updated_at=now() from public.products p where p.id=d.product_id and p.slug='pt-141' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5799, updated_at=now() from public.products p where p.id=d.product_id and p.slug='mt-2-melanotan-ii' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=7199, updated_at=now() from public.products p where p.id=d.product_id and p.slug='kisspeptin' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='hcg' and d.slug_suffix='5000iu';
update public.product_doses d set price_cents=6899, updated_at=now() from public.products p where p.id=d.product_id and p.slug='snap-8' and d.slug_suffix='10mg';

-- Keep each parent product's headline price in sync with its default dose.
update public.products p set price_cents = d.price_cents, updated_at=now()
from public.product_doses d where d.product_id=p.id and d.is_default=true;
