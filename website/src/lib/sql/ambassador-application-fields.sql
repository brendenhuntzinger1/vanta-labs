-- Extra fields captured on the ambassador application form so an admin can
-- review audience quality before approving. Mirrored on both the `partners`
-- and `ambassadors` tables (the code keeps the two in sync).
--
-- Safe to run more than once.

alter table public.partners
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists phone text,
  add column if not exists social text,
  add column if not exists follower_count integer,
  add column if not exists preferred_referral_code text;

alter table public.ambassadors
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists phone text,
  add column if not exists social text,
  add column if not exists follower_count integer,
  add column if not exists preferred_referral_code text;
