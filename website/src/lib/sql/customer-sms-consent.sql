-- Records TCPA / A2P 10DLC opt-in for SMS marketing on customer accounts.
-- The checkbox in account settings is unticked by default; ticking it
-- stamps sms_consent_at, unticking (or replying STOP) stamps sms_opted_out_at.
--
-- Safe to run more than once (IF NOT EXISTS).

alter table public.customer_preferences
  add column if not exists sms_marketing boolean not null default false,
  add column if not exists sms_consent_at timestamptz,
  add column if not exists sms_opted_out_at timestamptz;
