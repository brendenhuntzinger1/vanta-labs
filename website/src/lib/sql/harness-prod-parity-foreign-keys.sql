-- ============================================================================
-- HARNESS PARITY: THE FOREIGN KEYS THE BOOTSTRAP SILENTLY DROPS
--
-- Harness-only. Never applied to production, which already has all of these.
-- Safe to re-run: every constraint is added under a `not exists` guard.
--
-- ----------------------------------------------------------------------------
-- WHY THIS FILE EXISTS
--
-- Finding SQL-07, made concrete. The bootstrap creates every table with
-- `create table if not exists`, so on a database where the table already exists
-- in a narrower form the REST of that statement — including its `references`
-- clauses — is discarded without a word. Counted on 2026-08-28:
--
--   production: 35 foreign keys in `public`
--   harness:    17
--
-- Eighteen missing, and they were not the harmless ones. Absent were
-- order_items -> orders, customer_memberships -> membership_tiers and
-- product_doses -> products: the three relationships the application embeds
-- most, and the exact three that made `select("*, order_items(*)")` untestable.
--
-- HOW IT SURFACED. scripts/pgrst-shim.mjs resolves embedded selects by reading
-- pg_constraint, the way PostgREST does. On the harness it found no key joining
-- orders to order_items and dropped the embed — correctly, because guessing a
-- join is how a test harness starts lying. The shim was right; the schema was
-- wrong. Three separate audit phases had already lost time to the same gap,
-- reporting only that embeds "aren't supported".
--
-- WHAT IT COSTS TO BE WRONG. A missing foreign key does not fail loudly. It
-- means the harness accepts an order_items row for an order that does not
-- exist, accepts a membership pointing at a deleted tier, and cascades nothing
-- on delete — so a cascade bug reproduces as "works fine" here and as data loss
-- in production. VL-1 lived behind this for exactly that reason.
--
-- ON DELETE. Deliberately omitted rather than guessed: production declares
-- these with no explicit action, so they are NO ACTION there, and adding a
-- CASCADE the real database does not have would make the harness diverge in the
-- other direction. Parity means the same constraint, not a better one.
-- ============================================================================

do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      -- The three the application embeds. Everything else is here so the next
      -- embed does not need another round of this.
      ('order_items',               'order_id',          'orders',                   'order_id'),
      ('customer_memberships',      'tier_id',           'membership_tiers',         'id'),
      ('product_doses',             'product_id',        'products',                 'id'),
      ('product_images',            'product_id',        'products',                 'id'),

      -- Orders and their satellites.
      ('orders',                    'customer_user_id',  'users',                    'id'),
      ('orders',                    'parcel_preset_id',  'shipping_package_presets', 'id'),
      ('order_attribution',         'order_id',          'orders',                   'order_id'),
      ('order_shipments',           'order_id',          'orders',                   'order_id'),
      ('fulfillment_orders',        'order_id',          'orders',                   'order_id'),
      ('fulfillment_payouts',       'order_id',          'orders',                   'order_id'),
      ('abandoned_carts',           'recovered_order_id','orders',                    'order_id'),

      -- The affiliate money tables.
      ('commissions',               'partner_id',        'partners',                 'id'),
      ('payouts',                   'partner_id',        'partners',                 'id'),
      ('referrals',                 'partner_id',        'partners',                 'id'),
      ('referral_orders',           'ambassador_id',     'ambassadors',              'id'),
      ('ambassador_wallet_ledger',  'user_id',           'users',                    'id'),

      -- Membership and cart recovery.
      ('membership_billing_events', 'user_id',           'users',                    'id'),
      ('membership_billing_events', 'tier_id',           'membership_tiers',         'id'),
      ('abandoned_cart_emails',     'abandoned_cart_id', 'abandoned_carts',          'id'),
      ('abandoned_cart_emails',     'coupon_id',         'coupons',                  'id')
    ) as t(child, child_col, parent, parent_col)
  loop
    -- Skip anything this database cannot support yet: a table the bootstrap did
    -- not create, a column a later migration adds, or a parent with no unique
    -- index on the referenced column. Each is a legitimate reason for the key to
    -- be absent, and none should stop the other nineteen from landing.
    if not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name=fk.child and column_name=fk.child_col)
       or not exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name=fk.parent and column_name=fk.parent_col)
    then
      raise notice 'skip %.% -> %.% (column or table absent)', fk.child, fk.child_col, fk.parent, fk.parent_col;
      continue;
    end if;

    if exists (
      select 1
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_class tgt on tgt.oid = con.confrelid
      join pg_namespace ns on ns.oid = src.relnamespace and ns.nspname = 'public'
      join lateral unnest(con.conkey) with ordinality as sk(attnum, ord) on true
      join pg_attribute sc on sc.attrelid = src.oid and sc.attnum = sk.attnum
      where con.contype = 'f'
        and src.relname = fk.child
        and tgt.relname = fk.parent
        and sc.attname  = fk.child_col
    ) then
      continue;
    end if;

    begin
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references public.%I(%I)',
        fk.child, fk.child || '_' || fk.child_col || '_fkey', fk.child_col, fk.parent, fk.parent_col
      );
      raise notice 'added %.% -> %.%', fk.child, fk.child_col, fk.parent, fk.parent_col;
    exception when others then
      -- Seed rows that predate the key would fail validation. Report and carry
      -- on: a harness missing one key is recoverable, a bootstrap that aborts
      -- half way leaves a database nobody can reason about.
      raise notice 'could NOT add %.% -> %.% : %', fk.child, fk.child_col, fk.parent, fk.parent_col, sqlerrm;
    end;
  end loop;
end
$$;

-- Verification. The three the embeds need must all be present.
select
  count(*) filter (where src.relname = 'order_items'          and tgt.relname = 'orders')           as order_items_to_orders,
  count(*) filter (where src.relname = 'customer_memberships' and tgt.relname = 'membership_tiers') as memberships_to_tiers,
  count(*) filter (where src.relname = 'product_doses'        and tgt.relname = 'products')         as doses_to_products,
  count(*)                                                                                          as total_foreign_keys
from pg_constraint con
join pg_class src on src.oid = con.conrelid
join pg_class tgt on tgt.oid = con.confrelid
join pg_namespace ns on ns.oid = src.relnamespace and ns.nspname = 'public'
where con.contype = 'f';
