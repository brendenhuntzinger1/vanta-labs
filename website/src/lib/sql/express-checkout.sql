-- ============================================================================
-- VANTA LABS — EXPRESS (APPLE PAY) CHECKOUT
-- Two tables plus a few columns for the mini-cart Apple Pay lane.
--
--   express_checkout_intents  A cart+price snapshot frozen at the moment the
--                             Apple Pay sheet is armed, paired 1:1 with a
--                             processor checkout session. Holds the
--                             authoritative address-INDEPENDENT amount (A) that
--                             the sheet displays, plus the three required
--                             research/age acknowledgements as evidence — the
--                             orders table has no column for those, so this row
--                             IS the consent record for an express order, keyed
--                             by the same order_id. consumed_at is the atomic
--                             single-charge claim: it flips NULL -> now() once,
--                             immediately before the charge, so a retry or a
--                             double-tap can never produce a second charge.
--
--   express_shipping_quotes   Every shipping+tax quote this store returned to
--                             the wallet callback, bound to a fingerprint of
--                             the address that produced it. Authorization
--                             refuses any shipping method that is not in the
--                             row matching the fingerprint of the address
--                             actually being charged — that is what stops a
--                             stale wallet cache charging one address's sales
--                             tax against another's. Append-only: never delete,
--                             it is the audit trail.
--
-- No orders row and no inventory hold is created at intent time; both happen at
-- authorization, after the address is known and the amount has been verified.
--
-- RUN THIS BEFORE DEPLOYING THE CODE THAT READS IT. Deploying first means the
-- express endpoints fail against missing tables while money is in flight.
--
-- Idempotent + safe to re-run. Supabase -> SQL Editor -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Intents
-- ---------------------------------------------------------------------------
create table if not exists public.express_checkout_intents (
  id                     uuid primary key default gen_random_uuid(),

  -- Pre-allocated at intent time and handed to the processor as session
  -- metadata, so the webhook can find the order even though no orders row
  -- exists yet. There is no PATCH on the session API — the id is decided here
  -- or never.
  order_id               text not null,
  order_number           text not null,

  -- The processor's INTERNAL session uuid (what the create call returns as
  -- `id`). Every downstream call is keyed by this, never by the public id.
  veyra_session_id       text,

  customer_user_id       uuid references auth.users(id) on delete set null,
  -- Empty for a guest: the wallet withholds the email until authorization. The
  -- shipping callback re-prices with THIS value so its taxable base matches the
  -- amount the sheet opened on, rather than drifting on a coupon that
  -- validates differently for a different email.
  customer_email         text,

  -- Frozen snapshot: [{id, quantity, unitPrice}]. Authorization re-prices from
  -- THIS, never from the live cart, so mutating the cart while the sheet is
  -- open can't change what gets charged.
  items                  jsonb not null default '[]'::jsonb,
  referral_code          text,
  coupon_code            text,
  points_to_redeem       integer not null default 0,   -- always 0 on this lane
  shipping_protection    boolean not null default false,
  store_credit_cents     integer not null default 0,

  -- A: the authoritative address-independent amount the Apple sheet opens with.
  -- The charge is A + locked shipping + locked tax; nothing else may be added.
  amount_cents           integer not null check (amount_cents >= 50),
  currency               text not null default 'USD',

  -- Evidence for the three required confirmations, captured at the tick, with
  -- the copy version so a future wording change stays attributable.
  compliance_ack         jsonb not null default '{}'::jsonb,
  compliance_acked_at    timestamptz,
  compliance_copy_version text,

  client_ip              text,
  user_agent             text,

  status                 text not null default 'open',  -- open | consumed | failed | expired
  outcome                jsonb,                          -- terminal result, replayed to a duplicate authorize
  consumed_at            timestamptz,
  created_at             timestamptz not null default now(),
  expires_at             timestamptz not null
);

-- Late-added column, asserted separately so re-running this file against an
-- earlier version of the table still adds it.
alter table public.express_checkout_intents
  add column if not exists customer_email text;

-- One intent per pre-allocated order, and one per processor session. Both are
-- the lookup keys for authorization and for the shipping callback.
create unique index if not exists express_checkout_intents_order_id_key
  on public.express_checkout_intents (order_id);
create unique index if not exists express_checkout_intents_session_key
  on public.express_checkout_intents (veyra_session_id)
  where veyra_session_id is not null;

-- The sweeper's scan: unclaimed intents past their expiry.
create index if not exists express_checkout_intents_open_expiry_idx
  on public.express_checkout_intents (expires_at)
  where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 2. Shipping quotes
-- ---------------------------------------------------------------------------
create table if not exists public.express_shipping_quotes (
  id                     uuid primary key default gen_random_uuid(),
  veyra_session_id       text not null,

  -- sha256 over country|state|city|postal5 of the address that produced this
  -- quote. Computed identically from the redacted pre-auth contact and from the
  -- full wallet contact at authorization; the first 12 hex chars are embedded
  -- in the shipping method id so a mismatch is caught by the processor too.
  address_fingerprint    text not null,

  contact                jsonb not null default '{}'::jsonb,

  -- Byte-identical to what was returned to the wallet callback.
  shipping_methods       jsonb not null default '[]'::jsonb,
  tax_amount_cents       integer not null default 0,
  shipping_amount_cents  integer not null default 0,

  computed_at            timestamptz not null default now()
);

-- Authorization looks up by (session, fingerprint). Latest wins within a
-- fingerprint; rows are never deleted.
create index if not exists express_shipping_quotes_session_fp_idx
  on public.express_shipping_quotes (veyra_session_id, address_fingerprint, computed_at desc);

-- ---------------------------------------------------------------------------
-- 3. Orders: distinguish the lane + make an order findable by its session
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists checkout_channel text;

-- The reconciliation cron polls the processor by orders.payment_id, and the
-- settlement webhook matches on it, so this index is on the hot path.
-- (checkout-hardening.sql already creates it; re-asserted here so this file
-- stands alone.)
create index if not exists orders_payment_id_idx on public.orders (payment_id);

-- ---------------------------------------------------------------------------
-- 4. Settlement backstops the express lane depends on
-- Re-asserted, not assumed: the express lane is the first path where a lost
-- webhook means a charged card with an unpaid order, and both of these degrade
-- SILENTLY when absent.
-- ---------------------------------------------------------------------------
alter table if exists public.orders
  add column if not exists paid_side_effects_at timestamptz;

alter table if exists public.payment_events
  add column if not exists claimed_at timestamptz not null default now();

alter table if exists public.payment_events
  alter column processed_at drop not null;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- Written and read only by server code using the service-role client, same
-- reasoning as membership_billing_events. No anon/authenticated policies: an
-- intent row carries the authoritative charge amount, so a client that could
-- write one could choose its own price.
-- ---------------------------------------------------------------------------
alter table public.express_checkout_intents enable row level security;
alter table public.express_shipping_quotes  enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Verification — every column below must come back `t`.
-- ---------------------------------------------------------------------------
select
  to_regclass('public.express_checkout_intents') is not null            as intents_ok,
  to_regclass('public.express_shipping_quotes')  is not null            as quotes_ok,
  exists (select 1 from information_schema.columns
           where table_name='express_checkout_intents' and column_name='customer_email') as intent_email_ok,
  exists (select 1 from information_schema.columns
           where table_name='orders' and column_name='paid_side_effects_at') as side_effects_ok,
  exists (select 1 from information_schema.columns
           where table_name='payment_events' and column_name='claimed_at')   as claimed_ok,
  exists (select 1 from information_schema.columns
           where table_name='orders' and column_name='checkout_channel')     as channel_ok;
