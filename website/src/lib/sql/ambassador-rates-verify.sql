-- ---------------------------------------------------------------------------
-- VANTA LABS — AMBASSADOR RATE VERIFICATION (READ ONLY)
--
-- Nothing here writes. Run it after setting a rate in the admin to confirm the
-- database agrees with the screen.
-- ---------------------------------------------------------------------------

-- 1. EVERY AMBASSADOR, WITH THE RATE THEIR CODE ACTUALLY GIVES.
--    `discount_source` is the column that matters: "override" means this
--    ambassador carries their own number, "program default" means they follow
--    the global setting. A NULL is inheritance, never 0%.
select
  a.name,
  a.referral_code,
  a.status,
  coalesce(a.customer_discount_percent, 10) as customer_discount_pct,   -- 10 = program default
  case when a.customer_discount_percent is null then 'program default' else 'override' end as discount_source,
  a.commission_percent                       as ambassador_earns_pct,
  a.commission_percent_locked                as commission_is_manual
from public.ambassadors a
order by a.status, a.name;

-- 2. THE INDEPENDENCE CHECK.
--    If the two rates were secretly linked, they would move together. Any row
--    where they differ is proof they are not. Expect at least one once you have
--    set, for example, 10% off for customers and 20% commission.
select
  count(*) filter (where customer_discount_percent is not null)                       as with_override,
  count(*) filter (where customer_discount_percent is not null
                     and customer_discount_percent <> commission_percent)             as rates_differ,
  count(*) filter (where customer_discount_percent = 0)                               as deliberate_zero_discount
from public.ambassadors;

-- 3. THE SNAPSHOT, ON REAL ORDERS.
--    Each commission row froze the two rates as they stood when the order was
--    placed. Change an ambassador's rate afterwards and these must NOT move --
--    that is the whole reason they are stored rather than recomputed.
select
  c.created_at::date              as order_date,
  a.name                          as ambassador,
  c.customer_discount_percent     as discount_at_time_of_order,
  c.commission_percent            as commission_at_time_of_order,
  a.customer_discount_percent     as ambassadors_rate_today,
  a.commission_percent            as commission_rate_today
from public.commissions c
join public.ambassadors a on a.id = c.ambassador_id
order by c.created_at desc
limit 25;

-- 4. ORDERS PLACED BEFORE THE SNAPSHOT EXISTED.
--    Expected to be non-zero for historical orders — the column was added
--    additively and does not backfill. New referred orders should all record a
--    value. If a NEW order lands here, the webhook is not snapshotting.
select
  count(*)                                                        as commissions_total,
  count(*) filter (where customer_discount_percent is null)       as missing_discount_snapshot,
  max(created_at) filter (where customer_discount_percent is null) as newest_missing
from public.commissions;
