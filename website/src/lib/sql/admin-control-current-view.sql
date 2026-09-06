-- ---------------------------------------------------------------------------
-- The CURRENT value of every control setting, resolved in the database.
--
-- WHY THIS EXISTS
--
-- Control settings are stored append-only in admin_audit_logs: every save
-- INSERTs a new row, and the newest row for a (section, key) is the current
-- value. That is deliberate — it means the settings store is also its own
-- audit trail, and nothing here changes that.
--
-- The reader, however, could not express "newest row per key" in PostgREST, so
-- it approximated it: fetch the newest ~1500 rows and take the first occurrence
-- of each key. That approximation is correct only while the whole history fits
-- in the window. Past it, a setting that has not been touched recently falls
-- out of the window entirely and reads as ABSENT — which the callers translate
-- into "use the code default".
--
-- Reproduced before this view existed: with 1600 later writes in other
-- sections, the unscoped snapshot returned no `referral` section at all, so the
-- Control Center rendered a blank Ambassador Personal Discount for a value that
-- was really set to 20. Saving that blank panel would then have written blanks
-- over live configuration.
--
-- DISTINCT ON is exactly the operation the reader was approximating, and doing
-- it here makes the answer deterministic and bounded by the number of distinct
-- SETTINGS (tens) rather than by the number of historical WRITES (unbounded).
--
-- SAFETY
--
--   * Additive. Creates a view and an index; no table, column or row is
--     altered, and no configuration value changes.
--   * Idempotent. Safe to run repeatedly.
--   * Optional at deploy time. getControlSnapshot() falls back to the old
--     windowed query when this view is absent, so code and database can be
--     deployed in either order. /admin/status reports whether it is present.
-- ---------------------------------------------------------------------------

-- Supports the DISTINCT ON below: one index entry per control write, ordered so
-- Postgres can walk straight to the newest row of each key instead of sorting
-- the whole audit log. Partial, so it stays small — control writes are a tiny
-- fraction of admin_audit_logs.
create index if not exists admin_audit_logs_control_current_idx
  on public.admin_audit_logs (target_table, target_id, created_at desc)
  where action = 'admin_control_upsert';

-- SECURITY INVOKER, LIKE EVERY OTHER VIEW IN THIS SCHEMA.
--
-- A view created WITHOUT it runs as its OWNER, and the owner of a table is
-- exempt from that table's RLS — so this view read admin_audit_logs straight
-- through the deny-by-default policy protecting it. Its only protection was the
-- one-shot revoke at the bottom of this file, and a revoke does not survive a
-- DROP: `create or replace view` cannot drop or reorder columns, so any later
-- change to the column list requires DROP VIEW, and the recreate takes a fresh
-- SELECT grant from Supabase's platform default-privilege entry for anon. The
-- store-wide sweep would not put it back either, because revoke-anon-table-access
-- deliberately covers `relkind in ('r','p')` and never views.
--
-- What sat behind that: the live commercial configuration, read out of the audit
-- log — ambassador commission percentages, the free-shipping threshold and flat
-- rates, every /admin control setting — with no error and no log line.
--
-- getControlSnapshot reads this through the service role, which is BYPASSRLS,
-- so nothing in the application changes. The seven ads views have carried this
-- since they were written; this one was the only public view without it.
create or replace view public.admin_control_current
with (security_invoker = true) as
select distinct on (target_table, target_id)
  id,
  target_table,
  target_id,
  metadata,
  created_at
from public.admin_audit_logs
where action = 'admin_control_upsert'
  and target_table is not null
  and target_id is not null
order by target_table, target_id, created_at desc;

-- The view is read only by the server (service role). It is deliberately NOT
-- granted to anon/authenticated: control settings include commercial
-- configuration that no browser should be able to enumerate.
revoke all on public.admin_control_current from anon, authenticated;
