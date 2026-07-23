-- ============================================================================
-- VANTA LABS — MASTER SETUP (run all, in order). Idempotent + safe to re-run.
-- Paste the WHOLE file into Supabase -> SQL Editor -> New query -> Run.
-- Expect "Success. No rows returned." Nothing is deleted; archived items are
-- restorable in Admin. Everything here is also editable later in Admin -> Products.
--
-- Order: 1) columns  2) catalog  3) reconcile old products  4) base pricing
--        5) competitive pricing  6) feature top sellers + clear wrong images
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) ENSURE ALL PRODUCT COLUMNS EXIST (fixes an empty admin product list)
-- ---------------------------------------------------------------------------
alter table if exists public.products
  add column if not exists short_description text,
  add column if not exists long_description text,
  add column if not exists description text,
  add column if not exists compare_at_price_cents integer not null default 0,
  add column if not exists sale_price_cents integer not null default 0,
  add column if not exists inventory_quantity integer not null default 0,
  add column if not exists sku text,
  add column if not exists is_published boolean not null default false,
  add column if not exists is_enabled boolean not null default true,
  add column if not exists is_archived boolean not null default false,
  add column if not exists is_featured boolean not null default false,
  add column if not exists badge text,
  add column if not exists position integer not null default 0,
  add column if not exists stock_status text not null default 'In Stock',
  add column if not exists batch_number text,
  add column if not exists purity_result text,
  add column if not exists image_url text,
  add column if not exists testing_date date,
  add column if not exists lab_name text,
  add column if not exists coa_url text,
  add column if not exists molecular_formula text,
  add column if not exists molecular_weight text,
  add column if not exists cas_number text,
  add column if not exists peptide_sequence text,
  add column if not exists storage_recommendation text,
  add column if not exists reconstitution_note text,
  add column if not exists product_faq jsonb not null default '[]'::jsonb,
  add column if not exists seo_title text,
  add column if not exists seo_description text,
  add column if not exists product_cost_cents integer,
  add column if not exists suggested_retail_cents integer,
  add column if not exists min_selling_price_cents integer,
  add column if not exists min_profit_cents integer,
  add column if not exists min_profit_percent numeric,
  add column if not exists shipping_cost_cents integer,
  add column if not exists commission_cost_cents integer,
  add column if not exists low_stock_threshold integer not null default 5,
  add column if not exists is_active boolean not null default true;

alter table if exists public.product_doses
  add column if not exists sku text,
  add column if not exists compare_at_price_cents integer not null default 0,
  add column if not exists sale_price_cents integer not null default 0,
  add column if not exists inventory_quantity integer not null default 0,
  add column if not exists stock_status text not null default 'In Stock',
  add column if not exists batch_number text,
  add column if not exists coa_url text,
  add column if not exists image_url text,
  add column if not exists purity_result text,
  add column if not exists is_default boolean not null default false,
  add column if not exists is_enabled boolean not null default true,
  add column if not exists position integer not null default 0,
  add column if not exists low_stock_threshold integer not null default 5,
  add column if not exists product_cost_cents integer,
  add column if not exists suggested_retail_cents integer,
  add column if not exists min_selling_price_cents integer,
  add column if not exists min_profit_cents integer,
  add column if not exists min_profit_percent numeric;

alter table if exists public.product_images
  add column if not exists alt_text text,
  add column if not exists is_primary boolean not null default false,
  add column if not exists is_enabled boolean not null default true,
  add column if not exists position integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2) LOAD THE GROUPED EVO CATALOG (37 products, 51 dose variants)
-- ---------------------------------------------------------------------------
insert into public.products
  (slug, name, category, price_cents, product_cost_cents, is_featured, position,
   is_published, is_enabled, is_active, is_archived, stock_status, inventory_quantity)
select v.slug, v.name, v.category, v.price_cents, v.cost_cents, v.is_featured, v.position,
       true, true, true, false, 'In Stock', 100
