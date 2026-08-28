-- Block G/H harness seed. Mirrors production SHAPES, never production data.
-- Every value here is synthetic. See docs/BROWSER-TESTING-RUNBOOK.md section 3.
begin;
delete from order_items; delete from orders; delete from inventory_reservations;
delete from product_doses; delete from product_images; delete from products;
delete from ambassadors; delete from partners; delete from coupons; delete from membership_tiers;

-- F-001 shape: parent inventory_quantity = 0, dose stocked. 31 of 36 live products.
insert into products (id, slug, name, category, price_cents, stock_status, inventory_quantity,
  is_active, is_published, is_enabled, track_inventory, short_description, image_url, position)
values ('11111111-1111-1111-1111-111111111111','bpc-157-10mg','BPC-157 10mg','Research Peptides',
  6900,'In Stock',0,true,true,true,true,'Synthetic harness product (parent-zero shape).','/img/p1.png',1);
insert into product_doses (id, product_id, label, slug_suffix, price_cents, inventory_quantity,
  stock_status, is_default, is_enabled, track_inventory, position, sku)
values ('aaaaaaa1-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','10mg','10mg',
  6900,25,'In Stock',true,true,true,1,'BPC-10'),
 ('aaaaaaa1-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','5mg','5mg',
  4900,8,'In Stock',false,true,true,2,'BPC-5');

-- Out-of-stock control: every dose at zero.
insert into products (id, slug, name, category, price_cents, stock_status, inventory_quantity,
  is_active, is_published, is_enabled, track_inventory, short_description, image_url, position)
values ('22222222-2222-2222-2222-222222222222','tb-500-5mg','TB-500 5mg','Research Peptides',
  8900,'Out of Stock',0,true,true,true,true,'Synthetic harness product (all doses zero).','/img/p2.png',2);
insert into product_doses (id, product_id, label, slug_suffix, price_cents, inventory_quantity,
  stock_status, is_default, is_enabled, track_inventory, position, sku)
values ('bbbbbbb1-0000-4000-8000-000000000001','22222222-2222-2222-2222-222222222222','5mg','5mg',
  8900,0,'Out of Stock',true,true,true,1,'TB-5');

-- Parent image, no gallery rows.
insert into products (id, slug, name, category, price_cents, stock_status, inventory_quantity,
  is_active, is_published, is_enabled, track_inventory, short_description, image_url, position)
values ('33333333-3333-3333-3333-333333333333','ipamorelin-5mg','Ipamorelin 5mg','Research Peptides',
  5900,'In Stock',40,true,true,true,true,'Synthetic harness product (parent image only).','/img/p3.png',3);

-- Inverse: gallery rows, no parent image.
insert into products (id, slug, name, category, price_cents, stock_status, inventory_quantity,
  is_active, is_published, is_enabled, track_inventory, short_description, image_url, position)
values ('44444444-4444-4444-4444-444444444444','cjc-1295-2mg','CJC-1295 2mg','Research Peptides',
  7900,'In Stock',15,true,true,true,true,'Synthetic harness product (gallery only).',null,4);
insert into product_images (id, product_id, image_url, position)
values ('cccccccc-0000-4000-8000-000000000001','44444444-4444-4444-4444-444444444444','/img/g1.png',1);

-- Ambassadors: all three discount resolutions.
insert into ambassadors (id, name, email, referral_code, commission_percent, customer_discount_percent, status, approved_at)
values ('dddddddd-0000-4000-8000-000000000001','Explicit Fifteen','explicit@harness.invalid','EXPLICIT15',15.00,15.00,'approved',now()),
       ('dddddddd-0000-4000-8000-000000000002','Null Inherits','inherit@harness.invalid','INHERITME',10.00,null,'approved',now()),
       ('dddddddd-0000-4000-8000-000000000003','Hold Probe','hold@harness.invalid','HOLDPROBE',10.00,10.00,'info_requested',null);
insert into partners (id, name, email, referral_code, commission_percent, customer_discount_percent, status, approved_at)
select id, name, email, referral_code, commission_percent, customer_discount_percent, status, approved_at from ambassadors;

insert into coupons (code, discount_type, discount_value, active, member_scope)
values ('HARNESS10','percent',10,true,'all');

-- PRODUCTION'S REAL TIER STRUCTURE, ids and all.
--
-- The harness used to carry one invented tier ("core"), which is not a tier
-- production has. That is not a cosmetic difference: the app HARD FAILS with
-- "Free membership tier is not configured" when no `free` tier exists, so a
-- signed-in customer with no membership row 500'd on the harness while behaving
-- correctly in production — a defect that exists only in the test rig, which is
-- exactly the kind that burns an afternoon and gets reported as a false P0.
--
-- Mirrored from production 2026-08-28 (5 tiers; `essential` is deliberately
-- inactive there). `core` is kept so older harness fixtures still resolve.
insert into membership_tiers (id, slug, name, monthly_price_cents, annual_price_cents, member_discount_percent, is_active, position)
values
  ('ab7024d9-49f1-4fa7-888d-bb3171633443','free','Research Member',0,0,0,true,0),
  ('eeeeeeee-0000-4000-8000-000000000001','core','Core Member',2900,29000,10,true,1),
  ('a6b2dabf-c808-4185-bb1a-ae87efd5b86e','essential','Vanta Essential',999,0,5,false,2),
  ('7b8411bc-5920-4243-bdc0-9d974462cabc','pro','Vanta Pro',2499,0,8,true,3),
  ('04710059-a614-477d-a52a-ccc163119e45','elite','Vanta Elite',3999,0,10,true,4),
  ('2b470dfa-c479-47db-b78e-6dfcfa2946f9','black','Vanta Black',8999,0,12,true,5);
commit;
