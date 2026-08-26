#!/usr/bin/env bash
# Start a throwaway Postgres for the database-backed suites.
#
# WHY THIS EXISTS. Sixty-five tests skip without VANTA_TEST_DATABASE_URL, and a
# skipped suite that reports success is how fourteen dead proofs once passed the
# gate (ledger F-014). It is also how six real failures in the merged financial
# reporting code went unseen until Block M ran them for the first time.
#
# The container reclaims this process when it is idle. That is survivable — the
# suites ERROR rather than silently passing when the cluster is gone, which was
# verified twice during Block M — but it means the gate has to check the cluster
# is up rather than assume it.
#
#   ./scripts/start-test-postgres.sh
#   VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres npm test
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
PGDATA=${PGDATA:-/tmp/vantapg}
PGPORT=${PGPORT:-55432}
# initdb refuses to run as root, so the cluster is owned by an unprivileged user.
PGUSER_OS=${PGUSER_OS:-vantapg}

if "$PGBIN/pg_isready" -h /tmp -p "$PGPORT" >/dev/null 2>&1; then
  echo "postgres already up on $PGPORT"
  exit 0
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  id -u "$PGUSER_OS" >/dev/null 2>&1 || useradd -m "$PGUSER_OS"
  rm -rf "$PGDATA"; mkdir -p "$PGDATA"
  chown "$PGUSER_OS" "$PGDATA"; chmod 700 "$PGDATA"
  su "$PGUSER_OS" -c "$PGBIN/initdb -D $PGDATA -A trust -U postgres" >/dev/null
fi

su "$PGUSER_OS" -c "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -k /tmp' -l /tmp/pg.log start" >/dev/null
for _ in $(seq 1 20); do
  "$PGBIN/pg_isready" -h /tmp -p "$PGPORT" >/dev/null 2>&1 && { echo "postgres up on $PGPORT"; exit 0; }
  sleep 0.5
done

echo "postgres did not come up; see /tmp/pg.log" >&2
exit 1
