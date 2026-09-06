-- ---------------------------------------------------------------------------
-- ATOMIC HOLDS FOR STORE CREDIT AND LOYALTY POINTS.
--
-- THE HOLE THIS CLOSES. tender-reservation.ts holds a money-like balance the
-- way inventory-reservation.ts holds stock, and for the same reason (VL-11):
-- a balance that is READ at quote time and DEBITED at settlement funds as many
-- orders as the shopper can start. Its fix was to write the debit FIRST and
-- validate it after — every writer sums the ledger in one fixed order
-- (created_at, id) and keeps its row only if the running balance is still
-- solvent up to and including its own row.
--
-- That argument needs the loser to SEE the winner, and nothing made it. The
-- insert and the validating read are two independent PostgREST round trips
-- under READ COMMITTED: a claim that is LATER in the agreed order can finish
-- its read before the earlier claim's insert has committed, sum a ledger that
-- does not contain its rival, and approve itself. Reproduced against this
-- store's own schema through the real reserveOrderTender: one user granted
-- exactly 5000 cents, two concurrent claims of 5000 cents for two different
-- orders, 250 rounds — 2 double spends. Both orders priced $50 off, both cards
-- were charged the reduced amount, and the ledger netted to -$50 while $100 of
-- discount had been given away. Higher across two serverless instances with
-- independent latency than in a warm local loop, and repeatable at will by
-- anyone who notices.
--
-- THE SHAPE OF THE FIX is the one this repository already uses for the same
-- class of problem in bxgy-redemption-claims.sql: check and write inside ONE
-- function holding ONE advisory lock, so two claims against the same balance
-- serialise and the second one counts the first.
--
-- ONE LOCK, KEYED ON THE CUSTOMER'S LEDGER. Two shoppers never contend, and a
-- transaction that takes at most one lock cannot participate in a cycle, so no
-- deadlock is possible here. The lock ends with the function's own transaction,
-- which is over before the checkout does anything else.
--
-- THE HOLD *IS* THE REDEMPTION, unchanged: this writes the ordinary ledger
-- debit, keyed to the order, exactly as the application did. Releasing still
-- DELETES that row, refunds still read the same rows they always did, and
-- settlement still finds the debit already standing. Nothing downstream can
-- tell the difference except that it is now correct under concurrency.
--
-- IDEMPOTENT PER ORDER. A retried submit finds its own hold and keeps it rather
-- than debiting twice — the same rule the application enforced, moved inside
-- the lock so a retry racing itself cannot write two.
--
-- THE WINDOW IS PASSED IN, NOT DECIDED HERE. Store credit is use-it-or-lose-it
-- monthly and points never expire, and the balance a claim is validated against
-- has to match getStoreCreditBalanceCents exactly — a claim validated against a
-- wider window would authorise spending expired credit. The caller owns that
-- rule (startOfCurrentMonthIso), so it hands the boundary over rather than
-- having a second definition of "this month" live here and drift.
--
-- SAFE TO RUN MORE THAN ONCE. Creates two functions; touches no table and no
-- row. An older application that has not been deployed yet keeps working
-- unchanged, because these are additive.
-- ---------------------------------------------------------------------------

create or replace function public.claim_store_credit_hold(
  p_user_id uuid,
  p_order_id text,
  p_amount integer,
  p_reason text,
  p_window_start timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_held bigint;
  v_balance bigint;
begin
  -- Nothing to hold is not a refusal: the quote read the same absence.
  if p_user_id is null or p_order_id is null or coalesce(p_amount, 0) <= 0 then
    return true;
  end if;

  perform pg_advisory_xact_lock(hashtext('tender:store_credit:' || p_user_id::text));

  select coalesce(sum(abs(amount_cents)), 0) into v_held
  from public.store_credit_ledger
  where order_id = p_order_id and reason = p_reason;

  if v_held > 0 then
    -- This order already holds something. Keep it, and answer whether it
    -- covers what is being asked for now.
    return v_held >= p_amount;
  end if;

  select coalesce(sum(amount_cents), 0) into v_balance
  from public.store_credit_ledger
  where user_id = p_user_id
    and (p_window_start is null or created_at >= p_window_start);

  if v_balance < p_amount then
    return false;
  end if;

  insert into public.store_credit_ledger (user_id, amount_cents, reason, order_id, created_at)
  values (p_user_id, -p_amount, p_reason, p_order_id, now());

  return true;
end;
$$;

comment on function public.claim_store_credit_hold(uuid, text, integer, text, timestamptz) is
  'Atomically hold store credit for one order: sums the spendable window and writes the debit under one advisory lock on the customer. Returns false when the balance does not cover it. Idempotent per order. See tender-hold-claim.sql.';

create or replace function public.claim_points_hold(
  p_user_id uuid,
  p_order_id text,
  p_amount integer,
  p_reason text,
  p_window_start timestamptz default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_held bigint;
  v_balance bigint;
begin
  if p_user_id is null or p_order_id is null or coalesce(p_amount, 0) <= 0 then
    return true;
  end if;

  perform pg_advisory_xact_lock(hashtext('tender:points:' || p_user_id::text));

  select coalesce(sum(abs(amount)), 0) into v_held
  from public.points_ledger
  where order_id = p_order_id and reason = p_reason;

  if v_held > 0 then
    return v_held >= p_amount;
  end if;

  select coalesce(sum(amount), 0) into v_balance
  from public.points_ledger
  where user_id = p_user_id
    and (p_window_start is null or created_at >= p_window_start);

  if v_balance < p_amount then
    return false;
  end if;

  insert into public.points_ledger (user_id, amount, reason, order_id, created_at)
  values (p_user_id, -p_amount, p_reason, p_order_id, now());

  return true;
end;
$$;

comment on function public.claim_points_hold(uuid, text, integer, text, timestamptz) is
  'Atomically hold loyalty points for one order: sums the lifetime balance and writes the debit under one advisory lock on the customer. Returns false when the balance does not cover it. Idempotent per order. See tender-hold-claim.sql.';

-- ---------------------------------------------------------------------------
-- LEAST PRIVILEGE, matching rpc-default-privilege-lockdown.sql. These spend a
-- customer's balance; a browser key must never be able to call them.
-- ---------------------------------------------------------------------------

revoke execute on function public.claim_store_credit_hold(uuid, text, integer, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_points_hold(uuid, text, integer, text, timestamptz) from public, anon, authenticated;

grant execute on function public.claim_store_credit_hold(uuid, text, integer, text, timestamptz) to service_role;
grant execute on function public.claim_points_hold(uuid, text, integer, text, timestamptz) to service_role;
