#!/usr/bin/env bash
# Stand up the Block G/H browser-testing harness: a real local Postgres carrying
# a schema verified column-for-column against production (mlpimwgkwuqpsvsrlpqv),
# fronted by pgrst-shim.mjs so supabase-js can talk to it.
#
# See docs/BROWSER-TESTING-RUNBOOK.md for why this exists.
# Idempotent: safe to re-run. Does NOT touch production.
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/tmp/vantapg}"
PORT="${PGPORT:-55432}"
DB="${PGDATABASE:-storefront}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PSQL="psql -h /tmp -p ${PORT} -U postgres -d ${DB}"

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  echo "==> initdb ${PGDATA}"
  mkdir -p "$PGDATA"; chown postgres:postgres "$PGDATA"
  su postgres -c "${PGBIN}/initdb -D ${PGDATA} -A trust -U postgres" >/tmp/vl-initdb.log 2>&1
fi
if ! pg_isready -h /tmp -p "${PORT}" >/dev/null 2>&1; then
  echo "==> start Postgres on :${PORT}"
  su postgres -c "${PGBIN}/pg_ctl -D ${PGDATA} -o '-p ${PORT} -k /tmp' -l ${PGDATA}/log start" >/dev/null
  sleep 2
fi
su postgres -c "createdb -h /tmp -p ${PORT} -U postgres ${DB}" 2>/dev/null || true

echo "==> Supabase-like bootstrap (roles, auth stubs; NO RLS -- see runbook)"
$PSQL -q <<'SQL'
create extension if not exists pgcrypto;
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique);
-- The columns GoTrue exposes and the application reads back. scripts/gotrue-shim.mjs
-- is backed by THIS table, so a user it creates is the same row the app's
-- foreign keys point at. Harness-only: passwords are clear text here, which is
-- why that shim documents itself as not a security boundary.
alter table auth.users add column if not exists encrypted_password text;
-- Confirmation state is REAL here, not assumed. gotrue-shim.mjs reports it
-- verbatim so the unconfirmed paths (resend confirmation, the locked-out
-- ambassador sweep) can actually be exercised.
alter table auth.users add column if not exists email_confirmed_at timestamptz;
alter table auth.users add column if not exists raw_user_meta_data jsonb default '{}'::jsonb;
alter table auth.users add column if not exists raw_app_meta_data jsonb default '{}'::jsonb;
alter table auth.users add column if not exists phone text;
alter table auth.users add column if not exists created_at timestamptz default now();
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role', true), 'anon') $$;
grant usage on schema auth to anon, authenticated;
SQL

echo "==> base schema"
$PSQL -q -f "$HERE/src/lib/sql/deploy-run-once.sql" >/tmp/vl-schema.log 2>&1 || true

# Order matters. A file that SUPERSEDES an earlier definition must come after
# the file it supersedes, and nothing applied later may redefine it — see
# harness-prod-parity-functions.sql, which used to re-create admin_ops_summary
# with its pre-fix body after the corrected one had already been applied.
echo "==> feature schema files"
for f in inventory-reservations inventory-ledger order-email-log v1.1-features \
         fulfillment-batches self-fulfillment-shippo membership-tiers-seed express-checkout \
         referral-code-management marketing-subscribers order-profit-shipping-reconciliation \
         email-campaigns coa-library ads-purchase-idempotency product-cost-tracking \
         checkout-hardening canonical-availability referral-code-rpc partner-portal-schema \
         affiliate-program-schema orders-schema growth-features replacement-orders \
         shipping-protection-persistence dynamic-sales-tax product-shipping-weights \
         product-cost-profit coupon-private-flag membership-billing launch-audit-indexes \
         add-order-items-order-id-index BASELINE-live-functions-2026-08-25 \
         admin-control-current-view \
         inventory-enforce-positive-stock inventory-return-path \
         add-inventory-restock-claim add-inventory-committed-latch; do
  [ -f "$HERE/src/lib/sql/$f.sql" ] && $PSQL -q -f "$HERE/src/lib/sql/$f.sql" >>/tmp/vl-schema.log 2>&1 || true
done

echo "==> production parity (columns, constraints, functions)"
$PSQL -q <<'SQL'
create table if not exists public.ambassador_wallet_ledger (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, amount_cents integer not null,
  reason text not null, order_id text, note text, created_by text,
  created_at timestamptz not null default now());
SQL
$PSQL -q -f "$HERE/src/lib/sql/harness-prod-parity-columns.sql"     >>/tmp/vl-schema.log 2>&1 || true
$PSQL -q -f "$HERE/src/lib/sql/harness-prod-parity-constraints.sql" >>/tmp/vl-schema.log 2>&1 || true
$PSQL -q -f "$HERE/src/lib/sql/harness-prod-parity-functions.sql"   >>/tmp/vl-schema.log 2>&1 || true

# FOREIGN KEYS, LAST, because they validate the rows already in the tables.
#
# `create table if not exists` discards the whole statement when the table is
# already there -- including its `references` clauses -- so a harness built in
# stages ends up with production's columns and almost none of its foreign keys.
# Counted 2026-08-28: production 35, harness 17. Missing were order_items ->
# orders, customer_memberships -> membership_tiers and product_doses ->
# products, which is why every embedded select was untestable and why an
# order_items column that never existed stayed invisible for so long.
$PSQL -q -f "$HERE/src/lib/sql/harness-prod-parity-foreign-keys.sql" >>/tmp/vl-schema.log 2>&1 || true

