-- ---------------------------------------------------------------------------
-- BROWSE ABANDONMENT (design: docs/superpowers/specs/2026-09-11-recovery-to-
-- benchmark-design.md §6).
--
-- Every product viewer is a signed-in account (the wall), and the product page
-- resolves the viewer server-side, so a product view can be recorded against a
-- consented address with no third-party script and no guesswork. The record
-- feeds one automation, `browse_abandonment`: a single note, no incentive,
-- four to twenty-four hours after the view, to an address with no open cart
-- and no order since. Inserted DISABLED; the operator switches it on.
--
-- Additive only. RLS on with no policies, like every other table here: the
-- service role reads and writes, nothing else can.
-- ---------------------------------------------------------------------------

create table if not exists public.product_views (
  id uuid primary key default gen_random_uuid(),
  customer_user_id uuid,
  email text not null,
  slug text not null,
  viewed_at timestamptz not null default now(),
  -- The hour bucket the view falls in, kept as a plain column so the unique
  -- index below can name it and PostgREST upserts can target it. One row per
  -- address, product and hour: a shopper refreshing a page writes one row,
  -- not ten.
  viewed_hour timestamptz not null
);

create unique index if not exists product_views_one_per_hour
  on public.product_views (email, slug, viewed_hour);

create index if not exists product_views_email_recent
  on public.product_views (email, viewed_at desc);

create index if not exists product_views_recent
  on public.product_views (viewed_at);

alter table public.product_views enable row level security;

-- The automation row, disabled. Copy is operator-editable in Admin → Email like
-- every other automation; `{{product_name}}` is replaced with the catalogue
-- name of the product that was viewed. The delay field does not apply to this
-- key — the window is fixed in code — so it is stored as 0 to say so.
insert into public.email_automations (key, enabled, delay_days, subject, headline, body, cta_label, cta_path)
values
  ('browse_abandonment', false, 0,
   'Still looking at {{product_name}}?',
   'About {{product_name}}',
   E'You were looking at {{product_name}} a little while ago, so here is the page again in case it is useful.\n\nIf a question is holding you up, reply to this email. A person reads and answers every one.',
   'See the product page', '/products')
on conflict (key) do nothing;
