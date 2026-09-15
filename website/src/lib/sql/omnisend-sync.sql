-- Omnisend server-side sync: the event ledger and the sync watermark.
--
-- omnisend_events_sent is the exactly-once record for order and cart events
-- pushed to Omnisend (see src/lib/marketing/omnisend/ledger.ts for the
-- claim / record / release contract). Keyed on (entity, event name) so that
-- "paid for order" and "order fulfilled" for the same order are independent
-- rows — one cannot block the other.
--
-- omnisend_sync_state holds the nightly reconcile's watermark and the last
-- catalogue push, as jsonb under a short key.
--
-- Both are service-role only: RLS on, no policies.

create table if not exists public.omnisend_events_sent (
  entity_id text not null,
  event_name text not null,
  event_id text not null,
  delivered boolean not null default false,
  attempts integer not null default 1,
  first_sent_at timestamptz not null default now(),
  last_error text,
  primary key (entity_id, event_name)
);

alter table public.omnisend_events_sent enable row level security;

create index if not exists omnisend_events_sent_undelivered
  on public.omnisend_events_sent (first_sent_at)
  where delivered = false;

create table if not exists public.omnisend_sync_state (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.omnisend_sync_state enable row level security;
