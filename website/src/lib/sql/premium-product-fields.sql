-- ============================================================================
-- VANTA LABS — PREMIUM PRODUCT SPEC FIELDS
-- Adds the scientific spec fields a premium research-product page shows:
-- molecular weight, CAS number, peptide sequence, storage/handling,
-- reconstitution note, and a per-product FAQ (jsonb array of {question,answer}).
-- Idempotent + safe on a fresh OR existing database + safe to re-run.
-- Paste into Supabase -> SQL Editor -> Run.
-- ============================================================================

alter table if exists public.products
  add column if not exists molecular_weight text,
  add column if not exists cas_number text,
  add column if not exists peptide_sequence text,
  add column if not exists storage_recommendation text,
  add column if not exists reconstitution_note text,
  add column if not exists product_faq jsonb not null default '[]'::jsonb;