from (values
  ('glp-1-semaglutide','GLP-1 Semaglutide','GLP Research',4299,2456,true,0),
  ('glp-2-tirzepatide','GLP-2 Tirzepatide','GLP Research',4799,2376,true,1),
  ('glp-3-retatrutide','GLP-3 Retatrutide','GLP Research',5499,2306,true,2),
  ('cagrilintide','Cagrilintide','GLP Research',7999,3500,false,3),
  ('klow','KLOW','Blends',10999,3500,false,4),
  ('glow','GLOW','Blends',9499,3500,false,5),
  ('bpc-157','BPC-157','Healing',4299,2506,true,6),
  ('bpc-157-tb-500','BPC-157 + TB-500','Healing',7499,3398,false,7),
  ('kpv','KPV','Healing',4999,3147,false,8),
  ('ghk-cu','GHK-Cu','Healing',4799,2288,false,9),
  ('thymosin-alpha-1','Thymosin Alpha-1','Healing',5999,3350,false,10),
  ('cjc-1295-ipamorelin','CJC-1295 + Ipamorelin','Growth Hormone',6499,2914,true,11),
  ('cjc-1295-no-dac','CJC-1295 no DAC','Growth Hormone',5999,3500,false,12),
  ('tesamorelin','Tesamorelin','Growth Hormone',7499,3414,false,13),
  ('ghrp-6','GHRP-6','Growth Hormone',4799,3300,false,14),
  ('ghrp-2','GHRP-2','Growth Hormone',4799,3300,false,15),
  ('hgh-gh-191','HGH GH-191','Growth Hormone',9999,2804,false,16),
  ('igf-1-lr3','IGF-1 LR3','Growth Hormone',7499,3500,false,17),
  ('nad','NAD+','Longevity',5499,2687,true,18),
  ('ss-31','SS-31','Longevity',7499,3309,false,19),
  ('mots-c','MOTS-C','Longevity',5499,2520,false,20),
  ('epithalon','Epithalon','Longevity',4999,3300,false,21),
  ('glutathione','Glutathione','Longevity',5499,3330,false,22),
  ('semax','Semax','Cognitive',4999,3039,false,23),
  ('selank','Selank','Cognitive',4999,3264,false,24),
  ('cerebrolysin','Cerebrolysin','Cognitive',7499,3500,false,25),
  ('pinealon','Pinealon','Cognitive',4999,3500,false,26),
  ('dsip','DSIP','Cognitive',4499,3300,false,27),
  ('5-amino-1mq','5-Amino-1MQ','Metabolic',5999,3300,false,28),
  ('l-carnitine','L-Carnitine','Metabolic',4999,3300,false,29),
  ('lipo-c','LIPO-C','Metabolic',4999,3300,false,30),
  ('b12','B12','Metabolic',4999,3300,false,31),
  ('pt-141','PT-141','Specialty',4999,3094,false,32),
  ('mt-2-melanotan-ii','MT-2 Melanotan II','Specialty',4799,2783,false,33),
  ('kisspeptin','Kisspeptin','Specialty',5499,3450,false,34),
  ('hcg','HCG','Specialty',5499,3300,false,35),
  ('snap-8','SNAP-8','Specialty',4499,3300,false,36)
) as v(slug, name, category, price_cents, cost_cents, is_featured, position)
on conflict (slug) do update set
  name=excluded.name, category=excluded.category, price_cents=excluded.price_cents,
  product_cost_cents=excluded.product_cost_cents, is_featured=excluded.is_featured,
  is_published=true, is_enabled=true, is_active=true, is_archived=false,
  stock_status='In Stock', updated_at=now();

insert into public.product_doses
  (product_id, label, slug_suffix, price_cents, product_cost_cents,
   is_default, is_enabled, position, stock_status, inventory_quantity)
select p.id, d.label, d.slug_suffix, d.price_cents, d.cost_cents,
       d.is_default, true, d.position, 'In Stock', 100
