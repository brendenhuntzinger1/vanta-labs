-- Ambassador store-credit wallet + payout method.
-- This is a SEPARATE, NON-EXPIRING balance, distinct from the membership
-- store_credit_ledger (which is deliberately monthly use-it-or-lose-it).
-- Ambassador credit is earned money (a payout or bonus) and must never expire.

create table if not exists public.ambassador_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_cents integer not null,           -- signed: grants +, redemptions -
  reason text not null,                    -- payout | bonus | redemption | redemption_refund | admin_adjustment
  order_id text,                           -- set for redemption / redemption_refund
  note text,
  created_by text,                         -- admin username for grants/adjustments
  created_at timestamptz not null default now()
);

create index if not exists idx_ambassador_wallet_user
  on public.ambassador_wallet_ledger(user_id, created_at desc);

-- One redemption row per order — defeats duplicate redemption on webhook retries.
create unique index if not exists idx_ambassador_wallet_redemption_once
  on public.ambassador_wallet_ledger(order_id)
  where reason = 'redemption';

alter table public.ambassador_wallet_ledger enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'ambassador_wallet_ledger' and policyname = 'ambassador_wallet_select_own'
  ) then
    create policy ambassador_wallet_select_own on public.ambassador_wallet_ledger
      for select using (user_id = auth.uid());
  end if;
end;
$$;

-- Ambassador's chosen payout method: 'cash' or 'store_credit'.
alter table public.partners     add column if not exists payout_method text not null default 'cash';
alter table public.ambassadors  add column if not exists payout_method text not null default 'cash';

-- Records which orders have already been redeemed against the wallet, and how
-- much, so refunds can reverse the exact amount.
alter table public.orders add column if not exists ambassador_credit_redeemed_cents integer not null default 0;
