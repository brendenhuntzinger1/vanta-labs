-- Two scale fixes that live in the database rather than in code.
-- Applied to production 2026-08-28. Idempotent; safe to re-run.
--
-- ---------------------------------------------------------------------------
-- 1. orders.coupon_code — canonical form, so the redemption-limit read can
--    match on `=` and use idx_orders_coupon_code.
--
-- validateCoupon enforces a coupon's max_redemptions by counting the ORDERS
-- that already hold the code, on the create-session path of every checkout
-- carrying a limited coupon and again on every /api/coupons/validate call. It
-- matched with ILIKE, which no btree can serve, so Postgres applied it as a
-- filter over every coupon-bearing order. Measured on the local harness with
-- 20,000 coupon-bearing orders:
--
--   ILIKE : Seq Scan on orders, Rows Removed by Filter: 15001, 12.5 ms
--   =     : Bitmap Index Scan on idx_orders_coupon_code,
--           Index Cond: (coupon_code = 'SAVE20'), 2.4 ms
--
-- The two agree on every value the application can store: normalizeCouponCode
-- uppercases and strips everything outside [A-Z0-9-] before either read, and
-- admin-coupons.ts stores coupons.code the same way. This normalises any order
-- row that does not already hold that form, so `=` cannot under-count a
-- coupon's uses (which would let it be redeemed past its limit).
--
-- Production held ZERO coupon-bearing orders when this ran, so it changed no
-- rows; it exists so the invariant is enforced rather than assumed. The one
-- lane that could write an unnormalised value — payment-webhook.ts, which
-- takes the code from processor metadata — now normalises on the way in.
update public.orders
   set coupon_code = nullif(regexp_replace(upper(btrim(coupon_code)), '[^A-Z0-9-]', '', 'g'), '')
 where coupon_code is not null
   and coupon_code is distinct from
       nullif(regexp_replace(upper(btrim(coupon_code)), '[^A-Z0-9-]', '', 'g'), '');

-- ---------------------------------------------------------------------------
-- 2. rate_limit_hits(created_at) — for the sampled cleanup DELETE.
--
-- rate-limit.ts runs `delete from rate_limit_hits where created_at < now()-24h`
-- on ~1% of requests, AWAITED, on the request path of the highest-volume routes
-- in the app. The only index on the table is (bucket, created_at desc), whose
-- leading column the delete does not filter on — so the delete was a sequential
-- scan of the table, taken on the hot path, and the table is largest exactly
-- when traffic is heaviest.
--
-- An index makes it a range delete. No application change: the cleanup keeps
-- the same predicate and the same sampling rate.
create index if not exists rate_limit_hits_created_at_idx
  on public.rate_limit_hits (created_at);

-- ---------------------------------------------------------------------------
-- 3. referral_orders(ambassador_id, created_at desc) — for the monthly tier
--    count and the payout reads that order by created_at within one ambassador.
--
-- idx_referral_orders_ambassador_id is on (ambassador_id) alone, so
-- `where ambassador_id = $1 order by created_at desc` had to sort every one of
-- that ambassador's rows. getQualifyingMonthlySalesCount now also filters
-- `created_at >= month start`, which this index turns into a range scan instead
-- of a filter. It runs inside quoteOrder, with the shopper waiting.
create index if not exists idx_referral_orders_ambassador_created_at
  on public.referral_orders (ambassador_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. orders(ambassador_id, created_at desc) — same shape, for the repeat-identity
--    fraud scan on the paid webhook, which reads one ambassador's orders newest
--    first.
create index if not exists idx_orders_ambassador_created_at
  on public.orders (ambassador_id, created_at desc);
