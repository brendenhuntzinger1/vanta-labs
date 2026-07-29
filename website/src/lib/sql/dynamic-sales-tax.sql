-- Dynamic sales tax recordkeeping (run once in the Supabase SQL editor).
--
-- Sales tax is now resolved per order from the shipping address (nexus states
-- + destination-state rate) instead of a storewide flat rate. tax_amount (the
-- dollars collected) already exists on orders; these two columns complete the
-- audit trail so the admin tax report and the by-state CSV export can group
-- collections without re-deriving rates:
--
--   tax_rate_percent — the exact rate applied to this order (0 = no tax)
--   tax_state        — the destination state the rate was applied for
--                      (null = no tax collected, e.g. a non-nexus state)
--
-- The app stores these best-effort: until this migration runs, checkout still
-- works and simply doesn't persist the rate/state detail (the tax report then
-- falls back to the order's shipping state). Safe to run more than once.

alter table public.orders
  add column if not exists tax_rate_percent numeric(6,3) not null default 0,
  add column if not exists tax_state text;

-- The by-state tax report filters on taxed orders; keep it fast as orders grow.
create index if not exists orders_tax_state_idx
  on public.orders (tax_state)
  where tax_amount > 0;
