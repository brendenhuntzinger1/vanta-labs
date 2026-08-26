-- Exact rollback for pending-emails-order-link.sql.
--
-- Dropping these columns loses the order link on any queued-but-undelivered
-- email, which means the sweep stops closing send-once slots and the C-02
-- duplicate returns. It cannot corrupt anything: the columns are nullable and
-- nothing else reads them.
--
-- Check what would be lost first:
--   select count(*) from public.pending_emails
--   where status = 'pending' and order_id is not null;

drop index if exists public.pending_emails_order_idx;

alter table public.pending_emails
  drop column if exists order_id,
  drop column if exists email_kind;
