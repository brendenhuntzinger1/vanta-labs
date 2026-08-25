-- =============================================================================
-- Order email log — one auditable row per transactional email about an order.
--
-- THE GAP. Nothing recorded that an order confirmation was ever sent. Cart
-- recovery and membership welcome write to email_send_log; receipts wrote
-- nowhere. So "did this customer get their confirmation?" could only be
-- answered by ABSENCE of evidence — no error in the platform log, no row in
-- pending_emails — which is an argument, not a record, and it decays the moment
-- log retention expires. In a chargeback or a "I never got a receipt" dispute
-- there was nothing to show.
--
-- WHY NOT email_send_log. That table is the MARKETING ledger: it is keyed by
-- campaign_type, and its rows are campaign sends. A receipt is not a campaign,
-- and more importantly that table cannot enforce send-once — it has no
-- constraint stopping a second identical row.
--
-- WHAT IT DELIBERATELY DOES NOT STORE. Not the recipient address, not the
-- subject, not the body. The order row already holds the customer's email; a
-- second copy in a second table is one more place it can leak from and one more
-- place to scrub on erasure. A masked form is kept instead, which answers "did
-- it go to the right person?" without being the address.
-- =============================================================================

create table if not exists public.order_email_log (
  id                  bigserial   primary key,
  order_id            text        not null,
  -- 'order_confirmation' | 'refund_confirmation' | ...
  kind                text        not null,
  status              text        not null check (status in ('sending', 'sent', 'failed')),
  -- 'resend' | 'sendgrid' | 'smtp' | 'none'
  provider            text,
  -- The provider's own id for the message. This is the join between our record
  -- and theirs; without it a "sent" row is only our word for it.
  provider_message_id text,
  -- The provider's reason for a rejection, truncated. Never a credential.
  error               text,
  -- 'b***@example.com'. Enough to confirm the right person, not the address.
  recipient_masked    text,
  attempted_at        timestamptz not null default now(),
  completed_at        timestamptz
);

-- SEND-ONCE, ENFORCED BY THE DATABASE.
--
-- The webhook already gates the confirmation email behind the atomic
-- paid_side_effects_at claim, so a duplicate delivery cannot reach it — that
-- guard is real and was observed working in production (the conditional
-- `paid_side_effects_at is null` update at 03:36:15.448 on VL-37C1E4B0). This
-- index is the second, independent line: it holds no matter which code path
-- asks, including a future one that forgets the claim, and it closes the race
-- between two callers that both pass the claim check in the same instant.
--
-- PARTIAL, on purpose. Only a live attempt ('sending') or a delivered one
-- ('sent') occupies the slot. A 'failed' row falls out of the index, so a
-- genuine retry is still possible and every failed attempt stays on the record
-- instead of overwriting the last one.
create unique index if not exists order_email_log_one_live
  on public.order_email_log (order_id, kind)
  where status in ('sending', 'sent');

create index if not exists order_email_log_order_idx
  on public.order_email_log (order_id, attempted_at desc);

alter table public.order_email_log enable row level security;

comment on table public.order_email_log is
  'One row per transactional email about an order. The partial unique index (order_id, kind) where status in (sending, sent) makes a duplicate confirmation impossible at the database level. Stores no recipient address — only a masked form.';