from (values
  ('glp-1-semaglutide','5mg','5mg',4299,2456,true,0),
  ('glp-1-semaglutide','10mg','10mg',6499,2537,false,1),
  ('glp-1-semaglutide','20mg','20mg',10999,2690,false,2),
  ('glp-1-semaglutide','30mg','30mg',14499,2780,false,3),
  ('glp-2-tirzepatide','5mg','5mg',4799,2376,true,0),
  ('glp-2-tirzepatide','10mg','10mg',7499,2484,false,1),
  ('glp-2-tirzepatide','20mg','20mg',12499,2646,false,2),
  ('glp-2-tirzepatide','30mg','30mg',16499,2826,false,3),
  ('glp-3-retatrutide','5mg','5mg',5499,2306,true,0),
  ('glp-3-retatrutide','10mg','10mg',9499,2405,false,1),
  ('glp-3-retatrutide','20mg','20mg',15499,2729,false,2),
  ('glp-3-retatrutide','30mg','30mg',19999,3026,false,3),
  ('cagrilintide','10mg','10mg',7999,3500,true,0),
  ('klow','80mg','80mg',10999,3500,true,0),
  ('glow','70mg','70mg',9499,3500,true,0),
  ('bpc-157','5mg','5mg',4299,2506,true,0),
  ('bpc-157','10mg','10mg',5999,2569,false,1),
  ('bpc-157-tb-500','20mg','20mg',7499,3398,true,0),
  ('kpv','10mg','10mg',4999,3147,true,0),
  ('ghk-cu','50mg','50mg',4799,2288,true,0),
  ('ghk-cu','100mg','100mg',7499,2882,false,1),
  ('thymosin-alpha-1','5mg','5mg',5999,3350,true,0),
  ('cjc-1295-ipamorelin','10mg','10mg',6499,2914,true,0),
  ('cjc-1295-no-dac','10mg','10mg',5999,3500,true,0),
  ('tesamorelin','10mg','10mg',7499,3414,true,0),
  ('ghrp-6','10mg','10mg',4799,3300,true,0),
  ('ghrp-2','5mg','5mg',4799,3300,true,0),
  ('hgh-gh-191','24iu','24iu',9999,2804,true,0),
  ('hgh-gh-191','36iu','36iu',13999,3074,false,1),
  ('igf-1-lr3','1mg','1mg',7499,3500,true,0),
  ('nad','500mg','500mg',5499,2687,true,0),
  ('nad','1000mg','1000mg',8999,2921,false,1),
  ('ss-31','10mg','10mg',7499,3309,true,0),
  ('mots-c','10mg','10mg',5499,2520,true,0),
  ('epithalon','10mg','10mg',4999,3300,true,0),
  ('glutathione','1500mg','1500mg',5499,3330,true,0),
  ('semax','10mg','10mg',4999,3039,true,0),
  ('selank','10mg','10mg',4999,3264,true,0),
  ('cerebrolysin','60mg','60mg',7499,3500,true,0),
  ('pinealon','10mg','10mg',4999,3500,true,0),
  ('dsip','10mg','10mg',4499,3300,true,0),
  ('dsip','15mg','15mg',5499,3300,false,1),
  ('5-amino-1mq','50mg','50mg',5999,3300,true,0),
  ('l-carnitine','6000mg','6000mg',4999,3300,true,0),
  ('lipo-c','10mL','10ml',4999,3300,true,0),
  ('b12','10mL','10ml',4999,3300,true,0),
  ('pt-141','10mg','10mg',4999,3094,true,0),
  ('mt-2-melanotan-ii','10mg','10mg',4799,2783,true,0),
  ('kisspeptin','10mg','10mg',5499,3450,true,0),
  ('hcg','5000iu','5000iu',5499,3300,true,0),
  ('snap-8','10mg','10mg',4499,3300,true,0)
) as d(parent_slug, label, slug_suffix, price_cents, cost_cents, is_default, position)
join public.products p on p.slug = d.parent_slug
on conflict (product_id, slug_suffix) do update set
  label=excluded.label, price_cents=excluded.price_cents,
  product_cost_cents=excluded.product_cost_cents, is_default=excluded.is_default,
  is_enabled=true, stock_status='In Stock', updated_at=now();

