-- =============================================================================
-- Shipping Protection — give the fee a column of its own.
--
-- THE DEFECT. Protection is charged (4% of the merchandise subtotal, added by
-- default in the cart) and folded straight into `amount_paid`, but it was
-- stored in no column. So an order could not reproduce its own total:
--
--   VL-37C1E4B0   subtotal 2.00 + shipping 15.00 = 17.00, charged 17.08
--   VL-8D132452   subtotal 3.80 + shipping 15.00 = 18.80, charged 18.95
--   VL-E8F4D52F   subtotal 54.99 + shipping 15.00 + tax 3.85 = 73.84, charged 76.04
--
-- Refunds are unaffected — they are driven by `amount_paid` and the provider's
-- own refund event, never recomputed from components — so no money has moved
-- wrongly. What breaks is every reading of the books: revenue built from
-- components under-reports, and reconciliation had to be taught to TOLERATE the
-- discrepancy (reconciliation-math.ts accepted any overage up to the maximum
-- possible protection fee) rather than verify it. A tolerance band that wide
-- cannot distinguish a protection fee from a genuine overcharge of the same
-- size. Storing the fee is what lets that band close to zero.
--
-- =============================================================================

alter table public.orders
  add column if not exists shipping_protection_fee numeric(12,2) not null default 0;

comment on column public.orders.shipping_protection_fee is
  'The Shipping Protection add-on charged on this order, in dollars. Part of amount_paid. 0 when the shopper unticked it. Same numeric(12,2) representation as every other charged amount on this table.';

-- Matches the posture of add-money-stock-check-constraints.sql: a charged
-- amount is never negative. Added NOT VALID and validated separately so the
-- lock is brief and an unexpected legacy row surfaces as a validation failure
-- rather than blocking the migration.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_shipping_protection_fee_nonneg'
  ) then
    alter table public.orders
      add constraint orders_shipping_protection_fee_nonneg
      check (shipping_protection_fee >= 0) not valid;
    alter table public.orders validate constraint orders_shipping_protection_fee_nonneg;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Provenance for anything written by the backfill.
--
-- Two of the three affected orders came through the standard checkout lane,
-- which recorded the shopper's protection choice NOWHERE. Their fee is
-- recovered by subtraction, and a recovered figure must never be indistinguish-
-- able from a recorded one six months from now. This table says which is which.
--
-- It is not part of the order pipeline: nothing reads it at runtime, no foreign
-- key, and dropping it would change no behaviour. It exists to be read by a
-- human asking "where did this number come from?".
-- -----------------------------------------------------------------------------
create table if not exists public.order_amount_backfills (
  id            bigserial primary key,
  order_id      text        not null,
  column_name   text        not null,
  old_value     numeric(12,2),
  new_value     numeric(12,2) not null,
  -- 'recorded'      — read from a stored flag (e.g. express_checkout_intents)
  -- 'reconstructed' — derived from recorded components by subtraction
  basis         text        not null check (basis in ('recorded','reconstructed')),
  rationale     text        not null,
  applied_at    timestamptz not null default now(),
  unique (order_id, column_name)
);

alter table public.order_amount_backfills enable row level security;

comment on table public.order_amount_backfills is
  'Audit trail for historical money columns written by a backfill rather than by checkout. basis=recorded means a stored flag was the source; basis=reconstructed means the value was recovered by subtraction from other recorded components.';

-- -----------------------------------------------------------------------------
-- THE BACKFILL.
--
-- Deliberately NOT a blanket "set the fee to the residual wherever the order
-- does not reconcile". Each row is qualified so that the residual can only be
-- the protection fee:
--
--   * the order is paid,
--   * the residual is EXACTLY 4% of the recorded subtotal, to the cent, and
--   * every other optional term is zero (no discount, no points, no store
--     credit, no card fee), so nothing else could have produced it.
--
-- The total formula (quote-order.ts) is
--     amount_paid = subtotal + shipping + tax + cardFee
--                   − discount − storeCredit − points
--                   + shippingProtectionFee
-- and the protection fee is the only term added after the rest. With every
-- other term recorded and the residual matching the fee formula to the cent,
-- the residual IS the fee by subtraction — not a guess about what the shopper
-- clicked.
-- -----------------------------------------------------------------------------
with candidate as (
  select o.order_id,
         o.shipping_protection_fee as old_value,
         round(o.amount_paid
               - (o.subtotal + o.tax_amount + o.card_processing_fee + o.shipping_amount
                  - o.discount_amount - coalesce(o.store_credit_redeemed_cents, 0) / 100.0), 2) as residual,
         round(o.subtotal * 0.04, 2) as fee_formula,
         (select bool_or(e.shipping_protection)
            from public.express_checkout_intents e
           where e.order_id = o.order_id) as recorded_flag
    from public.orders o
   where o.payment_status = 'paid'
     and o.shipping_protection_fee = 0
     and o.discount_amount = 0
     and o.card_processing_fee = 0
     and coalesce(o.points_redeemed, 0) = 0
     and coalesce(o.store_credit_redeemed_cents, 0) = 0
),
eligible as (
  select order_id, old_value, residual, fee_formula, recorded_flag
    from candidate
   where residual > 0
     and residual = fee_formula
)
, written as (
  update public.orders o
     set shipping_protection_fee = e.residual,
         updated_at = now()
    from eligible e
   where o.order_id = e.order_id
  returning o.order_id
)
insert into public.order_amount_backfills (order_id, column_name, old_value, new_value, basis, rationale)
select e.order_id,
       'shipping_protection_fee',
       e.old_value,
       e.residual,
       case when e.recorded_flag is true then 'recorded' else 'reconstructed' end,
       case when e.recorded_flag is true
            then 'express_checkout_intents.shipping_protection = true for this order; fee recomputed as 4% of the recorded subtotal and confirmed equal to the residual.'
            else 'Standard checkout lane records no protection flag. Residual after every other recorded component equals 4% of the recorded subtotal to the cent, and discount, points, store credit and card fee are all zero, so no other term could have produced it.'
       end
  from eligible e
 where e.order_id in (select order_id from written)
    on conflict (order_id, column_name) do nothing;
