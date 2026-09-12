-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- VANTA TEXTS — M5. THE CONTRIBUTION SNAPSHOT.
--
-- NOT YET APPLIED. This file is written, reviewed and tested before it is run,
-- exactly as sms-programme.sql was at M1, and no application code reads or
-- writes this table until the owner has applied it and
-- src/lib/production-schema.json has been regenerated. supabase-schema-parity
-- deliberately allows no early reference to an un-applied TABLE (only to an
-- un-applied column), which is what holds that sequence in place.
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT COLUMNS ON `orders`
--
-- `orders` already carries 85 columns and is the hottest write path in the
-- application: every checkout inserts one, and an insert naming a column that
-- does not exist fails the whole order. Twelve additive columns there would put
-- a reporting feature on the critical path of taking money, for no benefit —
-- nothing about contribution is needed to place, price, pay for or ship an
-- order.
--
-- A separate table also says the true thing about applicability: a row exists
-- for an order only if the snapshot was taken when that order was placed.
-- HISTORICAL ORDERS GET NO ROW, and that is the correct answer rather than a
-- gap, because the inputs are not recoverable after the fact — the processor
-- rate and the postage estimate are admin settings that change, the points rate
-- follows a membership that lapses, and the paid/gift COGS split is not
-- derivable from `order_items` (a gift line is not distinguishable there). A
-- backfill would therefore not reconstruct these numbers; it would invent them
-- at today's settings and stamp them with yesterday's date. THERE IS NO
-- BACKFILL IN THIS FILE, and one must not be written without a separate
-- decision that says which settings it is entitled to assume.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TABLE IS FOR, AND WHAT IT IS NOT
--
-- It is the per-order input to campaign economics: "did this lifecycle message
-- pay for itself". Contribution accrues the points liability an order CREATES
-- and also deducts points REDEEMED, so summing it across every order is not a
-- P&L — see the "ONE THING THAT CANNOT BE SUMMED" section of
-- src/lib/benefits/contribution.ts. The owner's P&L is admin-profit.ts and stays
-- admin-profit.ts.
--
-- Membership orders (`orders.order_type = 'membership'`) get no row at all:
-- they have no merchandise, no COGS and never ship, so they have no merchandise
-- contribution to record.
--
-- RLS posture matches the rest of `public`: enabled with no policies, so only
-- the service-role client reaches these rows. The browser's anon key makes no
-- `.from()` calls against this table and holds no grants. Nothing here is
-- customer-safe: COGS, postage cost and the processor rate are all internal.

create table if not exists public.order_contribution (
  -- ONE ROW PER ORDER, enforced by the key rather than by a convention. A
  -- second snapshot for the same order would mean two answers to one question.
  order_id                       text primary key
                                 references public.orders(order_id) on delete cascade,

  -- ---- provenance -------------------------------------------------------
  -- Bumped only when the SET OF TERMS changes, never for a bug fix. A reader
  -- comparing a v1 row with a v2 row is comparing two definitions, and this is
  -- the column that lets them notice.
  formula_version                integer not null,
  -- 'quote'   taken at checkout: COGS may be the worst-case fallback, postage
  --           is the configured estimate, and the points rate assumes no
  --           promotional multiplier.
  -- 'settled' taken after payment from what the order recorded.
  basis                          text not null check (basis in ('quote', 'settled')),
  -- True when any COGS line fell back to an assumption rather than a snapshot.
  -- An estimate presented as a fact is the one thing a money figure must not do.
  cost_is_estimated              boolean not null default false,
  computed_at                    timestamptz not null default now(),

  -- ---- the formula, in INTEGER CENTS -------------------------------------
  -- Cents, not numeric(12,2), and deliberately unlike `orders`. Ten terms
  -- summed as floats is where a cent goes missing; the application sums these
  -- as integers (src/lib/benefits/contribution.ts) and they are stored in the
  -- units they were computed in, so nothing re-rounds on the way in or out.
  paid_merchandise_cents         bigint not null,
  shipping_collected_cents       bigint not null,
  handling_collected_cents       bigint not null,
  product_cost_cents             bigint not null,
  gift_cogs_cents                bigint not null,
  processing_fee_cents           bigint not null,
  shipping_cost_cents            bigint not null,
  store_credit_redeemed_cents    bigint not null,
  points_redeemed_value_cents    bigint not null,
  points_earned_value_cents      bigint not null,

  -- MAY BE NEGATIVE, and no constraint says otherwise. A negative contribution
  -- is the signal this whole table exists to surface; refusing to store one
  -- would mean the only orders worth finding are the ones that cannot be
  -- written.
  contribution_before_commission_cents bigint not null,

  -- The largest single deduction: "why was this order thin", answered without
  -- re-reading nine numbers. Null when there were no deductions at all.
  binding_constraint             text,

  -- ---- attribution metadata ---------------------------------------------
  -- WHO OR WHAT THIS ORDER IS OWED TO. Contribution without attribution answers
  -- "was this order profitable"; the conversion-architecture phase needs "was
  -- this CAMPAIGN profitable", and that is the difference between the two.
  --
  -- ALL NULLABLE, AND THEY FAIL SAFE. An order whose attribution cannot be
  -- established records NULL, never a guess and never a default channel: an
  -- unattributed order wrongly credited to SMS would make a campaign look like
  -- it paid for itself using an order it had nothing to do with, which is the
  -- exact error this whole programme is being built to avoid making.
  --
  -- 'sms' | 'email' | null — which lifecycle channel funded a gift on this
  -- order. Null when there was no Vanta-funded gift, which is most orders.
  gift_channel                   text check (gift_channel in ('sms', 'email')),
  -- The customer_offers row a gift was granted from, when there was one.
  offer_id                       text,
  offer_key                      text,
  -- The lifecycle campaign/template this order is attributed to, and the send
  -- it came from. Populated from M8 onward; null before then, and null whenever
  -- attribution could not be established.
  campaign_key                   text,
  send_reference_id              text,

  created_at                     timestamptz not null default now()
);

-- The two reads the conversion-architecture phase will actually make: "every
-- snapshot for this campaign" and "every snapshot in this window".
create index if not exists order_contribution_campaign_idx
  on public.order_contribution (campaign_key, computed_at desc)
  where campaign_key is not null;

create index if not exists order_contribution_computed_at_idx
  on public.order_contribution (computed_at desc);

alter table public.order_contribution enable row level security;

comment on table public.order_contribution is
  'Per-order cash contribution before ambassador commission, in integer cents. '
  'Written once per merchandise order from src/lib/benefits/contribution.ts; never backfilled. '
  'NOT a P&L — see the module docblock on why these rows must not be summed against admin-profit.';