# POST-PARITY. Two independent reasons a file must land after the parity step,
# both of which produce a harness that silently tests the wrong system.
#
# 1. Parity re-creates the very production drift the migration exists to
#    correct. harness-prod-parity-constraints.sql adds `pc_ro_ps`, the narrow
#    three-value CHECK on referral_orders.payment_status, so a harness built
#    without the commission-lifecycle pair refuses every commission accrual AND
#    every refund of an order whose commission was paid — the same 23514 the
#    deployment steps fix in production. Both files drop by RULE, so they remove
#    pc_ro_ps as well as the by-name constraint.
#
# 2. The migration READS columns the parity step adds. The revenue rollups need
#    orders.refund_amount, so applying them with the feature files fails on a
#    fresh database. They also own admin_ops_summary, which
#    harness-prod-parity-functions.sql used to re-create with its pre-fix gross
#    body — applying them here is what makes the corrected definition win.
echo "==> post-parity migrations"
for f in referral-orders-commission-lifecycle referral-orders-manual-review-status \
         refund-exactly-once-indexes; do
  [ -f "$HERE/src/lib/sql/$f.sql" ] && $PSQL -q -f "$HERE/src/lib/sql/$f.sql" >>/tmp/vl-schema.log 2>&1 || true
done

echo "==> revenue rollups (net revenue definition — must apply AFTER parity columns)"
$PSQL -q -f "$HERE/src/lib/sql/admin-dashboard-rollups.sql"         >>/tmp/vl-schema.log 2>&1 || true
$PSQL -q -f "$HERE/src/lib/sql/admin-partner-rollups.sql"           >>/tmp/vl-schema.log 2>&1 || true

# Seed. Runbook section 3 described the required shapes but nothing applied them,
# so a fresh harness came up with an empty catalogue and every checkout case was
# unreachable. harness-seed.sql is synthetic and re-runnable (it truncates first).
echo "==> seed (synthetic shapes, never production data)"
$PSQL -q -f "$HERE/src/lib/sql/harness-seed.sql" >>/tmp/vl-schema.log 2>&1 || true

# ---------------------------------------------------------------------------
# PARITY SELF-CHECK.
#
# Every apply above ends in `|| true`, so a file that failed — or one that was
# never listed at all — left the harness quietly wrong. That is how the harness
# came to run the PRE-FIX bodies of adjust_inventory_on_sale and
# reserve_inventory and to lack orders.inventory_restocked_at entirely: every
# cancel/refund took the claim-failed branch and restocked nothing, so a
# browser test of "cancel a paid order, confirm stock returns" could only pass
# by asserting the bug.
#
# These assertions are behavioural, not a file list: they check the shape the
# app actually depends on, so adding a superseding migration without listing it
# above fails here instead of silently degrading every verification run.
# ---------------------------------------------------------------------------
echo "==> parity self-check"
parity_failures=0
check() { # name, sql returning boolean
  if [ "$($PSQL -tAc "$2" 2>/dev/null | tr -d '[:space:]')" = "t" ]; then
    echo "    ok   $1"
  else
    echo "    FAIL $1"
    parity_failures=$((parity_failures + 1))
  fi
}

check "orders.inventory_restocked_at exists (cancel/refund restock claim)" \
  "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='inventory_restocked_at');"
check "orders.inventory_committed_at exists (the restock SIGNAL)" \
  "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='inventory_committed_at');"
# The four columns scripts/harness-pay-order.mjs SELECTs. They are created by
# deploy-run-once.sql's `create table ... if not exists`, which is a no-op once
# the table exists in any shape — so a damaged orders table loses them
# permanently unless harness-prod-parity-columns.sql re-adds them. It now does;
# these assert it, because the previous check set covered only columns that file
# already owned and so reported green on a database the payment harness could
# not read.
check "orders.payment_id exists (harness-pay-order.mjs SELECTs it)" \
  "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='payment_id');"
check "orders.provider_event_id exists (webhook idempotency key)" \
  "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='provider_event_id');"
check "orders.referral_code exists (affiliate attribution)" \
  "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='referral_code');"
check "orders.ambassador_id exists (affiliate attribution)" \
  "select exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='ambassador_id');"
check "adjust_inventory_on_sale maintains stock_status (inventory-return-path.sql)" \
  "select coalesce(bool_or(prosrc like '%stock_status%'), false) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='adjust_inventory_on_sale';"
check "reserve_inventory enforces untracked-but-stocked (inventory-enforce-positive-stock.sql)" \
  "select coalesce(bool_or(prosrc like '%inventory_quantity > 0%'), false) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='reserve_inventory';"
check "admin_ops_summary sums NET revenue, not gross amount_paid (admin-dashboard-rollups.sql)" \
  "select coalesce(bool_or(prosrc like '%refund_amount%'), false) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='admin_ops_summary';"

if [ "$parity_failures" -ne 0 ]; then
  echo ""
  echo "!!  $parity_failures parity check(s) failed. The harness does NOT match production."
  echo "!!  Verifying customer-facing behaviour against it would test the wrong system."
  echo "!!  See /tmp/vl-schema.log for the apply errors."
  exit 1
fi

echo "==> tables: $($PSQL -tAc "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';") (production: 68)"
echo "==> products seeded: $($PSQL -tAc "select count(*) from products;")"
echo "==> done. Start the shim:  node scripts/pgrst-shim.mjs --port 54321 --db postgres://postgres@localhost:${PORT}/${DB}"
echo "    NOTE: getCatalogProducts is wrapped in unstable_cache, which caches FAILURES too."
echo "    After any schema fix, restart the app server or the catalogue will keep 400ing."
