-- Admin console second factor: a 6-digit passcode required in addition to the
-- username + password before an admin session is issued.
--
-- Passcodes are stored as scrypt salt+hash (same scheme as password_hash), so a
-- database leak never exposes the passcode itself. When no per-account passcode
-- is set, admin-auth.ts falls back to the ADMIN_ACCESS_CODE environment variable
-- so an existing deployment is never locked out; set a per-account passcode from
-- the admin Team page (or leave ADMIN_ACCESS_CODE configured) to enforce it.
--
-- Idempotent: safe to run multiple times.

alter table if exists public.admin_credentials
  add column if not exists passcode_salt text,
  add column if not exists passcode_hash text,
  add column if not exists passcode_updated_at timestamptz;
