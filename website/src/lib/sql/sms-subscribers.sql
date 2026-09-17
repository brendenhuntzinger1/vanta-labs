-- ---------------------------------------------------------------------------
-- sms_subscribers: THE ONE COLUMN THIS STORE'S FLOWS NEED, AND NOTHING ELSE.
--
-- THIS FILE USED TO CREATE THE TABLE. That was wrong and would have failed
-- silently. Production already has `public.sms_subscribers`, and a better one
-- than the file described: primary key on `phone_e164`, a status with a CHECK,
-- marketing and transactional consent kept apart, `disclosure_version`,
-- `opt_out_keyword`, `resubscribed_at`, `resubscribe_count`, verification and
-- carrier columns. The old file said `create table if not exists`, so applying
-- it would have done nothing at all, every insert this app makes would have
-- failed on columns that do not exist, and the consent writer catches its own
-- errors — so a customer could tick the box, be told they were subscribed, and
-- have nothing recorded anywhere. Checked against production on 2026-09-17
-- before deploying, which is the only reason it was found.
--
-- WHY AN EMAIL COLUMN. The number is the subscriber and the primary key, which
-- is right. But the welcome code is bound to an address (coupons.assigned_email),
-- the Omnisend contact is identified by address, and a guest checkout consents
-- with an address and no account. One nullable, indexed column joins the two
-- without touching anything that already works.
--
-- SAFE TO RUN MORE THAN ONCE. Every statement is guarded, nothing is dropped,
-- no existing column is altered, and no row is written. Production held 0 rows
-- when this was written, so there is nothing to backfill.
-- ---------------------------------------------------------------------------

alter table public.sms_subscribers
  add column if not exists email text;

-- The lookup every flow makes: "where does this address stand with texts?"
create index if not exists sms_subscribers_email_idx
  on public.sms_subscribers (email)
  where email is not null;

comment on column public.sms_subscribers.email is
  'The address this consent is tied to: the account''s, or the one typed at a guest checkout. The welcome code is bound to it (coupons.assigned_email) and the Omnisend contact is identified by it. Nullable: a number may exist here without one.';

-- RLS is already enabled on this table in production and no policy is added
-- here. Every read and write in this application goes through the service
-- role (lib/sms-consent.ts), and a consent ledger is not something a customer
-- session should be able to select.
