-- Adds an optional saved contact phone number to customer accounts.
-- Stored on customer_preferences (the existing per-user table), NOT on the
-- Supabase auth.users.phone column, because that native column is reserved
-- for verified phone-OTP sign-in. This is a plain support/contact number the
-- customer types in their account settings.
--
-- Safe to run more than once (IF NOT EXISTS).

alter table public.customer_preferences
  add column if not exists phone text;