-- ---------------------------------------------------------------------------
-- 3) RECONCILE OLD PRODUCTS — move their photos to the new EVO products, archive
-- ---------------------------------------------------------------------------
update public.product_images pi
set product_id = np.id
from (values
  ('glp-1','glp-1-semaglutide'),('glp-2','glp-2-tirzepatide'),('glp-3','glp-3-retatrutide'),
  ('mt-2','mt-2-melanotan-ii'),('nad-plus','nad'),('hgh-191aa','hgh-gh-191'),
  ('cjc-1295-ipamorelin-blend','cjc-1295-ipamorelin')
) as m(old_slug, new_slug)
join public.products op on op.slug = m.old_slug
join public.products np on np.slug = m.new_slug
where pi.product_id = op.id
  and not exists (select 1 from public.product_images x where x.product_id = np.id);

update public.products np
set image_url = op.image_url, updated_at = now()
from (values
  ('glp-1','glp-1-semaglutide'),('glp-2','glp-2-tirzepatide'),('glp-3','glp-3-retatrutide'),
  ('mt-2','mt-2-melanotan-ii'),('nad-plus','nad'),('hgh-191aa','hgh-gh-191'),
  ('cjc-1295-ipamorelin-blend','cjc-1295-ipamorelin')
) as m(old_slug, new_slug)
join public.products op on op.slug = m.old_slug
where np.slug = m.new_slug
  and coalesce(np.image_url,'') = '' and coalesce(op.image_url,'') <> '';

update public.products
set is_archived = true, is_published = false, is_enabled = false, updated_at = now()
where slug in ('glp-1','glp-2','glp-3','mt-2','nad-plus','hgh-191aa','cjc-1295-ipamorelin-blend','ipamorelin');

-- ---------------------------------------------------------------------------
-- 4) BASE PRICING — raise 21 standalone items to a ~52% margin floor
-- ---------------------------------------------------------------------------
update public.product_doses d set price_cents=6599 from public.products p where p.id=d.product_id and p.slug='kpv' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6999 from public.products p where p.id=d.product_id and p.slug='thymosin-alpha-1' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=7299 from public.products p where p.id=d.product_id and p.slug='cjc-1295-no-dac' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='ghrp-6' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='ghrp-2' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='epithalon' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6999 from public.products p where p.id=d.product_id and p.slug='glutathione' and d.slug_suffix='1500mg';
update public.product_doses d set price_cents=6399 from public.products p where p.id=d.product_id and p.slug='semax' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='selank' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=7299 from public.products p where p.id=d.product_id and p.slug='pinealon' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='dsip' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='dsip' and d.slug_suffix='15mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='5-amino-1mq' and d.slug_suffix='50mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='l-carnitine' and d.slug_suffix='6000mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='lipo-c' and d.slug_suffix='10ml';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='b12' and d.slug_suffix='10ml';
update public.product_doses d set price_cents=6499 from public.products p where p.id=d.product_id and p.slug='pt-141' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5799 from public.products p where p.id=d.product_id and p.slug='mt-2-melanotan-ii' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=7199 from public.products p where p.id=d.product_id and p.slug='kisspeptin' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='hcg' and d.slug_suffix='5000iu';
update public.product_doses d set price_cents=6899 from public.products p where p.id=d.product_id and p.slug='snap-8' and d.slug_suffix='10mg';

