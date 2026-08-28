#!/bin/bash
# SessionStart hook — provisions the container so tests, linting and the
# typescript-lsp plugin actually work in Claude Code on the web.
#
# Why this exists: the cloud container is ephemeral and starts from a fresh
# clone, so website/node_modules is absent at session start. Without it
# `vitest`, `eslint` and `next build` have nothing to run, and
# typescript-language-server exits during `initialize` with "Could not find a
# valid TypeScript installation" — which makes the typescript-lsp plugin
# silently do nothing instead of reporting an error.
set -euo pipefail

# Local machines already have their own toolchain. Don't mutate them.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

echo "[session-start] installing website dependencies"
(cd website && npm install --no-audit --no-fund)

# typescript-language-server resolves TypeScript from the workspace first, so
# the install above is what normally feeds it. A global copy keeps it alive
# outside website/ as well. It has to be TypeScript 5: bare `npm i -g
# typescript` now resolves to the v7 native port, which ships tsc.js and no
# lib/tsserver.js and cannot back a language server at all.
if ! command -v typescript-language-server >/dev/null 2>&1; then
  echo "[session-start] installing typescript-language-server"
  npm install -g typescript-language-server --no-audit --no-fund
fi

global_root="$(npm root -g)"
if [ ! -f "$global_root/typescript/lib/tsserver.js" ]; then
  echo "[session-start] installing typescript@5 (need lib/tsserver.js)"
  npm install -g typescript@5 --no-audit --no-fund
fi

# context7 runs anonymously without a key, and its shared anonymous quota
# returns "Monthly quota exceeded" as an ordinary tool result rather than a
# connection error — so it fails invisibly. Say so once, up front.
if [ -z "${CONTEXT7_API_KEY:-}" ]; then
  echo "[session-start] warning: CONTEXT7_API_KEY unset — context7 is on the" \
       "shared anonymous quota and may silently return no docs."
  echo "[session-start]          version-exact fallback:" \
       "website/node_modules/next/dist/docs/"
fi

echo "[session-start] done"
