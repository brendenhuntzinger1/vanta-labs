-- ---------------------------------------------------------------------------
-- VANTA LABS — PER-AMBASSADOR CUSTOMER DISCOUNT
--
-- Additive and idempotent. No column is dropped, no row is rewritten, and no
-- live price changes on deploy.
--
-- THE GAP
-- An ambassador already carries their own commission_percent, but the discount
-- their CUSTOMERS receive came from one global program setting. So every code
-- gave the same discount, and there was no way to offer one ambassador's
-- audience 15% while another's got 10% -- the two numbers were independent in
-- name only, because one of them did not exist per ambassador.
--
-- WHY NULLABLE, WITH NO DEFAULT
-- NULL means "inherit the program default". Every existing ambassador stays
-- exactly as they are, so this migration cannot move a single price. An
-- override exists only where the owner deliberately sets one, and clearing it
-- returns that ambassador to the default rather than to zero -- which is what
-- an owner means when they empty the field.
--
-- A DEFAULT of, say, 10 would silently pin every ambassador to today's value.
-- Change the program default later and nobody would follow it, which is the
-- opposite of inheritance.
--
-- THE SNAPSHOT
-- commissions already stores commission_percent per order, so changing an
-- ambassador's rate cannot rewrite history. The discount now needs the same
-- protection: without it, an order placed at 10% would appear to have been
-- placed at 15% the moment the owner raised the rate, and the recorded
-- discount would no longer explain the recorded total.
-- ---------------------------------------------------------------------------

alter table if exists public.ambassadors
  add column if not exists customer_discount_percent numeric(5,2);

alter table if exists public.partners
  add column if not exists customer_discount_percent numeric(5,2);

alter table if exists public.commissions
  add column if not exists customer_discount_percent numeric(5,2);

alter table if exists public.referral_orders
  add column if not exists customer_discount_percent numeric(5,2);

comment on column public.ambassadors.customer_discount_percent is
  'Discount THIS ambassador''s code gives the customer. NULL inherits the program default. Independent of commission_percent.';

-- A percentage, and never a giveaway. 0 is legitimate (a code that tracks
-- attribution without discounting); anything at or above 100 is a mistake that
-- would zero the order.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ambassadors_customer_discount_range') then
    alter table public.ambassadors
      add constraint ambassadors_customer_discount_range
      check (customer_discount_percent is null
             or (customer_discount_percent >= 0 and customer_discount_percent < 100)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'partners_customer_discount_range') then
    alter table public.partners
      add constraint partners_customer_discount_range
      check (customer_discount_percent is null
             or (customer_discount_percent >= 0 and customer_discount_percent < 100)) not valid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- VERIFY -- all four true, and every ambassador still inheriting (all NULL).
-- ---------------------------------------------------------------------------
select
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='ambassadors'
      and column_name='customer_discount_percent') = 1                  as ambassadors_ok,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='partners'
      and column_name='customer_discount_percent') = 1                  as partners_ok,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='commissions'
      and column_name='customer_discount_percent') = 1                  as commissions_ok,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='referral_orders'
      and column_name='customer_discount_percent') = 1                  as referral_orders_ok,
  (select count(*) from public.ambassadors
    where customer_discount_percent is not null)                        as overrides_set;
