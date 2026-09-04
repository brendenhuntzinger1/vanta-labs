-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- ONE-TIME, PER-CUSTOMER OFFERS — the free GHK-Cu that ships with the 60-day
-- win-back, and anything shaped like it later.
--
-- WHY NOT A COUPON CODE. The obvious build is one coupon, `FREEGHKCU`, mailed
-- to everyone. That coupon is a bearer token the moment the first recipient
-- posts it to Reddit: `coupons.assigned_email` exists, but `redeem_coupon()` is
-- a single UPDATE keyed on the CODE and never reads assigned_email, so binding
-- is enforced on the read path and not on the write path. One shared code also
-- has one shared expiry and one shared counter, so "expire it for the people
-- who got it in March" is not expressible.
--
-- So each eligible customer gets their OWN token. It is minted at send time,
-- stored only as a hash, tied to their address, expires on its own clock, and
-- is consumed exactly once.
--
-- WHY A HASH AND NOT THE TOKEN. The row is worth nothing to anyone who reads
-- the table. A leaked backup, a careless log line, an over-broad admin export —
-- none of them yield a usable offer, because the only thing that redeems is the
-- preimage, and that exists solely in the customer's own email.
--
-- HOW THIS DIFFERS FROM promotion_redemption_claims, DELIBERATELY.
--
-- The Buy X Get Y claim table releases automatically: a refunded, cancelled or
-- failed order gives its redemption back, and its header says so proudly —
-- "every release path that has to be REMEMBERED is a release path that will
-- eventually be missed." That is right for a store-wide promotion with a
-- capacity limit, where a cancelled order should not burn a slot.
--
-- It is exactly wrong here, and the difference is the whole security model. A
-- refunded order has usually already SHIPPED. If a refund released the offer, a
-- customer could order, receive a free vial, refund, and redeem again — for as
-- long as they cared to. So redemption here is PERMANENT once the order is
-- paid, and nothing anywhere un-marks it.
--
-- The hold is the part that is borrowed: an unpaid checkout must not lock the
-- offer forever, so a reservation ages out and the offer becomes claimable
-- again. The distinction that matters is:
--
--     reserved  →  a checkout is in flight. Expires on its own.
--     redeemed  →  they were charged. Forever, refund or no refund.

create table if not exists public.customer_offers (
  id uuid primary key default gen_random_uuid(),
  -- Which offer this is, e.g. 'winback_60_free_ghkcu'. Text rather than a
  -- foreign key so retiring an offer never deletes the evidence of what it did.
  offer_key text not null,
  -- sha256 of the token, hex. The token itself is never stored anywhere.
  token_hash text not null,
  -- Lower-cased at insert. The offer belongs to this address and no other.
  email text not null,
  -- What they get. A slug plus an optional dose id, matching how the rest of
  -- the catalogue addresses a purchasable unit.
  product_slug text not null,
  variant_id text,
  -- The gate. An order must reach this subtotal, in cents, BEFORE the free unit
  -- is added, or the offer does not apply. Zero means no minimum — allowed, but
  -- see the note in customer-offers.ts about shipping a vial for the price of
  -- postage.
  min_subtotal_cents integer not null default 0,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- THE HOLD. A checkout in flight, so two tabs cannot both spend it.
  reserved_order_id text,
  reserved_at timestamptz,
  -- THE CONSUMPTION. Written once, when an order is actually paid, and never
  -- cleared by anything — not a refund, not a cancellation, not a replacement.
  redeemed_order_id text,
  redeemed_at timestamptz,
  -- Operator kill switch, for an offer mailed in error.
  revoked_at timestamptz
);

comment on table public.customer_offers is
  'One-time per-customer offers (e.g. free GHK-Cu with the 60-day win-back). Token stored as a hash; redemption is permanent and survives refunds by design. See customer-offers.sql.';

-- Redemption is by token, and it must be O(1) and unambiguous.
create unique index if not exists customer_offers_token_hash_key
  on public.customer_offers (token_hash);

-- ONE LIVE OFFER PER PERSON PER CAMPAIGN. Without this, a second sweep — or an
-- operator re-running one — mints a second token for the same address and that
-- customer gets two free vials, each perfectly valid. Partial, so a revoked
-- offer can be deliberately reissued.
create unique index if not exists customer_offers_one_live_per_email
  on public.customer_offers (offer_key, email)
  where revoked_at is null;

