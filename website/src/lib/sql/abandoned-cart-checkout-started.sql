-- ---------------------------------------------------------------------------
-- THE MIDDLE OF THE FUNNEL THAT DID NOT EXIST.
--
-- The programme could see a click (abandoned_cart_emails.clicked_at), a
-- restore (abandoned_carts.restored_at) and an order — and NOTHING between the
-- restore and the order. So a shopper who followed a recovery link, got their
-- cart back and then stalled at the checkout was indistinguishable from one
-- who never clicked at all: both are simply absent from every figure. That is
-- the same ambiguity restored_at was added to remove one step earlier.
--
-- WHERE IT IS STAMPED, AND WHERE IT IS NOT. From the cart-tracking beacon
-- (/api/cart/track, `reachedCheckout`), keyed on the browser session that owns
-- the cart. It records that the shopper REACHED the checkout page and says
-- nothing whatever about payment: no payment route writes it, and nothing that
-- prices, charges, reserves stock or fulfils ever reads it. First touch only,
-- so bouncing between cart and checkout is one arrival rather than five.
--
-- CHECKED IN BECAUSE PRODUCTION IS NOT THE SOURCE OF TRUTH. This column was
-- first applied straight to production, and the local harness — which builds
-- its schema from these files — then had no such column, so the stamp silently
-- did nothing there and the browser test that was meant to prove the fix
-- proved nothing. A migration that exists only in one database is a migration
-- the next environment will not have.
--
-- IDEMPOTENT. Safe to re-run.
-- ---------------------------------------------------------------------------

alter table public.abandoned_carts
  add column if not exists checkout_started_at timestamptz;

comment on column public.abandoned_carts.checkout_started_at is
  'First time this cart reached the checkout page. Funnel instrumentation only - never read by pricing, payment or fulfilment.';

create index if not exists abandoned_carts_checkout_started_idx
  on public.abandoned_carts (checkout_started_at)
  where checkout_started_at is not null;
