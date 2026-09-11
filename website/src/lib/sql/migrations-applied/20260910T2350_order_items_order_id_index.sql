-- ============================================================================
-- ORDER ITEMS, INDEXED BY ORDER.
--
-- Full DDL with reasoning is src/lib/sql/order-items-order-id-index.sql, which
-- remains the single source of truth. This file records what was applied and
-- when.
--
-- Applied to production (mlpimwgkwuqpsvsrlpqv) on 2026-09-10 at 23:50 UTC,
-- through the Supabase MCP `execute_sql` tool rather than the SQL editor,
-- because CREATE INDEX CONCURRENTLY cannot run inside a transaction and the
-- editor wraps its statements in one. Verified afterwards against pg_indexes:
--
--   order_items_order_id_idx  CREATE INDEX ... ON public.order_items (order_id)
--
-- alongside order_items_pkey, which until then was the table's only index.
-- ============================================================================

create index concurrently if not exists order_items_order_id_idx
  on public.order_items (order_id);
