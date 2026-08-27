-- Seed the local harness with a small catalogue and one ambassador, mirroring
-- production shapes so the transactional tests mean something.
-- Development-only. Never run against production.

-- ---------- products ----------
insert into products (id, slug, name, category, price_cents, stock_status, description,
                      is_active, is_published, is_enabled, is_archived, inventory_quantity,
                      track_inventory, reserved_quantity, shipping_weight_oz, position, is_featured)
values
  ('11111111-1111-4111-8111-111111111111', 'bpc-157', 'BPC-157', 'Repair & Recovery Research', 3999,
   'In Stock', 'BPC-157 for laboratory research use only.', true, true, true, false, 0, true, 0, 2, 1, false),
  ('22222222-2222-4222-8222-222222222222', 'glp-1', 'GLP-1', 'GLP Research', 4499,
   'In Stock', 'GLP-1 for laboratory research use only.', true, true, true, false, 0, true, 0, 2, 2, true),
  -- deliberately mirrors production's parent-zero / dose-stocked shape
  ('33333333-3333-4333-8333-333333333333', 'dsip', 'DSIP', 'Cognitive Research', 5999,
   'Out of Stock', 'DSIP for laboratory research use only.', true, true, true, false, 0, true, 0, 2, 3, false),
  -- the last-unit product, for the concurrency test
  ('44444444-4444-4444-8444-444444444444', 'lastone', 'Last One', 'Specialty', 12000,
   'In Stock', 'Single remaining unit.', true, true, true, false, 0, true, 0, 2, 4, false)
on conflict (id) do nothing;

insert into product_doses (id, product_id, label, slug_suffix, sku, price_cents, inventory_quantity,
                           stock_status, is_default, is_enabled, position, track_inventory,
                           reserved_quantity, low_stock_threshold, shipping_weight_oz, product_cost_cents)
values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '5mg',  '5mg',  'BPC5',  3999, 19, 'In Stock', true,  true, 1, true, 0, 5, 2, 1200),
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '10mg', '10mg', 'BPC10', 4999, 29, 'In Stock', false, true, 2, true, 0, 5, 2, 1800),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '5mg',  '5mg',  'GLP5',  4499, 29, 'In Stock', true,  true, 1, true, 0, 5, 2, 1400),
  ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', '30mg', '30mg', 'GLP30', 14499, 29, 'In Stock', false, true, 2, true, 0, 5, 2, 4000),
  ('cccccccc-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', '10mg', '10mg', 'DSIP10', 5999, 19, 'In Stock', true, true, 1, true, 0, 5, 2, 2000),
  ('dddddddd-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', '1ct', '1ct', 'LAST1', 12000, 1, 'In Stock', true, true, 1, true, 0, 1, 2, 5000)
on conflict (id) do nothing;

-- ---------- ambassadors / partners (both tables, as production has them) ----------
insert into ambassadors (id, name, email, referral_code, commission_percent, customer_discount_percent,
                         status, commission_percent_locked, approved_at)
values
  ('99999999-9999-4999-8999-999999999901', 'Explicit Fifteen', 'amb15@example.test', 'EXPLICIT15', 15, 15, 'approved', true, now()),
  ('99999999-9999-4999-8999-999999999902', 'Inherits Default', 'ambnull@example.test', 'INHERITNULL', 10, null, 'approved', true, now()),
  ('99999999-9999-4999-8999-999999999903', 'Not Yet Approved', 'ambpend@example.test', 'PENDINGCODE', 15, 15, 'info_requested', false, null)
on conflict (id) do nothing;

insert into partners (id, name, email, referral_code, commission_percent, customer_discount_percent,
                      status, commission_percent_locked, approved_at)
select id, name, email, referral_code, commission_percent, customer_discount_percent, status,
       commission_percent_locked, approved_at
from ambassadors
on conflict (id) do nothing;

-- ---------- a coupon, for the coupon-vs-referral test ----------
insert into coupons (code, discount_type, discount_value, active, is_private, member_scope, redemptions_count)
values ('TESTTWENTY', 'percent', 20, true, false, 'all', 0)
on conflict do nothing;
