-- ============================================================================
-- VANTA LABS — STAGING SEED (test data only)
-- Paste into: Supabase (STAGING project) -> SQL Editor -> New query -> Run.
-- Safe to re-run (upserts by unique key). DO NOT run against production.
--
-- Gives the staging site something to click: a few research products with
-- batch numbers / purity / COA fields and real per-unit costs (so the profit
-- guard has data), one coupon, and one approved ambassador with a referral
-- code. Membership tiers come from membership-tiers-seed.sql. Everything here
-- can also be created through the admin dashboard instead.
-- ============================================================================

-- --- Products -------------------------------------------------------------
-- product_cost_cents (added by product-cost-profit.sql) gives the profit guard
-- a real per-unit cost. Priced here at ~25% of retail.
insert into public.products
  (slug, name, category, short_description, long_description, price_cents,
   compare_at_price_cents, inventory_quantity, sku, is_published, is_enabled,
   is_featured, stock_status, batch_number, purity_result, description,
   testing_date, lab_name, coa_url, molecular_formula, product_cost_cents,
   low_stock_threshold)
values
  ('semaglutide-5mg', 'Semaglutide 5mg', 'GLP Research',
   'Research-grade GLP-1 analog, 5mg per vial.',
   'Lyophilized research peptide for laboratory use only. Not for human consumption.',
   9999, 12999, 40, 'VL-SEMA-5', true, true, true, 'In Stock',
   'SEMA-2407A', '99.2%', 'Research-grade GLP-1 analog, 5mg per vial.',
   '2026-06-01', 'Janoshik Analytical', 'https://example.com/coa/sema-2407a.pdf',
   'C187H291N45O59', 2500, 5),
  ('bpc-157-5mg', 'BPC-157 5mg', 'Healing',
   'Body-protection compound peptide, 5mg per vial.',
   'Lyophilized research peptide for laboratory use only. Not for human consumption.',
   4499, 5999, 60, 'VL-BPC-5', true, true, true, 'In Stock',
   'BPC-2406C', '99.5%', 'Body-protection compound peptide, 5mg per vial.',
   '2026-05-18', 'Janoshik Analytical', 'https://example.com/coa/bpc-2406c.pdf',
   'C62H98N16O22', 1100, 5),
  ('tb-500-5mg', 'TB-500 5mg', 'Healing',
   'Thymosin beta-4 fragment, 5mg per vial.',
   'Lyophilized research peptide for laboratory use only. Not for human consumption.',
   5499, 6999, 8, 'VL-TB5-5', true, true, false, 'Limited',
   'TB5-2405B', '98.9%', 'Thymosin beta-4 fragment, 5mg per vial.',
   '2026-05-02', 'Janoshik Analytical', 'https://example.com/coa/tb5-2405b.pdf',
   'C212H350N56O78S', 1400, 5),
  ('cjc-1295-2mg', 'CJC-1295 (no DAC) 2mg', 'Growth Hormone',
   'Growth-hormone releasing hormone analog, 2mg per vial.',
   'Lyophilized research peptide for laboratory use only. Not for human consumption.',
   3999, 4999, 30, 'VL-CJC-2', true, true, false, 'In Stock',
   'CJC-2404D', '99.1%', 'Growth-hormone releasing hormone analog, 2mg per vial.',
   '2026-04-20', 'Janoshik Analytical', 'https://example.com/coa/cjc-2404d.pdf',
   'C165H269N47O46', 1000, 5),
  ('bac-water-30ml', 'Bacteriostatic Water 30ml', 'Laboratory Supplies',
   'Sterile bacteriostatic water for reconstitution, 30ml.',
   'Laboratory supply for reconstitution of lyophilized research compounds.',
   1299, 0, 200, 'VL-BAC-30', true, true, false, 'In Stock',
   'BAC-2407', null, 'Sterile bacteriostatic water for reconstitution, 30ml.',
   '2026-07-01', 'In-house QC', null, null, 300, 5)
on conflict (slug) do update set
  name = excluded.name,
  category = excluded.category,
  price_cents = excluded.price_cents,
  inventory_quantity = excluded.inventory_quantity,
  is_published = excluded.is_published,
  batch_number = excluded.batch_number,
  purity_result = excluded.purity_result,
  testing_date = excluded.testing_date,
  lab_name = excluded.lab_name,
  coa_url = excluded.coa_url,
  molecular_formula = excluded.molecular_formula,
  product_cost_cents = excluded.product_cost_cents,
  updated_at = now();

-- --- Coupon ---------------------------------------------------------------
insert into public.coupons (code, discount_type, discount_value, max_redemptions, active)
values ('WELCOME10', 'percent', 10, 100, true)
on conflict (code) do update set active = true, discount_value = excluded.discount_value;

-- --- Ambassador (approved, with a referral code) --------------------------
insert into public.ambassadors (name, email, referral_code, status, commission_percent, approved_at)
values ('Test Ambassador', 'ambassador@staging.test', 'TESTAMB', 'approved', 12, now())
on conflict do nothing;

-- Done. Sign up a customer, add products to cart, and check out with the
-- sandbox card 4242 4242 4242 4242 (PAYMENT_PROVIDER=mock).
