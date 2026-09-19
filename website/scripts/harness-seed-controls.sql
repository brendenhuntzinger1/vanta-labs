-- ---------------------------------------------------------------------------
-- MIRROR PRODUCTION'S CUSTOMER-FACING ADMIN CONTROL SETTINGS INTO THE HARNESS.
--
-- WHY THIS EXISTS. The harness loads production's catalogue but started with
-- only four control rows, so it ran with `inventory.tracking_enabled` unset —
-- which defaults to FALSE (inventory-settings.ts fails open so an unreadable
-- setting can never make the whole catalogue unpurchasable). Production has had
-- it TRUE since 2026-08-25.
--
-- That single difference made the harness disagree with the shop on the one
-- thing a stock test is for: with tracking off, resolveStockStatus returns
-- "In Stock" for every row, so MOTS-C — zero units on production, correctly
-- presented there as Out of Stock — was addable to the cart in the harness and
-- a browser scenario asserting "reaches the cart" passed for the wrong reason.
--
-- Everything else here is fidelity for the same reason: shipping thresholds
-- decide when the free-shipping line appears, the referral percentages decide
-- what an affiliate link is worth, welcome_offer.enabled decides whether a
-- banner shows. A harness that guesses these certifies a different shop.
--
-- NO SECRETS. Production also stores API keys, an SMTP password, a fulfilment
-- key and a webhook secret in this table. None of them are here, none of them
-- belong in a repository, and the harness does not need them — it talks to no
-- third party.
--
-- Idempotent: the snapshot reader takes the newest row per (section, key), so
-- re-running this simply restates the same values.
-- ---------------------------------------------------------------------------

insert into admin_audit_logs (action, target_table, target_id, metadata)
values
  -- The one that matters for stock. Production: true since 2026-08-25.
  ('admin_control_upsert', 'inventory', 'tracking_enabled', '{"value": true}'),

  ('admin_control_upsert', 'coupons', 'enabled', '{"value": true}'),
  ('admin_control_upsert', 'coupons', 'allow_stacking', '{"value": false}'),

  ('admin_control_upsert', 'referral', 'enabled', '{"value": true}'),
  ('admin_control_upsert', 'referral', 'commissions_paused', '{"value": false}'),
  ('admin_control_upsert', 'referral', 'default_commission_percent', '{"value": "15"}'),
  ('admin_control_upsert', 'referral', 'personal_discount_percent', '{"value": "20"}'),

  ('admin_control_upsert', 'shipping', 'flat_rate', '{"value": "15"}'),
  ('admin_control_upsert', 'shipping', 'free_shipping_threshold', '{"value": "200"}'),
  ('admin_control_upsert', 'shipping', 'free_shipping_sitewide', '{"value": false}'),
  ('admin_control_upsert', 'shipping', 'north_america_flat_rate', '{"value": "25"}'),
  ('admin_control_upsert', 'shipping', 'north_america_free_shipping_threshold', '{"value": "400"}'),
  ('admin_control_upsert', 'shipping', 'international_flat_rate', '{"value": ""}'),
  ('admin_control_upsert', 'shipping', 'international_free_shipping_threshold', '{"value": ""}'),

  -- Off on production. The wheel, not a welcome code, is the live offer.
  ('admin_control_upsert', 'welcome_offer', 'enabled', '{"value": false}'),
  ('admin_control_upsert', 'welcome_offer', 'code', '{"value": "WELCOME10"}'),
  ('admin_control_upsert', 'welcome_offer', 'percent', '{"value": 10}'),
  ('admin_control_upsert', 'welcome_offer', 'headline', '{"value": "Get 10% off your first order"}'),
  ('admin_control_upsert', 'welcome_offer', 'subtext', '{"value": "New here? Use this code at checkout."}'),

  ('admin_control_upsert', 'spin_wheel', 'enabled', '{"value": true}'),
  ('admin_control_upsert', 'spin_wheel', 'campaignId', '{"value": "winback_2026q4"}'),

  ('admin_control_upsert', 'sms_signup', 'prompts_enabled', '{"value": true}'),
  ('admin_control_upsert', 'coa', 'show_pending_products', '{"value": false}'),
  ('admin_control_upsert', 'settings', 'maintenance_mode', '{"value": false}'),

  ('admin_control_upsert', 'business', 'business_name', '{"value": "Vanta Labs"}'),
  ('admin_control_upsert', 'business', 'support_email', '{"value": "Support@vantalabsresearch.com"}'),

  -- Card is the live method and its label names Apple Pay. Left exactly as
  -- production has it; the owner's decision is that Apple Pay works.
  ('admin_control_upsert', 'payment_processor', 'enabled', '{"value": false}'),
  ('admin_control_upsert', 'payment_processor', 'provider', '{"value": "live"}'),
  ('admin_control_upsert', 'payment_processor', 'display_name', '{"value": "Credit / Debit Card"}'),
  ('admin_control_upsert', 'payment_methods', 'card',
    '{"value": {"email": "", "label": "Debit, Credit & Apple Pay", "phone": "", "handle": "", "enabled": true, "memoNote": "", "qrImageUrl": "", "businessName": "", "instructions": []}}'),
  ('admin_control_upsert', 'payment_methods', 'card_processing_fee',
    '{"value": {"label": "service fee", "enabled": false, "noticeText": "", "percentage": 0}}'),

  -- Every BXGY promotion is disabled on production. Seeded so a harness run
  -- cannot accidentally price a bundle the shop does not offer.
  ('admin_control_upsert', 'promotions', 'bundle_stacking', '{"value": false}'),
  ('admin_control_upsert', 'promotions', 'buy_2_get_1_half_enabled', '{"value": false}'),
  ('admin_control_upsert', 'promotions', 'buy_3_get_1_enabled', '{"value": false}'),
  ('admin_control_upsert', 'promotions', 'bundle_two_unit_percent', '{"value": ""}'),
  ('admin_control_upsert', 'promotions', 'bundle_three_plus_percent', '{"value": ""}'),
  ('admin_control_upsert', 'promotions', 'free_shipping_threshold', '{"value": ""}'),
  ('admin_control_upsert', 'promotions', 'sitewide_announcement', '{"value": ""}'),
  ('admin_control_upsert', 'promotions', 'bxgy_promotions', '{"value": []}'),

  ('admin_control_upsert', 'cart_recovery', 't30m_enabled', '{"value": true}'),
  ('admin_control_upsert', 'cart_recovery', 't12h_enabled', '{"value": true}'),
  ('admin_control_upsert', 'cart_recovery', 't24h_enabled', '{"value": true}'),
  ('admin_control_upsert', 'cart_recovery', 't72h_enabled', '{"value": true}'),
  ('admin_control_upsert', 'cart_recovery', 'discount_percent', '{"value": 10}'),
  ('admin_control_upsert', 'cart_recovery', 'coupon_expiration_hours', '{"value": 48}');
