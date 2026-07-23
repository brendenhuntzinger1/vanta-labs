#!/usr/bin/env bash
# Stand up a REAL local Postgres (no Docker required — uses the postgresql-16
# server binaries), load the production schema, and run the database-level
# concurrency + integrity stress tests. Proves the data-layer guarantees the
# business depends on. Ephemeral: the cluster lives in a temp dir.
#
# Requires: postgresql-16 (initdb/pg_ctl/psql) and Node with the `pg` package.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-/tmp/vl-pgdata}"
PORT="${PGPORT:-55432}"
PGUSER_OS="$(id -u postgres >/dev/null 2>&1 && echo postgres || echo "$(whoami)")"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export PGH="-h 127.0.0.1 -p ${PORT} -U postgres -d postgres"

echo "==> init + start Postgres on :${PORT}"
rm -rf "$PGDATA"; mkdir -p "$PGDATA"; chown -R "$PGUSER_OS" "$PGDATA" 2>/dev/null || true
sudo -u "$PGUSER_OS" "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/tmp/vl-initdb.log 2>&1
sudo -u "$PGUSER_OS" "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p ${PORT}" -l /tmp/vl-pg.log start
sleep 3

echo "==> bootstrap Supabase-like env (roles, auth schema)"
psql $PGH -q <<'SQL'
create extension if not exists pgcrypto;
do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role', true), 'anon') $$;
SQL

echo "==> load production schema (deploy-run-once.sql)"
psql $PGH -v ON_ERROR_STOP=1 -f "$HERE/src/lib/sql/deploy-run-once.sql" >/tmp/vl-schema.log 2>&1
echo "    schema loaded, 0 errors"

echo "==> run DB integrity + concurrency stress tests"
( cd "$HERE" && node scripts/db-integrity-stress.mjs )

echo "==> stopping Postgres"
sudo -u "$PGUSER_OS" "$PGBIN/pg_ctl" -D "$PGDATA" stop >/dev/null 2>&1 || true
