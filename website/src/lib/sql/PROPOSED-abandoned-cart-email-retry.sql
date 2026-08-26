-- PROPOSAL — NOT APPLIED. Owner approval required (audit Rule 4).
--
-- OPTIONAL FOLLOW-UP to the C-06 fix. The fix itself needs NO schema change and
-- is already applied in code; this only buys back the retry that the fix
-- deliberately gave up.
--
-- WHAT THE FIX TRADED AWAY. reserveAndSendStage now keeps its (cart, stage)
-- claim when a send fails, because deleting it is what re-armed the stage and
-- minted a fresh coupon every 30 minutes. The cost is that a stage whose send
-- fails transiently is never retried: that shopper does not get that one
-- recovery email. For a marketing email that is the right trade — but it is a
-- trade, not a free win.
--
-- WHAT THIS WOULD BUY. A bounded retry. The claim still stands (so the coupon
-- can never be re-minted — the mint is behind the claim), but the SEND may be
-- re-attempted a fixed number of times with backoff. Unbounded re-arming is what
-- caused the incident; bounded retry against a held claim cannot reproduce it.
--
-- EXACTLY WHAT IT CHANGES:
--   * adds 3 nullable/defaulted columns to public.abandoned_cart_emails
--   * adds 1 partial index
--   * changes NO existing column, constraint, index, row or trigger
--   * every existing row gets delivery_state 'sent' (see the backfill note)
--   * the unique index idx_abandoned_cart_emails_cart_stage is untouched, so the
--     one-coupon-per-cart-per-stage guarantee is unaffected either way
--
-- WITHOUT THIS MIGRATION the current fix is complete and correct. Do not apply
-- it to buy correctness; apply it only to buy deliverability.

alter table public.abandoned_cart_emails
  add column if not exists delivery_state text not null default 'sent',
  add column if not exists send_attempts integer not null default 1,
  add column if not exists last_error text;

comment on column public.abandoned_cart_emails.delivery_state is
  'sent | failed | suppressed. Existing rows default to sent, which is correct: '
  'before this column existed a surviving row could only mean a delivered send, '
  'since a failed send deleted its own row (that deletion is finding C-06).';

comment on column public.abandoned_cart_emails.send_attempts is
  'How many times the send has been attempted for this claim. The CLAIM is never '
  'released, so this bounds re-sends only - it can never cause a re-mint.';

-- Only rows a sweep might retry; keeps the scan flat as claims accumulate.
create index if not exists abandoned_cart_emails_retryable_idx
  on public.abandoned_cart_emails (delivery_state, send_attempts)
  where delivery_state = 'failed';

-- NOTE ON THE BACKFILL. `default 'sent'` is applied to all 27 existing rows.
-- That is accurate for exactly the reason above, and it is also the safe
-- direction: a row wrongly marked 'sent' is never retried, so the worst case is
-- one missed marketing email, not a duplicate send.
