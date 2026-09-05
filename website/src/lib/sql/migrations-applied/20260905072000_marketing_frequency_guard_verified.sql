-- ============================================================================
-- VANTA LABS — MARKETING FREQUENCY GUARD: PRODUCTION RECORD
--
-- VERIFIED PRESENT IN PRODUCTION 2026-09-05 ~09:00 UTC (read-only check via
-- the Supabase MCP): public.marketing_send_claim() exists, the
-- public.marketing_send_queue table exists, and
-- email_campaign_recipients.deferred_until exists. The guard had been applied
-- earlier without a record in this folder, which is what the launch audit's
-- EMAIL-01 finding ("no record of being deployed") was about. Nothing was
-- re-run; this file closes the record gap.
--
-- Source of truth: ../marketing-frequency-guard.sql. The local harness now
-- applies it from scripts/setup-local-harness.sh's post-parity list, so the
-- QA scripts exercise the real guard rather than its "unavailable" fallback.
-- ============================================================================

-- Intentionally empty of DDL: see ../marketing-frequency-guard.sql.
select 1;
