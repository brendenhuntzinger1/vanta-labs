-- ===========================================================================
-- ONE AUTH EMAIL PER ADDRESS PER MINUTE, ENFORCED BY THE DATABASE.
--
-- Double-clicking signup produced two confirmation emails, and three impatient
-- clicks of "resend" produced three. The rate limiter allows a small burst by
-- design — it exists to stop flooding, not to stop a customer clicking twice —
-- so nothing prevented it. From the customer's side this is the repeated mail
-- they complained about, and it is worse than noise: each copy carries a
-- DIFFERENT token, so acting on the wrong one is how "I got the email but the
-- link doesn't work" happens.
--
-- Per MINUTE rather than forever, because a genuine resend a few minutes later
-- must still work. That is the one path available to a customer whose
-- confirmation never arrived, and closing it would strand exactly the people
-- this is meant to help.
--
-- `sent_at AT TIME ZONE 'UTC'` is load-bearing: date_trunc over timestamptz is
-- only STABLE (its answer depends on the session timezone) and Postgres refuses
-- it in a generated column or index. Shifting to a plain timestamp first makes
-- the expression IMMUTABLE.
--
-- Applied to the live project on 2026-08-30 as auth_email_debounce_unique.
-- ===========================================================================

alter table public.email_send_log
  add column if not exists auth_send_minute timestamp
  generated always as (date_trunc('minute', sent_at at time zone 'UTC')) stored;

-- A database with history may already hold rows this index would reject — the
-- harness did, from runs made before the guard existed. Production did not, so
-- the index went on cleanly there, but a migration that only works on a clean
-- table is a migration that fails on somebody's machine at the worst moment.
-- Older duplicates are dropped, newest kept: the newest token is the live one.
delete from public.email_send_log a
using public.email_send_log b
where a.ctid > b.ctid
  and a.campaign_type = b.campaign_type
  and a.recipient_email = b.recipient_email
  and a.auth_send_minute = b.auth_send_minute
  and a.campaign_type like 'auth:%'
  and a.status <> 'failed'
  and b.status <> 'failed';

create unique index if not exists email_send_log_auth_once_per_minute
  on public.email_send_log (campaign_type, recipient_email, auth_send_minute)
  where campaign_type like 'auth:%' and status <> 'failed';
