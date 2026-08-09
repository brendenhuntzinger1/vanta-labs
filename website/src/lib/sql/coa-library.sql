-- ---------------------------------------------------------------------------
-- COA LIBRARY — batch-level Certificates of Analysis
--
-- WHY A TABLE: until now a COA was a single free-text `products.coa_url`, so a
-- product could advertise exactly one document forever. Real testing does not
-- work that way — one product accumulates a COA per production batch:
--
--   BPC-157 10mg
--     ├── Batch 0826A   (HPLC 99.2%, tested 2026-08-04)
--     ├── Batch 0926A
--     └── Batch 1026B
--
-- `coa_records` is that relationship. `products.coa_url` and
-- `product_doses.coa_url` are LEFT IN PLACE and still power the product page —
-- nothing that reads them changes. This migration only adds the batch history
-- alongside them, and backfills the links that already exist so no documentation
-- is lost.
--
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

create table if not exists public.coa_records (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  -- Optional link to the specific dosage variant this batch was tested for.
  -- Nulled rather than deleted if the variant goes away: the COA is still a
  -- true historical record of what was tested.
  product_dose_id uuid references public.product_doses(id) on delete set null,
  strength text,
  batch_number text not null,
  lot_number text,
  lab_name text,
  test_date date,
  purity text,
  identity_result text,
  -- Exactly one of these carries the document:
  --   file_path    -> object key inside the private `coa-documents` bucket
  --   external_url -> a document hosted somewhere else (legacy coa_url values)
  file_path text,
  external_url text,
  file_name text,
  file_type text,
  file_size_bytes bigint,
  status text not null default 'draft',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Columns added after the first release land here so an existing install picks
-- them up without recreating the table.
alter table public.coa_records add column if not exists product_dose_id uuid references public.product_doses(id) on delete set null;
alter table public.coa_records add column if not exists strength text;
alter table public.coa_records add column if not exists lot_number text;
alter table public.coa_records add column if not exists identity_result text;
alter table public.coa_records add column if not exists external_url text;
alter table public.coa_records add column if not exists file_name text;
alter table public.coa_records add column if not exists file_size_bytes bigint;
alter table public.coa_records add column if not exists position integer not null default 0;

-- Only three states exist. `draft` is the default so an upload is never live
-- before the operator has looked at it; `archived` retires a superseded batch
-- without destroying the record.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'coa_records_status_check'
  ) then
    alter table public.coa_records
      add constraint coa_records_status_check
      check (status in ('draft', 'published', 'archived'));
  end if;
end $$;

create index if not exists coa_records_product_id_idx on public.coa_records (product_id);
create index if not exists coa_records_status_idx on public.coa_records (status);
create index if not exists coa_records_batch_idx on public.coa_records (lower(batch_number));
create index if not exists coa_records_test_date_idx on public.coa_records (test_date desc nulls last);

-- Keep updated_at honest without every caller having to remember it.
create or replace function public.coa_records_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists coa_records_set_updated_at on public.coa_records;
create trigger coa_records_set_updated_at
  before update on public.coa_records
  for each row
  execute function public.coa_records_touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — deny by default.
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships to the browser, so a public table with no
-- RLS is world-readable AND world-writable. The application only ever touches
-- this table through server routes using the service-role key, and service_role
-- carries BYPASSRLS — enabling RLS with no policy locks out anon/authenticated
-- and changes nothing for the app. Draft COAs in particular must never be
-- readable straight off PostgREST.
-- ---------------------------------------------------------------------------
alter table public.coa_records enable row level security;

-- ---------------------------------------------------------------------------
-- STORAGE — private `coa-documents` bucket.
--
-- PRIVATE, not public. A public bucket hands out every object to anyone who can
-- guess or share a URL, including drafts and unpublished batches. Customers get
-- short-lived signed URLs minted server-side, and only for records whose status
-- is `published` on a product that is itself live (see src/lib/coa.ts).
--
-- storage.objects ships with RLS on and no anon policy, so no policy is added
-- here: reads and writes are service-role only, which is exactly the rule the
-- admin routes enforce.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'coa-documents',
  'coa-documents',
  false,
  20971520, -- 20 MB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- BACKFILL — carry existing documentation forward.
--
-- Any product already pointing at a real http(s) COA becomes a published record
-- so the redesigned library opens with the documentation the store already has,
-- rather than an empty grid. Guarded on `not exists` so re-running adds nothing.
-- Products whose coa_url is blank, "pending", "N/A" or similar are skipped —
-- those were placeholders, never documents.
-- ---------------------------------------------------------------------------
insert into public.coa_records (
  product_id, batch_number, lab_name, test_date, purity, external_url, file_type, status
)
select
  p.id,
  coalesce(nullif(btrim(p.batch_number::text), ''), 'Batch on file'),
  nullif(btrim(p.lab_name::text), ''),
  case
    when nullif(btrim(p.testing_date::text), '') ~ '^\d{4}-\d{2}-\d{2}'
      then substring(btrim(p.testing_date::text) from 1 for 10)::date
    else null
  end,
  nullif(btrim(p.purity_result::text), ''),
  btrim(p.coa_url),
  'link',
  'published'
from public.products p
where btrim(coalesce(p.coa_url, '')) ~* '^https?://'
  and not exists (
    select 1 from public.coa_records c
    where c.product_id = p.id
      and c.external_url = btrim(p.coa_url)
  );

-- Same for per-dose COA links, which are the more specific record when present.
insert into public.coa_records (
  product_id, product_dose_id, strength, batch_number, purity, external_url, file_type, status
)
select
  d.product_id,
  d.id,
  nullif(btrim(d.label::text), ''),
  coalesce(nullif(btrim(d.batch_number::text), ''), 'Batch on file'),
  nullif(btrim(d.purity_result::text), ''),
  btrim(d.coa_url),
  'link',
  'published'
from public.product_doses d
where btrim(coalesce(d.coa_url, '')) ~* '^https?://'
  and not exists (
    select 1 from public.coa_records c
    where c.product_id = d.product_id
      and c.external_url = btrim(d.coa_url)
  );

-- Verification (run manually; expect the counts you uploaded):
--   select status, count(*) from public.coa_records group by status;
--   select p.name, c.batch_number, c.status
--   from public.coa_records c join public.products p on p.id = c.product_id
--   order by p.name, c.test_date desc nulls last;
