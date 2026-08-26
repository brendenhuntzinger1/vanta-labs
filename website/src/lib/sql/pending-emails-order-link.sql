-- ===========================================================================
-- C-02 — let the retry sweep close the send-once slot it is draining.
--
-- WHAT IS WRONG. `order_email_log` carries the send-once guard:
--
--   CREATE UNIQUE INDEX order_email_log_one_live ON public.order_email_log
--     USING btree (order_id, kind) WHERE status IN ('sending','sent')
--
-- A FAILED send deliberately falls outside that index, so a genuine retry can
-- still get the receipt out. That is correct ONLY if whoever completes the retry
-- closes the slot again. `retryPendingEmails` — one of the two named retry
-- mechanisms — cannot: `pending_emails` holds no order id, so the sweep does not
-- know which log row it just satisfied. It delivers the receipt and leaves the
-- row at 'failed' for ever, and the next caller (a redelivered webhook, an admin
-- approving the same order) claims the released slot and sends a SECOND receipt.
--
-- WHY THE ORDER LINK IS NOT A CONTRADICTION. `pending_emails` is deliberately
-- self-contained — "it has to survive the failure of everything around it". That
-- argument is about the SUBJECT and BODY, which stay self-contained: the row can
-- still be delivered with no reference to anything else. It does not require the
-- order link to be absent, and without it the only alternative is matching
-- `subject ilike '%<orderNumber>%'`, which is the fragile join C-08 is a finding
-- ABOUT.
--
-- CORRECTION TO THE PROPOSAL THIS REPLACES. The earlier draft declared
-- `order_id uuid`. `order_email_log.order_id` is **text** in production
-- (verified: information_schema.columns), and order ids look like
-- `order-23e40002-…`. A uuid column could not hold them, and the write-back join
-- would have matched nothing — the migration would have applied cleanly and
-- fixed nothing.
--
-- BLAST RADIUS. Two nullable columns and one partial index on a table with zero
-- rows. No existing row changes; no writer is required to populate them. The
-- application degrades if this has not run — see enqueueFailedEmail — so the
-- CODE IS SAFE TO DEPLOY BEFORE THIS MIGRATION, and this migration is safe to
-- apply before the code.
-- ===========================================================================

alter table public.pending_emails
  add column if not exists order_id text,
  add column if not exists email_kind text;

comment on column public.pending_emails.order_id is
  'Order this queued email belongs to, when known. TEXT, matching '
  'order_email_log.order_id. Lets the sweep close out the matching '
  'order_email_log row on success so the send-once slot is not released to a '
  'later caller. Nullable: shipping and marketing rows have no order context.';

comment on column public.pending_emails.email_kind is
  'order_email_log.kind this row corresponds to (order_confirmation, '
  'refund_confirmation). Paired with order_id for the write-back.';

-- The sweep looks these up by (order_id, email_kind); nothing else queries them.
create index if not exists pending_emails_order_idx
  on public.pending_emails (order_id, email_kind)
  where order_id is not null;
