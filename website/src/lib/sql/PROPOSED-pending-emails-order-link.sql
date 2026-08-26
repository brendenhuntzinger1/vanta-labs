-- PROPOSAL — NOT APPLIED. Owner approval required (audit Rule 4).
--
-- Block C finding C-02: the pending_emails sweep delivers a receipt and never
-- closes out the order_email_log row, so the send-once slot stays free and the
-- next caller sends a second receipt to the same customer.
--
-- pending_emails deliberately carries no order id ("it has to survive the
-- failure of everything around it"). That reasoning holds for the SUBJECT and
-- BODY, which must stay self-contained — it does not require the order link to
-- be absent. These columns are nullable, so a row can still be queued when the
-- order context is unknown, and the sweep simply skips the write-back for it.

alter table public.pending_emails
  add column if not exists order_id uuid,
  add column if not exists email_kind text;

comment on column public.pending_emails.order_id is
  'Order this queued email belongs to, when known. Lets the sweep close out the '
  'matching order_email_log row on success so the send-once slot is not released '
  'to a later caller. Nullable: shipping/marketing rows have no order context.';

comment on column public.pending_emails.email_kind is
  'order_email_log.kind this row corresponds to (order_confirmation, '
  'refund_confirmation). Paired with order_id for the write-back.';

-- The sweep looks these up by (order_id, email_kind); nothing else queries them.
create index if not exists pending_emails_order_idx
  on public.pending_emails (order_id, email_kind)
  where order_id is not null;
