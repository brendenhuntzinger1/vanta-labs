-- Adds the shipping State/Province and contact Phone captured at checkout.
-- Carriers require both for delivery; the checkout form now collects them.
--
-- The app stores these best-effort: until this migration runs, checkout still
-- works and simply doesn't persist state/phone. Safe to run more than once.

alter table public.orders
  add column if not exists state text,
  add column if not exists phone text;
