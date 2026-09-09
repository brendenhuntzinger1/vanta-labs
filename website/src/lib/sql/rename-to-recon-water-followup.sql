-- Recon Water rename, follow-up. Two things the first migration missed.
--
-- Found by scanning EVERY text/varchar/jsonb column in every public table
-- rather than the ones the first pass reasoned about:
--
--   do $$ ... for r in (select from information_schema.columns
--                       where data_type in ('text','character varying','jsonb'))
--     execute format('select count(*) from %I where (%I)::text ~* %L', ...)
--
-- 1. customer_offers.gift_items
--
--    free_product / free_product_percent carry their grant in `product_slug`,
--    which the first migration moved. free_products / free_products_percent do
--    NOT -- they carry it in `gift_items`, which it did not touch. Three live,
--    unredeemed, unrevoked cart-recovery offers still named "bac-water" there.
--
--    quote-order resolves each grant with an exact match and then folds the
--    result into a boolean:
--
--        const offerProduct = catalogProducts.find(c => c.slug === grant.slug);
--        const shippable = Boolean(offerProduct) && ...
--
--    so an unresolvable slug is not an error. It is a false `shippable`, the
--    gift is dropped, and the order completes without it -- promised in the
--    recovery email, never shipped. Same silent failure the first migration
--    fixed for product_slug.
--
-- 2. cart_recovery_stage_overrides.note
--
--    Operator notes shown in the admin cart-recovery view ("72h follow-up:
--    40% + 2 BAC Water"). Not customer-facing and not financial -- renaming
--    them falsifies nothing, because the product is the same product.

begin;

update public.customer_offers
   set gift_items = (
     select jsonb_agg(
              case when elem->>'slug' in ('bac-water', 'bacteriostatic-water', 'bac-water-30ml')
                   then jsonb_set(elem, '{slug}', '"recon-water"')
                   else elem end
              order by ord
            )
       from jsonb_array_elements(gift_items) with ordinality as t(elem, ord)
   )
 where gift_items::text ~* 'bac[ _-]?water|bacteriostatic';

update public.cart_recovery_stage_overrides
   set note = replace(replace(note, 'BAC Water', 'Recon Water'), 'BAC water', 'Recon water')
 where note ~ 'BAC [Ww]ater';

commit;

-- ---------------------------------------------------------------------------
-- WHAT IS LEFT IN THE DATABASE, AND WHY EACH ONE STAYS
--
--   offer_key                     customer_offers (11), email_automations (1),
--                                 cart_recovery_stage_overrides (8)
--     Internal keys -- 'winback_60_bac_water_10', 'labor_day_bac_water_2',
--     'cart_recovery_bac_water'. They join stored rows to OFFER_CATALOG in
--     offers/customer-offers.ts. Renaming them orphans every live entitlement.
--     Never displayed.
--
--   order_items.product_name      20 rows
--     A receipt records what was sold under the name it was sold under.
--
--   order_items.product_id        20 rows
--     The cart key `slug::variantId`. It is how an order line joins back to
--     inventory. Rewriting it breaks the pick list and the ledger.
--
--   inventory_reservations.slug   20 rows, all 'finalized' or 'released'
--     Historical ledger. Nothing live reads them.
--
--   admin_audit_logs.metadata     10 rows
--     An audit log of what an operator actually did. Integrity-critical.
--
--   fulfillment_events.payload    139 rows
--     What was sent to and received from the 3PL at the time.
--
--   express_checkout_intents.items  92 rows, all consumed/expired/failed
--     No pending intent carries the old slug, so none can reach a till.
--
--   website_analytics_events.*    112 / 24 / 25 rows
--     Historical traffic on the old URL. Rewriting it falsifies analytics;
--     new events already carry /products/recon-water.
--
-- VERIFY
--   select count(*) from public.customer_offers
--    where gift_items::text ~* 'bac[ _-]?water|bacteriostatic';   -- 0
--   select count(*) from public.cart_recovery_stage_overrides
--    where note ~* 'bac[ _-]?water|bacteriostatic';               -- 0
-- ---------------------------------------------------------------------------
