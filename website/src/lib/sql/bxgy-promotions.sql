-- ---------------------------------------------------------------------------
-- BUY X GET Y PROMOTIONS — record which promotion priced an order.
--
-- The promotion CONFIGURATION lives in `admin_control_values`
-- (promotions.bxgy_promotions), alongside every other promotion switch this
-- store already keeps there. This migration adds the one thing a control value
-- cannot hold: which promotion each order actually redeemed.
--
-- WHY A COLUMN ON `orders` AND NOT A COUNTER.
--
-- Usage limits are counted from this column (see getExhaustedPromotionIds in
-- src/lib/bxgy-promotions.ts) rather than incremented into a counter. A counter
-- has to be decremented on refund, on cancellation, on a failed capture and on
-- every path added afterwards; the first one missed leaves a promotion
-- permanently short of its limit with nothing to point at. Counting orders
-- makes refunds and cancellations correct by construction: the count filters on
-- payment_status, so an order that stops being a sale stops being a redemption.
--
-- SAFE TO RUN MORE THAN ONCE. Purely additive: one nullable column and one
-- partial index. Nothing here rewrites an existing row, and every writer treats
-- the column as optional (buildOrderRow puts it on the `full` row only, so an
-- unmigrated database still takes the order via the base-row fallback).
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists promotion_id text;

comment on column public.orders.promotion_id is
  'Id of the Buy X Get Y promotion that priced this order (bxgy-config.ts). Null when no such promotion applied. Usage limits are counted from this column, filtered on payment_status.';

-- The only query shape that reads it: count orders for one promotion id,
-- optionally narrowed to one customer's email, restricted to the statuses that
-- still count as a redemption. Partial so it stays small — the vast majority of
-- orders carry no promotion at all.
create index if not exists idx_orders_promotion_id
  on public.orders (promotion_id, payment_status)
  where promotion_id is not null;

-- Per-customer limits add the email to that same count.
create index if not exists idx_orders_promotion_customer
  on public.orders (promotion_id, customer_email, payment_status)
  where promotion_id is not null;