-- The reporting read: "how is the free-GHK-Cu offer doing".
create index if not exists customer_offers_key_idx
  on public.customer_offers (offer_key, issued_at desc);

-- Joining an order back to the offer that priced it.
create index if not exists customer_offers_redeemed_order_idx
  on public.customer_offers (redeemed_order_id)
  where redeemed_order_id is not null;

-- ---------------------------------------------------------------------------
-- RESERVE — the only way an offer becomes spendable, and it is atomic.
--
-- Returns the offer row when this order may use it, or no rows at all. Every
-- refusal is silent to the caller beyond "no": a customer who is told WHY a
-- token failed is a customer who can enumerate.
--
-- ONE advisory lock, keyed on the token hash, so two concurrent checkouts for
-- the same offer serialise and the second sees the first's reservation. Claims
-- for different offers never contend, and a transaction taking exactly one lock
-- cannot deadlock.
-- ---------------------------------------------------------------------------
create or replace function public.customer_offer_reserve(
  p_token_hash text,
  p_order_id text,
  p_email text,
  p_hold_seconds integer default 1800
) returns setof public.customer_offers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_offer public.customer_offers;
begin
  if p_token_hash is null or p_order_id is null or v_email is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_offer:' || p_token_hash));

  select * into v_offer
  from public.customer_offers
  where token_hash = p_token_hash
  for update;

  if not found then return; end if;
  if v_offer.revoked_at is not null then return; end if;
  if v_offer.expires_at <= now() then return; end if;

  -- THE BINDING. The offer is this address's property. A forwarded link opened
  -- by someone else, or the same person checking out under a different address,
  -- gets nothing.
  if v_offer.email <> v_email then return; end if;

  -- ALREADY SPENT. Permanent, except for the one case that is not a second
  -- spend at all: the same order asking again, which is what an idempotent
  -- checkout replay looks like.
  if v_offer.redeemed_at is not null and v_offer.redeemed_order_id is distinct from p_order_id then
    return;
  end if;

  -- HELD BY A DIFFERENT CHECKOUT that has not aged out yet.
  if v_offer.reserved_order_id is not null
     and v_offer.reserved_order_id <> p_order_id
     and v_offer.reserved_at > now() - make_interval(secs => greatest(p_hold_seconds, 0))
     -- A hold whose order already died releases immediately rather than
     -- squatting for the rest of the window.
     and not exists (
       select 1 from public.orders o
       where o.order_id = v_offer.reserved_order_id
         and o.payment_status in ('canceled', 'cancelled', 'payment_failed', 'refunded')
     ) then
    return;
  end if;

  update public.customer_offers
  set reserved_order_id = p_order_id,
      reserved_at = now()
  where id = v_offer.id
  returning * into v_offer;

  return next v_offer;
end;
$$;

comment on function public.customer_offer_reserve(text, text, text, integer) is
  'Atomically hold a one-time offer for one order. Returns the offer row, or nothing when the token is unknown, expired, revoked, held by another live checkout, already redeemed, or belongs to another address.';

-- ---------------------------------------------------------------------------
-- REDEEM — permanent, and idempotent for the same order.
--
-- Called from the paid side-effects path, beside the other things that happen
-- exactly once when money actually arrives. Deliberately keyed on the ORDER,
-- not the token: by the time this runs the token is long gone from the request,
-- and the order is the thing we know was paid.
-- ---------------------------------------------------------------------------
create or replace function public.customer_offer_redeem(
  p_order_id text
) returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with updated as (
    update public.customer_offers
    set redeemed_order_id = p_order_id,
        redeemed_at = now()
    where reserved_order_id = p_order_id
      -- Written once. A second call for the same order is a no-op rather than a
      -- new timestamp, so "when did they redeem" stays true.
      and redeemed_at is null
    returning 1
  )
  select count(*) > 0 from updated;
$$;

comment on function public.customer_offer_redeem(text) is
  'Permanently consume the offer reserved by this order. Never reversed: a refunded order has usually shipped, so releasing the offer would let one customer redeem it repeatedly.';

