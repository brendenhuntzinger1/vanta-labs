-- ===========================================================================
-- EXACTLY-ONCE FOR AUTOMATION EMAIL, ENFORCED BY THE DATABASE.
--
-- runAutomations() loaded every already-sent reference_id (loadAlreadySent),
-- chose the targets that were not in that set, then sent and logged. That is a
-- read-then-write with nothing behind it: two overlapping sweeps both read "not
-- sent" for the same reference and both send. Nothing stopped it — it had
-- simply not happened yet.
--
-- Order email has had this since C-02: order_email_log_one_live, a partial
-- UNIQUE on (order_id, kind) WHERE status IN ('sending','sent'). Automations
-- deduped against an unconstrained log. This is the same shape for the same
-- reason, and it is what lets claimAutomationSend() treat a unique violation as
-- "somebody else already has this one" rather than as an error.
--
-- 'failed' IS EXCLUDED ON PURPOSE. A provider hiccup must leave the recipient
-- eligible, or one bad minute drops them from the sequence permanently — the
-- same rule loadAlreadySent already applied with `.neq("status", "failed")`.
--
-- Safe to create: verified against the live project on 2026-08-30 that no
-- duplicate (campaign_type, reference_id) rows exist for campaign_type like
-- 'automation:%', so the index cannot fail on existing data. Applied there the
-- same day as migration `automation_send_once_unique`.
-- ===========================================================================

create unique index if not exists email_send_log_automation_once
  on public.email_send_log (campaign_type, reference_id)
  where campaign_type like 'automation:%'
    and reference_id is not null
    and status <> 'failed';
