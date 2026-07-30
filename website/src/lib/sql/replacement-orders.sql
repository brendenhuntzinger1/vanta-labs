-- Replacement orders (run once in the Supabase SQL editor).
--
-- A replacement is a $0 order the admin sends when a shipment arrives
-- damaged / is lost or stolen (the store-backed Shipping Protection
-- promise). These two columns link a replacement to the order it replaces
-- and record why it was sent, completing the claim audit trail:
--
--   replacement_of     — order_id of the original order (null = normal order)
--   replacement_reason — damaged / lost / stolen / other, plus admin note
--
-- The app stores these best-effort: until this migration runs, replacements
-- still work (created without the linkage detail; the audit log keeps the
-- full record either way). Safe to run more than once.

alter table public.orders
  add column if not exists replacement_of text,
  add column if not exists replacement_reason text;