-- ---------------------------------------------------------------------------
-- RELEASE — for a checkout that fails BEFORE payment, and only then.
--
-- Not required for correctness; the hold ages out on its own. This returns the
-- offer in seconds rather than half an hour when the checkout knows it failed.
-- The guard is the important line: an offer that was redeemed is never released
-- by this or by anything else.
-- ---------------------------------------------------------------------------
create or replace function public.customer_offer_release(
  p_order_id text
) returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with updated as (
    update public.customer_offers
    set reserved_order_id = null,
        reserved_at = null
    where reserved_order_id = p_order_id
      and redeemed_at is null
    returning 1
  )
  select count(*) > 0 from updated;
$$;

comment on function public.customer_offer_release(text) is
  'Drop the hold an unpaid checkout placed on an offer. Refuses to touch a redeemed offer.';

-- ---------------------------------------------------------------------------
-- LEAST PRIVILEGE, matching rpc-default-privilege-lockdown.sql. A browser key
-- must never reserve, redeem or release an offer, nor read the table: the rows
-- carry customer addresses and the shape of who was mailed what.
-- ---------------------------------------------------------------------------
revoke all on public.customer_offers from public, anon, authenticated;
grant select, insert, update, delete on public.customer_offers to service_role;

revoke execute on function public.customer_offer_reserve(text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.customer_offer_redeem(text) from public, anon, authenticated;
revoke execute on function public.customer_offer_release(text) from public, anon, authenticated;

grant execute on function public.customer_offer_reserve(text, text, text, integer) to service_role;
grant execute on function public.customer_offer_redeem(text) to service_role;
grant execute on function public.customer_offer_release(text) to service_role;

alter table public.customer_offers enable row level security;

-- ---------------------------------------------------------------------------
-- ATTACHING AN OFFER TO AN AUTOMATION.
--
-- Which sequence carries which offer is an operator decision, not a constant in
-- the code — the same reasoning that made the CTA text and destination editable
-- rather than hard-coded. Null means "no offer", which is what every automation
-- says until somebody chooses otherwise.
--
-- Deliberately NOT a foreign key: the set of offers lives in OFFER_CATALOG in
-- customer-offers.ts, because each one needs a product, a minimum and a
-- lifetime that belong with the code that grants them. An unknown value here is
-- ignored by the sweep rather than crashing it.
alter table if exists public.email_automations
  add column if not exists offer_key text;

comment on column public.email_automations.offer_key is
  'One-time offer minted per recipient when this automation sends, e.g. winback_60_free_ghkcu. Null for no offer. Values come from OFFER_CATALOG in customer-offers.ts.';

-- ---------------------------------------------------------------------------
-- MORE THAN ONE KIND OF GIFT.
--
-- The first offer was a free product, and the table said so structurally:
-- `product_slug` was NOT NULL because every offer had one. Free shipping does
-- not — it zeroes a charge rather than adding a line — so the shape has to say
-- WHAT is being granted, not assume.
--
-- WHY THE KIND IS STORED RATHER THAN LOOKED UP. OFFER_CATALOG in
-- customer-offers.ts already owns the product, the minimum and the lifetime,
-- and the kind could be read from there by offer_key. It is written down here
-- anyway because a token lives for thirty days and the catalogue is code: an
-- offer minted in March must still redeem as the thing it promised in March,
-- even if the entry is edited or retired in the meantime. The row is the
-- promise; the catalogue is only how new ones are made.
alter table if exists public.customer_offers
  add column if not exists reward_kind text not null default 'free_product';

comment on column public.customer_offers.reward_kind is
  'What this offer grants: free_product (a $0 order line, product_slug set) or free_shipping (the shipping charge zeroed). Written at issue time so an old token redeems as what it promised.';

-- Free shipping has no product, so the column can no longer be mandatory.
-- Existing rows are all free_product and already carry a slug, so nothing is
-- rewritten and nothing becomes ambiguous.
alter table if exists public.customer_offers
  alter column product_slug drop not null;

-- The one invariant that replaces the NOT NULL: a product gift must name a
-- product, and a shipping gift must not pretend to. Enforced in the database
-- because the alternative is trusting every future writer to remember.
do $$ begin
  alter table public.customer_offers
    add constraint customer_offers_reward_shape check (
      (reward_kind = 'free_product' and product_slug is not null)
      or (reward_kind = 'free_shipping' and product_slug is null)
    );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- A THIRD KIND: FREE SHIPPING **AND** A PERCENTAGE, in one gift.
--
-- The percentage rides in the coupon slot of resolveCustomerDiscount, so it
-- obeys the store's existing single-best-discount rule exactly as a coupon
-- does — it competes, and it can lose to a better membership or ambassador
-- price. The free shipping half does NOT compete, because shipping was never
-- in that race. So the worst case is "the customer keeps their better
-- discount and still gets free shipping", which is the right worst case.
alter table if exists public.customer_offers
  add column if not exists percent_off integer;

comment on column public.customer_offers.percent_off is
  'Percentage off for reward_kind = free_shipping_percent. Null for the other kinds. Competes as a coupon-style discount; the free shipping it comes with does not.';

-- The shape constraint has to learn the new kind. Dropped and recreated rather
-- than added alongside, so there is exactly one rule to read.
alter table public.customer_offers
  drop constraint if exists customer_offers_reward_shape;

alter table public.customer_offers
  add constraint customer_offers_reward_shape check (
    (reward_kind = 'free_product' and product_slug is not null and percent_off is null)
    or (reward_kind = 'free_shipping' and product_slug is null and percent_off is null)
    or (reward_kind = 'free_shipping_percent' and product_slug is null
        and percent_off is not null and percent_off > 0 and percent_off <= 100)
  );

-- ---------------------------------------------------------------------------
-- A REDEEMED OFFER MUST NOT BLOCK THE NEXT ONE.
--
-- The one-live-per-address index above was keyed on `revoked_at is null`
-- only, so a customer who redeemed their free GHK-Cu, bought again, and lapsed
-- a second time hit the index when the next 60-day win-back tried to mint —
-- and received the operator's "here is your free GHK-Cu" copy with no token
-- behind it. A redeemed row is history, not a live offer: it is excluded here,
-- and customer-offers.ts retires an EXPIRED (or lost-in-a-failed-send) row
-- before reissuing, so the invariant "at most one spendable token per address
-- per campaign" still holds. Idempotent; safe to re-run.
-- ---------------------------------------------------------------------------
drop index if exists public.customer_offers_one_live_per_email;
create unique index if not exists customer_offers_one_live_per_email
  on public.customer_offers (offer_key, email)
  where revoked_at is null and redeemed_at is null;

-- ---------------------------------------------------------------------------
-- A PERCENTAGE ON ITS OWN. reward_kind = 'percent': no product, no shipping
-- waiver, percent_off set. Idempotent; safe to re-run.
-- ---------------------------------------------------------------------------
alter table public.customer_offers
  drop constraint if exists customer_offers_reward_shape;
alter table public.customer_offers
  add constraint customer_offers_reward_shape check (
    (reward_kind = 'free_product' and product_slug is not null and percent_off is null)
    or (reward_kind = 'free_shipping' and product_slug is null and percent_off is null)
    or (reward_kind in ('free_shipping_percent', 'percent') and product_slug is null
        and percent_off is not null and percent_off > 0 and percent_off <= 100)
  );

-- ---------------------------------------------------------------------------
-- A PRODUCT AND A PERCENTAGE TOGETHER. reward_kind = 'free_product_percent':
-- product_slug set, percent_off set. Idempotent; safe to re-run.
-- ---------------------------------------------------------------------------
alter table public.customer_offers
  drop constraint if exists customer_offers_reward_shape;
alter table public.customer_offers
  add constraint customer_offers_reward_shape check (
    (reward_kind = 'free_product' and product_slug is not null and percent_off is null)
    or (reward_kind = 'free_shipping' and product_slug is null and percent_off is null)
    or (reward_kind in ('free_shipping_percent', 'percent') and product_slug is null
        and percent_off is not null and percent_off > 0 and percent_off <= 100)
    or (reward_kind = 'free_product_percent' and product_slug is not null
        and percent_off is not null and percent_off > 0 and percent_off <= 100)
  );
