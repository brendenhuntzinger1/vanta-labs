-- ---------------------------------------------------------------------------
-- ATOMIC REDEMPTION LIMITS FOR BUY X GET Y PROMOTIONS.
--
-- THE HOLE THIS CLOSES. bxgy-promotions.ts counted redemptions with a SELECT
-- and then the checkout inserted the order — two statements, no lock between
-- them. Two shoppers reaching the last redemption of a "limit 100" promotion at
-- the same moment both read 99 and both got it. The overshoot was bounded by
-- concurrency, but it was real, and a "one per customer" promotion is exactly
-- the kind a determined shopper will fire twice on purpose.
--
-- THE SHAPE OF THE FIX. A claim is now taken BEFORE the order is written, in a
-- single function that holds one advisory lock across the count and the insert.
-- Two concurrent claims for the same promotion serialise on that lock, so the
-- second one counts the first and is refused.
--
-- WHY A CLAIM TABLE RATHER THAN LOCKING `orders`. The order does not exist yet
-- when the decision has to be made — it is written moments later, and if the
-- claim is refused it must never be written at all. Locking a row that does not
-- exist is not possible, and locking the whole `orders` table would serialise
-- every checkout in the store. A claim row is the smallest thing that can be
-- created before the order and counted alongside it.
--
-- NO DEADLOCK IS POSSIBLE HERE. Exactly one advisory lock is taken, keyed on
-- the promotion id, and it is the only lock the function acquires; a
-- transaction that takes at most one lock cannot participate in a cycle. The
-- lock is released when the function's own transaction ends, which is before
-- the order row is inserted — so it is never held across the checkout's other
-- work, and two orders for DIFFERENT promotions never contend at all.
--
-- WHAT COUNTS AS A REDEMPTION, defined once in bxgy_count_redemptions and used
-- by both the counting read and the claim:
--
--   * a claim whose order is `paid` or `partially_refunded`  — a real sale, and
--     it counts forever;
--   * a claim taken within the hold window whose order has NOT reached a dead
--     status — the hold that makes concurrency safe, and it covers the moment
--     before the order row exists at all;
--
--   and nothing else. So a refunded, cancelled or failed order releases its
--   redemption the instant its status changes, an abandoned checkout releases
--   it when the hold expires, and a claim whose order was never written
--   releases it the same way. No release code runs anywhere, which is the point
--   — every release path that has to be REMEMBERED is a release path that will
--   eventually be missed.
--
-- SAFE TO RUN MORE THAN ONCE. Creates one table, two indexes and three
-- functions; touches no existing table and no existing row.
-- ---------------------------------------------------------------------------

create table if not exists public.promotion_redemption_claims (
  -- One claim per order. The primary key is what makes a retry of the same
  -- order idempotent rather than a second consumed slot.
  order_id text primary key,
  promotion_id text not null,
  -- Lower-cased by the claim function. Null for a checkout with no email.
  customer_email text,
  claimed_at timestamptz not null default now()
);

comment on table public.promotion_redemption_claims is
  'One row per order that claimed a Buy X Get Y promotion with a usage limit. Written before the order row so concurrent checkouts cannot both take the last redemption. See bxgy-redemption-claims.sql.';

-- The two shapes the counting query takes: store-wide, and per customer.
create index if not exists idx_promotion_claims_promotion
  on public.promotion_redemption_claims (promotion_id, claimed_at);

create index if not exists idx_promotion_claims_customer
  on public.promotion_redemption_claims (promotion_id, customer_email, claimed_at);

-- ---------------------------------------------------------------------------
-- THE COUNTING RULE — one definition, two callers.
-- ---------------------------------------------------------------------------

create or replace function public.bxgy_count_redemptions(
  p_promotion_id text,
  p_customer_email text default null,
  p_hold_seconds integer default 900
) returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.promotion_redemption_claims c
  where c.promotion_id = p_promotion_id
    and (
      p_customer_email is null
      or c.customer_email = lower(trim(p_customer_email))
    )
    and (
      -- A real sale. Counts for good.
      exists (
        select 1 from public.orders o
        where o.order_id = c.order_id
          and o.payment_status in ('paid', 'partially_refunded')
      )
      or (
        -- A live hold: recent, and not already killed by its order's status.
        -- The NOT EXISTS also covers "the order row does not exist yet", which
        -- is the state every claim is in for the first moments of its life.
        c.claimed_at > now() - make_interval(secs => greatest(p_hold_seconds, 0))
        and not exists (
          select 1 from public.orders o
          where o.order_id = c.order_id
            -- Both cancel spellings: payment-service writes "canceled" on a
            -- reservation failure, the admin path writes "cancelled".
            and o.payment_status in ('canceled', 'cancelled', 'payment_failed', 'refunded')
        )
      )
    );
