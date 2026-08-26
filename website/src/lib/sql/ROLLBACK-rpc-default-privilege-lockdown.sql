-- Exact rollback for rpc-default-privilege-lockdown.sql.
--
-- This RE-ARMS the mechanism that made create_partner_invite reachable by anyone
-- holding the public anon key (I-07). There is no good reason to run it. It
-- exists because a migration without a rollback is not a migration.
--
-- The DO block in the forward file cannot be rolled back and must not be: it
-- only ever revoked access that was already meant to be closed. Re-granting anon
-- EXECUTE on a specific function is a deliberate act and belongs in its own
-- migration, naming the function and saying why.

alter default privileges in schema public
  grant execute on functions to anon, authenticated;
