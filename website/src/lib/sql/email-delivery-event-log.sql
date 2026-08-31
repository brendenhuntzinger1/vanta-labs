-- ===========================================================================
-- A RECORD THAT THE PROVIDER WEBHOOK ACTUALLY FIRED.
--
-- The audit question that could not be answered was not "did anything bounce?"
-- but "is Resend even calling us?". Those look identical from the database:
-- `email_suppressions` was empty, and an empty suppression table is exactly
-- what both a healthy sender and an unconfigured webhook produce. There was no
-- third state, so 37 sends with no recorded event was unfalsifiable either way.
--
-- This is the missing third state. Every event the endpoint accepts is written
-- here, INCLUDING the ones it does nothing about (delivered, opened, clicked,
-- delayed). A single row proves the provider is configured, authenticated and
-- reaching us; an empty table after a known-good send proves it is not.
--
-- Deliberately NOT folded into email_send_log. That table is keyed on our own
-- send attempt and has no provider message id to join on, so a webhook event
-- has nothing to attach to. Fixing that is a bigger change than making the
-- webhook observable, and this does not depend on it.
--
-- IDEMPOTENCY. Providers retry anything not answered 2xx, and Resend can
-- redeliver an event it already delivered. The unique index makes a repeat a
-- no-op rather than a second row, so "how many times did this bounce?" stays
-- honest. provider_message_id can be absent on a malformed payload, so the
-- index covers the coalesced value rather than the raw column.
-- ===========================================================================

create table if not exists public.email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  -- The provider's own id for the message ("email_id" on a Resend payload).
  -- Nullable: an event we could not attribute is still evidence the webhook
  -- fired, which is the whole point of this table.
  provider_message_id text,
  -- Raw provider event name, e.g. 'email.delivered', 'email.bounced:permanent'.
  event_type text not null,
  -- What our parser decided it meant: delivered | hard_bounce | soft_bounce |
  -- complaint | delayed | ignored.
  kind text not null,
  recipient_email text,
  -- True when this event caused a suppression write.
  suppressed boolean not null default false,
  received_at timestamptz not null default now()
);

create unique index if not exists email_delivery_events_once
  on public.email_delivery_events (coalesce(provider_message_id, ''), event_type, coalesce(recipient_email, ''));

create index if not exists email_delivery_events_received_at
  on public.email_delivery_events (received_at desc);

alter table public.email_delivery_events enable row level security;

-- No policies: service-role only, like every other operational log here. The
-- rows carry customer email addresses and must never be readable from a
-- browser session.
