-- SMS marketing consent, recorded per address, whoever gave it and wherever.
--
-- customer_preferences carries SMS consent for ACCOUNT holders (keyed by
-- user_id, customer-sms-consent.sql). A guest who ticks the SMS box at the
-- checkout, or a shopper who ticks it on the sign-up page before their account
-- is confirmed, has no row there to carry it. This table is the consent
-- record for everyone: one row per lowercase email address, the number the
-- person typed, where they ticked the box, the sentence they ticked, when, and
-- when they said stop. src/lib/sms-consent.ts writes it (and mirrors an
-- account holder's decision into customer_preferences); the Omnisend contact
-- sync reads it after the account row (src/lib/marketing/omnisend/contacts.ts),
-- and the reconcile stamps opted_out_at here when Omnisend reports a STOP.
--
-- TCPA / A2P 10DLC: the timestamp and the wording are the consent evidence a
-- carrier audit asks for, so consent_text is stored with the row rather than
-- assumed from whatever the site says today.
--
-- Service-role only: RLS on, no policies. Safe to run more than once.

create table if not exists public.sms_subscribers (
  email text primary key,
  phone text not null,
  -- "signup", "checkout", "account-settings"
  source text,
  consented_at timestamptz not null default now(),
  opted_out_at timestamptz,
  consent_text text,
  updated_at timestamptz not null default now()
);

alter table public.sms_subscribers enable row level security;
