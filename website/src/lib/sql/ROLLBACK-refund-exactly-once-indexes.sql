-- Rollback for refund-exactly-once-indexes.sql.
--
-- WARNING. Dropping these returns refund exactly-once to a read-then-insert
-- check in application code, which the webhook and the half-hourly refund
-- sweep can both pass at the same time — the double-credit race REF-03
-- describes. Only drop them to unblock an incident.
drop index if exists public.idx_points_ledger_order_refund_once;
drop index if exists public.idx_store_credit_ledger_order_refund_once;
