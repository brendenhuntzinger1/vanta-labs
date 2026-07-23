-- ============================================================================
-- VANTA LABS — COMPETITIVE REPRICE (vs Pro Elite Research)
-- RAISES the GLP flagship line + IGF-1 + 5-Amino + KLOW to $10-20 under Pro
-- Elite (big margin gain, still the value pick). TRIMS the specialty items your
-- first reprice pushed above Pro Elite back toward their price (protects
-- conversion; all stay 34%+ merchandise margin even at the real 10% processing
-- cost). Run AFTER apply-recommended-pricing.sql. Reversible in Admin. Idempotent.
-- ============================================================================

-- ---- RAISES: GLP line + IGF-1 + 5-Amino + KLOW (headroom under Pro Elite) ----
update public.product_doses d set price_cents=8999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-1-semaglutide' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=14999, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-1-semaglutide' and d.slug_suffix='20mg';
update public.product_doses d set price_cents=18999, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-1-semaglutide' and d.slug_suffix='30mg';
update public.product_doses d set price_cents=11499, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-2-tirzepatide' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=18499, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-2-tirzepatide' and d.slug_suffix='20mg';
update public.product_doses d set price_cents=22499, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-2-tirzepatide' and d.slug_suffix='30mg';
update public.product_doses d set price_cents=10999, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-3-retatrutide' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=16999, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-3-retatrutide' and d.slug_suffix='20mg';
update public.product_doses d set price_cents=21499, updated_at=now() from public.products p where p.id=d.product_id and p.slug='glp-3-retatrutide' and d.slug_suffix='30mg';
update public.product_doses d set price_cents=9999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='igf-1-lr3' and d.slug_suffix='1mg';
update public.product_doses d set price_cents=11499, updated_at=now() from public.products p where p.id=d.product_id and p.slug='klow' and d.slug_suffix='80mg';
update public.product_doses d set price_cents=9999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='5-amino-1mq' and d.slug_suffix='50mg';

-- ---- TRIMS: specialty items back toward Pro Elite (still 34%+ margin) ----
update public.product_doses d set price_cents=7999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='hgh-gh-191' and d.slug_suffix='24iu';
update public.product_doses d set price_cents=10999, updated_at=now() from public.products p where p.id=d.product_id and p.slug='hgh-gh-191' and d.slug_suffix='36iu';
update public.product_doses d set price_cents=4499,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='mt-2-melanotan-ii' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='hcg' and d.slug_suffix='5000iu';
update public.product_doses d set price_cents=5999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='glutathione' and d.slug_suffix='1500mg';
update public.product_doses d set price_cents=5999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='kpv' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6499,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='ss-31' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5499,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='thymosin-alpha-1' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=5499,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='selank' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=4999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='ghrp-6' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=4999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='ghrp-2' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=6499,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='dsip' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5999,  updated_at=now() from public.products p where p.id=d.product_id and p.slug='l-carnitine' and d.slug_suffix='6000mg';

-- Keep each parent product's headline price in sync with its default dose.
update public.products p set price_cents = d.price_cents, updated_at=now()
from public.product_doses d where d.product_id=p.id and d.is_default=true;
