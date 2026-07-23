-- ============================================================================
-- VANTA LABS — WEBHOOK EVENT CRASH RECOVERY
-- Makes payment_events claims reclaimable so a hard crash (OOM / pod eviction /
-- timeout) between claiming an event and finishing it can't strand the order
-- forever. processed_at becomes the COMPLETION marker (NULL = claimed but not
-- yet done); claimed_at records when the claim was taken so a stale, still-
-- unprocessed claim can be safely retaken. Idempotent + safe to re-run.
-- ============================================================================

alter table if exists public.payment_events
  add column if not exists claimed_at timestamptz not null default now();

-- processed_at now means "finished"; allow NULL for an in-flight/stranded claim.
alter table if exists public.payment_events
  alter column processed_at drop not null;
