-- ============================================================================
-- VANTA LABS — PRE-LAUNCH VERIFICATION (READ-ONLY, safe to run on production)
-- These resolve the audit's "NOT VERIFIED without the live DB" items — the ones
-- that decide whether the P0/P1 findings are real. Run each; paste results back.
-- Nothing here writes or deletes.
-- ============================================================================

-- [P0] 1. RLS must be ON for every sensitive table. ANY row here = world-exposed
--         to the public anon key. This is the #1 launch blocker if non-empty.
select tablename
from pg_tables
where schemaname = 'public'
  and rowsecurity = false
order by tablename;

-- [P1] 2. orders must have every column the app reads. Missing rows = runtime
--         "column does not exist" errors at checkout/admin.
select unnest(array[
  'order_number','customer_user_id','coupon_code','country','handling_fee',
  'tax_amount','payment_method','order_type','payment_reference',
  'payment_proof_url','paid_side_effects_at','provider_event_id',
  'referral_code','ambassador_id','discount_amount','subtotal','amount_paid',
  'refund_amount','points_redeemed'
]) as required_column
except
select column_name from information_schema.columns
where table_schema='public' and table_name='orders';
-- (Any row returned = a MISSING column that must be added before launch.)

-- [P1] 3. Referral codes must be unique — else commissions credit the wrong
--         ambassador. Both queries must return ZERO rows.
select referral_code, count(*)
from public.ambassadors
where referral_code is not null
group by referral_code having count(*) > 1;

select indexname
from pg_indexes
where schemaname='public' and tablename='ambassadors'
  and indexdef ilike '%unique%' and indexdef ilike '%referral_code%';
-- (Second query should return ONE row — the unique index. Empty = not enforced.)

-- [P2] 4. Webhook-event idempotency backstop: provider_event_id uniqueness.
select indexname from pg_indexes
where schemaname='public' and tablename in ('orders','referral_orders')
  and indexdef ilike '%provider_event_id%';

-- [P2] 5. No money/stock is already negative (integrity smoke test).
select 'orders.amount_paid<0' as check, count(*) from public.orders where amount_paid < 0
union all select 'orders.discount<0', count(*) from public.orders where discount_amount < 0
union all select 'referral_orders.commission<0', count(*) from public.referral_orders where commission_amount < 0
union all select 'products.stock<0', count(*) from public.products where inventory_quantity < 0
union all select 'doses.stock<0', count(*) from public.product_doses where inventory_quantity < 0;
-- (Every count should be 0.)

-- [P1] 6. Orphaned financial rows (ledger pointing at a non-existent ambassador).
select count(*) as orphan_commission_rows
from public.referral_orders r
left join public.ambassadors a on a.id = r.ambassador_id
where r.ambassador_id is not null and a.id is null;

-- [INFO] 7. Which payment provider is this environment on? (mock in prod = P2)
--         Can't be read from SQL — check your Vercel env: PAYMENT_PROVIDER must
--         be 'live' (not 'mock') and PAYMENT_WEBHOOK_SECRET must be set.
