-- ---------------------------------------------------------------------------
-- ORDER ATTRIBUTION — join an ad click to the order it produced.
--
-- WHY A SEPARATE TABLE RATHER THAN COLUMNS ON `orders`:
-- `orders` is the money record. Every write to it happens inside the checkout
-- path, and a column that doesn't exist yet fails the whole insert (the reason
-- quote-order.ts carries a full-row/base-row degradation dance). Attribution is
-- marketing telemetry — it must never be able to fail an order, delay one, or
-- appear in the same write as a total. A 1:1 side table makes that structural
-- rather than a promise: the order is committed first, attribution is written
-- after, and if that write fails the customer's order is already safe.
--
-- It also fits where this is going. One order can carry a TikTok click id, a
-- Meta click id and a Google click id, plus first-touch AND last-touch values.
-- That is a row of its own, not ten more columns bolted onto the ledger.
--
-- NOTHING IN THIS FILE MODIFIES AN EXISTING TABLE. Purely additive.
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

create table if not exists public.order_attribution (
  -- Same key the rest of the schema joins on. The foreign key is added
  -- separately below rather than inline: it depends on orders.order_id carrying
  -- a unique constraint, and if this database's `orders` differs at all from
  -- the repo's schema an inline reference would take the whole migration down
  -- with it. Better to always get the table and find out about the constraint.
  order_id text primary key,

  -- Who the analytics pipeline thought this was. These are the join keys back
  -- into website_analytics_events, which is what turns a purchase into the end
  -- of a measurable funnel rather than an isolated row.
  visitor_id text,
  session_id text,

  -- FIRST TOUCH — the campaign that introduced this person to Vanta Labs.
  first_touch_at timestamptz,
  first_utm_source text,
  first_utm_medium text,
  first_utm_campaign text,
  first_utm_content text,
  first_utm_term text,
  first_ttclid text,
  first_fbclid text,
  first_gclid text,
  first_landing_path text,
  first_referrer text,

  -- LAST TOUCH — the campaign that was in play when they actually bought.
  -- Both are kept because they answer different questions: first touch tells
  -- you what to spend on to find people, last touch tells you what closes them.
  -- Platforms report last-touch; keeping both means our numbers can be
  -- reconciled against TikTok's rather than silently disagreeing.
  last_touch_at timestamptz,
  last_utm_source text,
  last_utm_medium text,
  last_utm_campaign text,
  last_utm_content text,
  last_utm_term text,
  last_ttclid text,
  last_fbclid text,
  last_gclid text,
  last_landing_path text,
  last_referrer text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reporting reads: "every paid order from utm_source=tiktok last month",
-- "every order carrying a ttclid", "this visitor's order history".
-- Referential integrity, added defensively.
--
-- ON DELETE CASCADE so a removed order never strands a telemetry row. If this
-- cannot be created — orders.order_id lacking a unique index, a permissions
-- difference, a schema that drifted from the repo — the migration reports it and
-- carries on rather than failing. Attribution still works without the FK; it just
-- won't auto-clean on order deletion, which is a housekeeping matter, not a
-- correctness one.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'order_attribution_order_id_fkey'
  ) then
    begin
      alter table public.order_attribution
        add constraint order_attribution_order_id_fkey
        foreign key (order_id) references public.orders(order_id) on delete cascade;
    exception when others then
      raise notice 'order_attribution: foreign key to orders(order_id) not added (%). Table is usable; add it manually once orders.order_id has a unique index.', sqlerrm;
    end;
  end if;
end $$;

create index if not exists order_attribution_last_source_idx on public.order_attribution (last_utm_source);
create index if not exists order_attribution_first_source_idx on public.order_attribution (first_utm_source);
create index if not exists order_attribution_visitor_idx on public.order_attribution (visitor_id);
create index if not exists order_attribution_last_ttclid_idx on public.order_attribution (last_ttclid) where last_ttclid is not null;
create index if not exists order_attribution_created_idx on public.order_attribution (created_at desc);

create or replace function public.order_attribution_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists order_attribution_set_updated_at on public.order_attribution;
create trigger order_attribution_set_updated_at
  before update on public.order_attribution
  for each row
  execute function public.order_attribution_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — deny by default.
--
-- This table links a marketing identifier to a specific purchase, which is
-- exactly the kind of row that must never be readable with the anon key that
-- ships to every browser. Writes and reads happen server-side with the
-- service-role key, which carries BYPASSRLS, so enabling RLS with no policy
-- locks out anon/authenticated and changes nothing for the application.
-- ---------------------------------------------------------------------------
alter table public.order_attribution enable row level security;

-- Verification (run manually; expect attributed orders only, never invented ones):
--   select last_utm_source, count(*), sum(o.amount_paid) as revenue
--   from public.order_attribution a
--   join public.orders o on o.order_id = a.order_id
--   where o.payment_status = 'paid'
--   group by 1 order by revenue desc nulls last;
--
-- Orders with no attribution simply have no row here — that is the correct
-- representation of "we don't know", and it must stay distinguishable from
-- "this was organic".
