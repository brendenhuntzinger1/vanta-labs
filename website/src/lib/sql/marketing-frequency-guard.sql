-- Run once in Supabase → SQL Editor. Idempotent; safe to re-run.
--
-- ONE MARKETING-FREQUENCY GUARD FOR EVERY MARKETING SENDER (2026-09-04).
--
-- Before this, "nobody gets more than one marketing email a day" was true of
-- the retention automations only: they read email_send_log once per sweep and
-- skipped anyone mailed inside 24 hours. Campaigns, cart recovery, back-in-stock
-- alerts, coupon announcements and membership mail never looked, so a campaign,
-- a cart reminder and a restock alert could all reach one inbox in an hour and
-- only the automation held back. And because every cron job starts in the same
-- instant, two senders could each read "nobody mailed recently" and both send.
--
-- The guard now lives in the database, where concurrency can actually be
-- decided:
--
--   marketing_send_claim(email, type, reference, template, quiet, family)
--
-- takes an advisory lock on the ADDRESS, looks for a marketing send inside the
-- quiet window, and either inserts the email_send_log row itself with
-- status 'sending' ("claimed" — go and send, then close the row) or answers
-- "deferred" with the time of the send that stands in the way, so the caller
-- can come back after it. Two senders racing for one inbox serialise on the
-- lock; the second sees the first's row. There is no separate read step to
-- get stale.
--
-- WHAT COUNTS AS PRESSURE. Every non-auth row in email_send_log with status
-- 'sent', plus a 'sending' claim younger than fifteen minutes (a claim older
-- than that was stranded by a crash and must not hold an inbox shut for a day).
-- Transactional mail never touches email_send_log — receipts, shipping,
-- password resets and verification go through sendEmail directly or under the
-- auth: prefix — so it is never gated and never counts.
--
-- THE ONE EXEMPTION. A sequence's own earlier steps do not defer its later
-- ones: cart recovery's 30-minute, 12-hour and 24-hour reminders for the SAME
-- cart are one conversation, and the stages' own windows pace them. The caller
-- names the family ('cart_recovery_') and the reference (the cart id); rows
-- matching both are ignored. Everything else counts.
--
-- A DEFERRED SEND IS NOT A LOST SEND. Automations, campaigns and cart recovery
-- retry on their next sweep (each in its own way — see frequency.ts). Event
-- mail with no natural retry (a restock alert, a coupon announcement, a
-- membership welcome) is parked in marketing_send_queue, fully rendered, and
-- drained by the cron sweep once its not_before passes, through the same claim.
-- ---------------------------------------------------------------------------

-- The quiet-window read is keyed on the address; the existing indexes are all
-- keyed on campaign_type or reference_id.
create index if not exists email_send_log_recipient_sent_idx
  on public.email_send_log (recipient_email, sent_at desc);

create or replace function public.marketing_send_claim(
  p_email text,
  p_campaign_type text,
  p_reference_id text,
  p_template_key text,
  p_quiet_seconds integer default 86400,
  p_exempt_family text default null
) returns table (outcome text, log_id uuid, last_marketing_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_type text := nullif(trim(coalesce(p_campaign_type, '')), '');
  v_quiet interval := make_interval(secs => greatest(coalesce(p_quiet_seconds, 0), 0));
  v_last timestamptz;
  v_id uuid;
begin
  if v_email is null or v_type is null then
    outcome := 'refused'; log_id := null; last_marketing_at := null;
    return next; return;
  end if;

  -- One lock per inbox. Different addresses never contend; a transaction takes
  -- exactly one lock here and cannot deadlock.
  perform pg_advisory_xact_lock(hashtext('marketing_send:' || v_email));

  select max(l.sent_at) into v_last
  from public.email_send_log l
  where l.recipient_email = v_email
    and l.campaign_type not like 'auth:%'
    and l.sent_at > now() - v_quiet
    and (
      l.status = 'sent'
      or (l.status = 'sending' and l.sent_at > now() - interval '15 minutes')
    )
    and not (
      p_exempt_family is not null
      and l.campaign_type like p_exempt_family || '%'
      and l.reference_id is not distinct from p_reference_id
    );

  if v_last is not null and v_quiet > interval '0' then
    outcome := 'deferred'; log_id := null; last_marketing_at := v_last;
    return next; return;
  end if;

  begin
    insert into public.email_send_log (campaign_type, reference_id, recipient_email, template_key, sent_at, status)
    values (v_type, p_reference_id, v_email, coalesce(p_template_key, v_type), now(), 'sending')
    returning id into v_id;
  exception when unique_violation then
    -- The send-once index for this campaign_type already holds this
    -- reference (automations, auth debounce): somebody else has this one.
    outcome := 'duplicate'; log_id := null; last_marketing_at := null;
    return next; return;
  end;

  outcome := 'claimed'; log_id := v_id; last_marketing_at := null;
  return next; return;
end;
$$;

comment on function public.marketing_send_claim(text, text, text, text, integer, text) is
  'Atomically claim the right to send one marketing email to an address: claimed (row inserted at sending — send, then close it), deferred (a marketing send inside the quiet window stands in the way; last_marketing_at says when), duplicate (the send-once index already holds this reference), or refused (bad input).';

revoke execute on function public.marketing_send_claim(text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.marketing_send_claim(text, text, text, text, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- THE DEFERRED QUEUE, for event mail with no sweep of its own to retry it.
--
-- Rendered in full at the moment it was deferred (footer, unsubscribe link,
-- pixel), so draining it is delivery and nothing else. Every drain goes back
-- through marketing_send_claim, so a queued message can be deferred again and
-- is never a way around the guard.
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_send_queue (
  id uuid primary key default gen_random_uuid(),
  recipient_email text not null,
  campaign_type text not null,
  reference_id text,
  template_key text not null,
  subject text not null,
  html text not null,
  text_body text not null,
  not_before timestamptz not null,
  attempts integer not null default 0,
  -- queued | sent | failed | cancelled
  status text not null default 'queued',
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

comment on table public.marketing_send_queue is
  'Marketing emails held back by the frequency guard, rendered in full, to be delivered by the cron sweep once not_before passes. Drained through marketing_send_claim so the guard still applies.';

create index if not exists marketing_send_queue_due_idx
  on public.marketing_send_queue (not_before)
  where status = 'queued';

revoke all on public.marketing_send_queue from public, anon, authenticated;
grant select, insert, update, delete on public.marketing_send_queue to service_role;
alter table public.marketing_send_queue enable row level security;

-- A campaign recipient the guard sent back to the queue waits here; claimBatch
-- skips rows whose deferred_until is still in the future, so the sweep does
-- not re-claim them in a tight loop and the campaign does not stall on them.
alter table if exists public.email_campaign_recipients
  add column if not exists deferred_until timestamptz;

comment on column public.email_campaign_recipients.deferred_until is
  'Set when the frequency guard deferred this recipient; the batch claim ignores the row until this passes. Null once sent.';

create index if not exists email_campaign_recipients_deferred_idx
  on public.email_campaign_recipients (campaign_id, deferred_until)
  where status = 'pending' and deferred_until is not null;
