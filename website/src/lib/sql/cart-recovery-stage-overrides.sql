-- ---------------------------------------------------------------------------
-- A NAMED CART CAN HAVE ONE STAGE OF ITS RECOVERY SEQUENCE REPLACED.
--
-- Two shoppers abandoned unusually good carts on 2026-09-06 and the owner
-- wanted their next recovery message to carry a specific gift instead of the
-- generic reminder. The wrong ways to do that, both rejected:
--
--   a separate campaign  is outside the cart_recovery quiet family, so it is
--                        deferred 24h by the shopper's own t30m and then
--                        defers their t24h in turn — and they receive the
--                        generic t12h as well, which is two emails about one
--                        cart;
--   editing the template changes the mail every other shopper gets.
--
-- So this REPLACES the body of one stage for one cart and adds no send path of
-- its own. The sweep still claims (abandoned_cart_id, stage) in
-- abandoned_cart_emails first and sends exactly once behind that claim; the
-- override only decides WHICH template that single guaranteed send renders.
-- Every idempotency property the sequence already has is therefore unchanged
-- and uninherited from anything new: retry, concurrent sweep, redeploy, a
-- conversion before the send, and unsubscribe all behave exactly as they do
-- for an ordinary stage, because it IS an ordinary stage.
--
-- THE PRIMARY KEY IS THE ISOLATION. One row per (cart, stage) and no wildcard,
-- no value threshold, no date range, no product rule — an override applies to
-- the cart named in it and to nothing else, so "which carts qualify" is
-- answered by `select count(*) from cart_recovery_stage_overrides` rather than
-- by reasoning about a predicate.
-- ---------------------------------------------------------------------------

create table if not exists public.cart_recovery_stage_overrides (
  abandoned_cart_id uuid not null,
  -- Matches abandoned_cart_emails.stage: 't30m' | 't12h' | 't24h' | 't72h'.
  stage text not null,
  -- The customer_offers catalogue key to mint and attach, or null for a body
  -- change with no entitlement. A stage that names one and cannot mint it
  -- sends NOTHING — see reserveAndSendStage — because an email promising a
  -- gift the till will not honour is worse than no email.
  offer_key text,
  -- Why this exists, for whoever finds the row later.
  note text,
  created_at timestamptz not null default now(),
  -- Observability only. The authoritative "has this been sent" is the
  -- abandoned_cart_emails row, and the template lookup deliberately does NOT
  -- filter on this: if a send were ever somehow re-attempted it must carry the
  -- SAME bespoke content, never silently fall back to the generic body.
  consumed_at timestamptz,
  consumed_email_id uuid,
  primary key (abandoned_cart_id, stage)
);

comment on table public.cart_recovery_stage_overrides is
  'Replaces the body of ONE cart-recovery stage for ONE named cart. Adds no send path: the sweep still claims (cart, stage) in abandoned_cart_emails and sends once behind that claim. See cart-recovery-stage-overrides.sql.';

comment on column public.cart_recovery_stage_overrides.consumed_at is
  'When the replaced stage actually sent. Observability only — abandoned_cart_emails is what prevents a second send, and the template lookup ignores this column on purpose.';

-- Nobody but the server touches this. No anon, no authenticated: an override
-- grants a free product, so a row inserted by a customer would be a gift they
-- wrote themselves.
alter table public.cart_recovery_stage_overrides enable row level security;

do $$ begin
  execute 'revoke all on public.cart_recovery_stage_overrides from public, anon, authenticated';
exception when undefined_object then null; end $$;

-- ---------------------------------------------------------------------------
-- EXTRA PERKS ON A REPLACED STAGE (2026-09-07).
--
-- A gift the store can price (a free product, a waived fee) is decided by the
-- catalogue and the checkout. An operator's promise about how ONE order will be
-- handled — expedited postage bought at their own cost, say — is not something
-- the store can verify, so it cannot be inferred and must not be hard-coded
-- into a template that other carts also render.
--
-- Recording it on the row makes it data: it is stated verbatim in the message,
-- and it is findable afterwards by whoever packs the box, rather than living
-- only in an email that the fulfilment side never sees. A promise nobody can
-- look up is a promise that gets missed.
--
-- Additive and idempotent; safe to re-run.
-- ---------------------------------------------------------------------------
alter table if exists public.cart_recovery_stage_overrides
  add column if not exists perks jsonb not null default '[]'::jsonb;

comment on column public.cart_recovery_stage_overrides.perks is
  'Operator promises stated verbatim in the replaced message, e.g. expedited shipping. NOT priced or verified by the store — whoever fulfils the order has to honour them, which is why they are recorded here rather than only in the email.';
