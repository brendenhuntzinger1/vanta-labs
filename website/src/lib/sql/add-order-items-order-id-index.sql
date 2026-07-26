-- Index order_items.order_id (audit cycle 2, H3).
--
-- order_id is a foreign key AND the primary lookup/join column — order detail,
-- packing slips, reorder, best-sellers (.in("order_id", …)), and the webhook's
-- delete-by-order all filter on it. Postgres does NOT auto-index FK columns, so
-- each of those was a sequential scan, and every order deletion seq-scans
-- order_items to cascade. This makes those O(log n) instead of O(n).
--
-- Safe/additive: creating an index changes no data and no application behavior.
-- Run once in Supabase → SQL Editor.

create index if not exists idx_order_items_order_id
  on public.order_items (order_id);
