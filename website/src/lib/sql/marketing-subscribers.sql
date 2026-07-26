-- Marketing opt-in list that works for BOTH guests and account customers.
--
-- Account customers already have customer_preferences.marketing_emails, but
-- guest checkouts have no account row — so an at-checkout "email me offers"
-- opt-in needs an email-keyed store. The coupon-announcement broadcast unions
-- this table with the account opt-ins (deduped) so both get notified.
--
-- Additive & safe. Writes to it are best-effort (never block an order), so the
-- app keeps working before this migration is run — opt-ins just aren't stored
-- until it is. Run once in Supabase → SQL Editor.

create table if not exists public.marketing_subscribers (
  email text primary key,
  source text,
  opted_in_at timestamptz not null default now(),
  unsubscribed_at timestamptz
);

-- Service-role only (the broadcast + admin read via the service key); RLS on,
-- no public policies = deny-by-default for anon/authenticated clients.
alter table public.marketing_subscribers enable row level security;
