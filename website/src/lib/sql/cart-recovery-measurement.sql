-- ---------------------------------------------------------------------------
-- MEASURING WHETHER CART RECOVERY ACTUALLY RECOVERS ANYTHING.
--
-- Two columns, both nullable, both additive. Nothing already running reads or
-- writes either, so this migration cannot change the behaviour of any existing
-- code path — it only makes two questions answerable that were not.
--
-- WHY THEY ARE NEEDED
--
-- The programme reported sent / opened / clicked / recovered. Every one of
-- those four was doing work it could not do:
--
--   * OPENED is contaminated. Heath Greve's stage-2 open is stamped seven
--     seconds after the send; Nikki R's stages 1 and 2 are stamped at the same
--     millisecond. Those are Gmail and Apple image prefetches, not reads.
--   * RECOVERED counts any paid order from that address inside the window,
--     click or no click. On 2026-09-06 it counted Neil Hidalgo, who received
--     zero emails and came back on his own.
--   * Between CLICKED and RECOVERED there was nothing at all — no way to see
--     whether a click even produced a working cart.
--
-- `restored_at` closes that gap: it is stamped when the restore endpoint
-- actually hands a cart back, which is the first moment the shopper is
-- provably back in a buyable basket. Click -> restore -> order is then a real
-- funnel with a middle.
--
-- `variant` is what makes the subject-line test measurable. Without a record
-- of which variant a send used, the experiment exists only in the code that
-- chose it and cannot be joined to an outcome.
-- ---------------------------------------------------------------------------

alter table if exists public.abandoned_carts
  add column if not exists restored_at timestamptz;

comment on column public.abandoned_carts.restored_at is
  'First time /api/cart/restore handed this cart back to a shopper. First touch '
  'only, so it means "when did the recovery link first work", not "how often". '
  'Null for a cart nobody ever restored.';

alter table if exists public.abandoned_cart_emails
  add column if not exists variant text;

comment on column public.abandoned_cart_emails.variant is
  'Which A/B variant this send used, e.g. "a" or "b". Assigned deterministically '
  'from the cart id so a cart keeps one variant across its whole sequence. Null '
  'for sends made before the experiment, and for stages with no experiment.';

-- The funnel reads carts by restore state over a window; without this the
-- dashboard scans the whole table to answer it.
create index if not exists abandoned_carts_restored_at_idx
  on public.abandoned_carts (restored_at)
  where restored_at is not null;