$$;

comment on function public.bxgy_count_redemptions(text, text, integer) is
  'Live redemptions of one Buy X Get Y promotion, optionally for one customer. Counts paid orders forever and unexpired holds; releases cancelled, failed, refunded and abandoned ones automatically.';

-- ---------------------------------------------------------------------------
-- THE CLAIM — count and insert under one lock.
-- ---------------------------------------------------------------------------

create or replace function public.bxgy_claim_redemption(
  p_promotion_id text,
  p_order_id text,
  p_customer_email text,
  p_max_redemptions integer,
  p_per_customer_limit integer,
  p_hold_seconds integer default 900
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := nullif(lower(trim(coalesce(p_customer_email, ''))), '');
begin
  if p_promotion_id is null or p_order_id is null then
    return false;
  end if;

  -- ONE lock, keyed on the promotion, held to the end of this function's
  -- transaction. Claims for other promotions do not contend, and no second lock
  -- is ever taken, so no cycle can form.
  perform pg_advisory_xact_lock(hashtext('bxgy:' || p_promotion_id));

  -- ALREADY CLAIMED BY THIS ORDER. A retried checkout (an idempotent replay, a
  -- wallet re-authorisation) must not consume a second slot — and must not be
  -- refused by counting its own claim against the limit.
  if exists (
    select 1 from public.promotion_redemption_claims
    where order_id = p_order_id and promotion_id = p_promotion_id
  ) then
    return true;
  end if;

  if p_max_redemptions is not null
     and public.bxgy_count_redemptions(p_promotion_id, null, p_hold_seconds) >= p_max_redemptions then
    return false;
  end if;

  if p_per_customer_limit is not null and v_email is not null
     and public.bxgy_count_redemptions(p_promotion_id, v_email, p_hold_seconds) >= p_per_customer_limit then
    return false;
  end if;

  -- A DIFFERENT promotion may have claimed this order id on an earlier pricing
  -- pass (the shopper changed their basket). The claim moves to the promotion
  -- that actually priced the order.
  insert into public.promotion_redemption_claims (order_id, promotion_id, customer_email, claimed_at)
  values (p_order_id, p_promotion_id, v_email, now())
  on conflict (order_id) do update
    set promotion_id = excluded.promotion_id,
        customer_email = excluded.customer_email,
        claimed_at = excluded.claimed_at;

  return true;
end;
$$;

comment on function public.bxgy_claim_redemption(text, text, text, integer, integer, integer) is
  'Atomically reserve one redemption of a Buy X Get Y promotion for an order. Returns false when a limit is already reached. Takes one advisory lock on the promotion id; never held across order creation.';

-- ---------------------------------------------------------------------------
-- RELEASE — best effort, for a checkout that fails after claiming.
--
-- Not required for correctness: an unused hold expires on its own, and a dead
-- order releases its claim through its status. This just returns the slot in
-- seconds rather than minutes when the checkout itself knows it failed.
-- ---------------------------------------------------------------------------

create or replace function public.bxgy_release_redemption(
  p_order_id text
) returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with deleted as (
    delete from public.promotion_redemption_claims
    where order_id = p_order_id
      -- Never release a claim whose order actually became a sale.
      and not exists (
        select 1 from public.orders o
        where o.order_id = p_order_id
          and o.payment_status in ('paid', 'partially_refunded')
      )
    returning 1
  )
  select count(*) > 0 from deleted;
$$;

-- ---------------------------------------------------------------------------
-- LEAST PRIVILEGE, matching rpc-default-privilege-lockdown.sql: these are
-- service-role operations. A browser key must never be able to consume, count
-- or release a redemption.
-- ---------------------------------------------------------------------------

revoke all on public.promotion_redemption_claims from public, anon, authenticated;
grant select, insert, update, delete on public.promotion_redemption_claims to service_role;

revoke execute on function public.bxgy_count_redemptions(text, text, integer) from public, anon, authenticated;
revoke execute on function public.bxgy_claim_redemption(text, text, text, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.bxgy_release_redemption(text) from public, anon, authenticated;

grant execute on function public.bxgy_count_redemptions(text, text, integer) to service_role;
grant execute on function public.bxgy_claim_redemption(text, text, text, integer, integer, integer) to service_role;
grant execute on function public.bxgy_release_redemption(text) to service_role;

alter table public.promotion_redemption_claims enable row level security;
