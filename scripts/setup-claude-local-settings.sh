#!/usr/bin/env bash
# Writes the per-developer Claude Code permission allowlist.
#
# .claude/settings.local.json is gitignored, so it does not survive a fresh
# clone (every Claude Code cloud session starts from one). Call this from the
# `vanta` cloud environment's setup script to recreate it at session start:
#
#     bash scripts/setup-claude-local-settings.sh
#
# Idempotent: merges the entries below into any existing allow list rather
# than clobbering a file you have already customised.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_root/.claude/settings.local.json"

# Tools to auto-approve. Keep this list narrow and intentional.
read -r -d '' GRANTS <<'JSON' || true
[
  "mcp__Supabase__execute_sql",
  "mcp__Supabase__apply_migration"
]
JSON

mkdir -p "$repo_root/.claude"

python3 - "$target" "$GRANTS" <<'PY'
import json, os, sys

target, grants = sys.argv[1], json.loads(sys.argv[2])

settings = {}
if os.path.exists(target):
    try:
        with open(target) as fh:
            settings = json.load(fh)
    except (json.JSONDecodeError, OSError):
        # A corrupt local file should not fail the whole session setup.
        settings = {}

allow = settings.setdefault("permissions", {}).setdefault("allow", [])
added = [g for g in grants if g not in allow]
allow.extend(added)

with open(target, "w") as fh:
    json.dump(settings, fh, indent=2)
    fh.write("\n")

print(f"claude settings: {len(added)} permission(s) added, {len(allow)} total")
PY
