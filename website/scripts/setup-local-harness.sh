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
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role', true), 'anon') $$;
grant usage on schema auth to anon, authenticated;
SQL

echo "==> base schema"
$PSQL -q -f "$HERE/src/lib/sql/deploy-run-once.sql" >/tmp/vl-schema.log 2>&1 || true

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
         admin-control-current-view; do
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

# Seed. Runbook section 3 described the required shapes but nothing applied them,
# so a fresh harness came up with an empty catalogue and every checkout case was
# unreachable. harness-seed.sql is synthetic and re-runnable (it truncates first).
echo "==> seed (synthetic shapes, never production data)"
$PSQL -q -f "$HERE/src/lib/sql/harness-seed.sql" >>/tmp/vl-schema.log 2>&1 || true

echo "==> tables: $($PSQL -tAc "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE';") (production: 68)"
echo "==> products seeded: $($PSQL -tAc "select count(*) from products;")"
echo "==> done. Start the shim:  node scripts/pgrst-shim.mjs --port 54321 --db postgres://postgres@localhost:${PORT}/${DB}"
echo "    NOTE: getCatalogProducts is wrapped in unstable_cache, which caches FAILURES too."
echo "    After any schema fix, restart the app server or the catalogue will keep 400ing."
