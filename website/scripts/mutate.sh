#!/usr/bin/env bash
# Negative-control runner. Applies one mutation to a source file, runs a test
# selection, reports the result, then restores the file byte-for-byte.
#
#   scripts/mutate.sh <file> <python-mutation-file> <vitest-args...>
#
# Restores from a COPY, never `git checkout` — a fix under test is usually still
# uncommitted, and reverting to HEAD would silently delete it and then report
# that the tests "caught" a mutation of code that no longer existed.
#
# The mutation file is python executed with `s` bound to the file's contents; it
# must assign the mutated text back to `s` and assert its target exists, so a
# mutation that fails to apply is a hard error rather than a fake pass.
set -uo pipefail

FILE="$1"; shift
MUT="$1"; shift

BACKUP="$(mktemp)"
cp -p "$FILE" "$BACKUP"
cleanup() { cp -p "$BACKUP" "$FILE"; rm -f "$BACKUP"; }
trap cleanup EXIT

python3 -c '
import pathlib, sys
p = pathlib.Path(sys.argv[1])
s = p.read_text()
g = {"s": s}
exec(open(sys.argv[2]).read(), g)
p.write_text(g["s"])
' "$FILE" "$MUT" || { echo "MUTATION FAILED TO APPLY"; exit 2; }

npx vitest run "$@" 2>&1 | tail -n 40