-- ---------------------------------------------------------------------------
-- 5) COMPETITIVE PRICING — GLP value pricing (match Evo) + specialty trims
-- ---------------------------------------------------------------------------
update public.product_doses d set price_cents=4999  from public.products p where p.id=d.product_id and p.slug in ('glp-1-semaglutide','glp-2-tirzepatide','glp-3-retatrutide') and d.slug_suffix='5mg';
update public.product_doses d set price_cents=7499  from public.products p where p.id=d.product_id and p.slug in ('glp-1-semaglutide','glp-2-tirzepatide','glp-3-retatrutide') and d.slug_suffix='10mg';
update public.product_doses d set price_cents=11999 from public.products p where p.id=d.product_id and p.slug in ('glp-1-semaglutide','glp-2-tirzepatide','glp-3-retatrutide') and d.slug_suffix='20mg';
update public.product_doses d set price_cents=14999 from public.products p where p.id=d.product_id and p.slug in ('glp-1-semaglutide','glp-2-tirzepatide','glp-3-retatrutide') and d.slug_suffix='30mg';
update public.product_doses d set price_cents=9999  from public.products p where p.id=d.product_id and p.slug='igf-1-lr3' and d.slug_suffix='1mg';
update public.product_doses d set price_cents=11499 from public.products p where p.id=d.product_id and p.slug='klow' and d.slug_suffix='80mg';
update public.product_doses d set price_cents=9999  from public.products p where p.id=d.product_id and p.slug='5-amino-1mq' and d.slug_suffix='50mg';
update public.product_doses d set price_cents=7999  from public.products p where p.id=d.product_id and p.slug='hgh-gh-191' and d.slug_suffix='24iu';
update public.product_doses d set price_cents=10999 from public.products p where p.id=d.product_id and p.slug='hgh-gh-191' and d.slug_suffix='36iu';
update public.product_doses d set price_cents=4499  from public.products p where p.id=d.product_id and p.slug='mt-2-melanotan-ii' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5999  from public.products p where p.id=d.product_id and p.slug='hcg' and d.slug_suffix='5000iu';
update public.product_doses d set price_cents=5999  from public.products p where p.id=d.product_id and p.slug='glutathione' and d.slug_suffix='1500mg';
update public.product_doses d set price_cents=5999  from public.products p where p.id=d.product_id and p.slug='kpv' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=6499  from public.products p where p.id=d.product_id and p.slug='ss-31' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5499  from public.products p where p.id=d.product_id and p.slug='thymosin-alpha-1' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=5499  from public.products p where p.id=d.product_id and p.slug='selank' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=4999  from public.products p where p.id=d.product_id and p.slug='ghrp-6' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=4999  from public.products p where p.id=d.product_id and p.slug='ghrp-2' and d.slug_suffix='5mg';
update public.product_doses d set price_cents=6499  from public.products p where p.id=d.product_id and p.slug='dsip' and d.slug_suffix='10mg';
update public.product_doses d set price_cents=5999  from public.products p where p.id=d.product_id and p.slug='l-carnitine' and d.slug_suffix='6000mg';

-- Sync every product's headline price to its default dose.
update public.products p set price_cents = d.price_cents, updated_at=now()
from public.product_doses d where d.product_id=p.id and d.is_default=true;

-- ---------------------------------------------------------------------------
-- 6) FEATURE TOP SELLERS + CLEAR THE TWO WRONG IMAGES
-- ---------------------------------------------------------------------------
update public.products set is_featured = false where is_featured = true;
update public.products set is_featured = true, updated_at = now()
where slug in ('glp-1-semaglutide','glp-2-tirzepatide','glp-3-retatrutide',
  'bpc-157','bpc-157-tb-500','cjc-1295-ipamorelin','nad','ghk-cu','klow','glow');

update public.products set image_url = null, updated_at = now() where slug in ('klow','bpc-157-tb-500');
delete from public.product_images where product_id in (select id from public.products where slug in ('klow','bpc-157-tb-500'));

-- Done. Verify: should return 37 live products.
--   select count(*) from public.products where is_archived=false and is_enabled=true;
