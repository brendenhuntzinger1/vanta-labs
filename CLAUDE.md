# Vanta Labs — working agreements for Claude

## Browser verification (Playwright MCP)

A Playwright MCP server is configured in `.mcp.json` and approved for this
project in `.claude/settings.json`. Use it — do not reason about browser
behaviour from source alone.

**Use the browser whenever a change touches customer-facing behaviour:**
navigation, mobile responsiveness, the age gate, authentication, product
pages, cart, affiliate/referral flows, discounts and coupons, checkout UI,
error states, or in-app-browser behaviour.

**Default target is the local harness, NOT `npm run dev`.** Follow
`website/docs/BROWSER-TESTING-RUNBOOK.md` — it is authoritative for browser work
and takes precedence over this section wherever the two differ.

    bash website/scripts/setup-local-harness.sh   # local Postgres + real schema
    node website/scripts/pgrst-shim.mjs --port 54321 --db postgres://postgres@localhost:55432/storefront
    cd website && npm run harness:build && npm run harness:start

Then drive `http://127.0.0.1:3000`. Escalate only as far as the work needs:

    local harness → automated tests → build → Vercel preview → (production only on request)

**Do not use `npm run dev` for browser verification.** The HMR socket is blocked
here, so Next retries continuously and Fast Refresh resets React state
mid-test. That fabricates convincing bugs — it made a working age gate look
like an un-passable P0. The runbook explains this in full.

**Production rules — no exceptions without explicit per-test authorisation:**

- Production browser access is READ-ONLY, and only when the user asks for it.
- NEVER on production: test orders, payment attempts, account creation,
  coupon redemption, affiliate payouts, database mutation, or any other
  state-changing QA.
- Production is never the default automated target.

Check mobile at 390x844 for any layout change — most traffic is mobile.

Note: the MCP server blocks `file://` URLs. Serve pages over HTTP instead.

## Bugs: reproduce before fixing

1. Reproduce the failure in the browser first, whenever practical.
2. Write a regression test that fails for the right reason.
3. Fix the root cause, not the symptom.
4. Re-run the same browser flow to confirm the fix.

If you cannot reproduce it, say so before changing code.

## Engineering workflows (Superpowers)

Superpowers is installed by the `vanta` cloud environment's setup script, so
its skills load before the session starts. Reach for them on substantial work:

- `superpowers:brainstorming` — before designing a non-trivial change
- `superpowers:systematic-debugging` — for any bug whose cause isn't obvious
- `superpowers:test-driven-development` — for new logic, especially payments
  and orders
- `superpowers:writing-plans` / `superpowers:executing-plans` — multi-step work
- `superpowers:verification-before-completion` — before claiming work is done
- `superpowers:requesting-code-review` — for larger diffs

Use judgement: a typo fix doesn't need a plan.

If these skills are missing, the session is probably running in the `Default`
cloud environment rather than `vanta`. Say so rather than working around it.

## Plugins (checked in)

`.claude/settings.json` enables these for every session in this repo, so they
need no per-session install:

- **context7** — pulls version-specific docs straight from a library's source.
  This repo runs **Next.js 16.2.10**, which is newer than most models' training
  data; `website/AGENTS.md` exists because working from memory produces
  plausible-looking Next.js that is wrong for this version. Use it before
  writing against an unfamiliar API, alongside `node_modules/next/dist/docs/`.
  It reaches a hosted service (`mcp.context7.com`), so queries leave the
  machine — library names only, never repository content.
  `CONTEXT7_API_KEY` is configured in the `vanta` environment, so lookups are
  keyed rather than running on the shared anonymous quota. The key is injected
  into the MCP transport and is deliberately *not* a shell variable — `env |
  grep CONTEXT7` comes back empty in a working session, so that is not a
  health check. Test it by making a lookup instead. Unkeyed, the anonymous
  quota returns "Monthly quota exceeded" as ordinary tool output rather than
  failing at connect time, so it degrades silently; when a lookup looks thin,
  `website/node_modules/next/dist/docs/` is version-exact and needs no network.
- **typescript-lsp** — go-to-definition, find-references and live type errors
  across `.ts/.tsx/.js/.jsx`. Resolved by the type system rather than by text
  match, so it finds every real call site and no false ones.

**The LSP comes from `vanta-typescript-lsp@vanta-local`, not from the official
plugin.** This section used to say the official `typescript-lsp` plugin was fine
and only needed a TypeScript 5 it could reach. That was wrong in both halves,
and the wrong half mattered: it sent everyone off to install a TypeScript that
was already installed, while the actual cause sat untouched.

What is actually true. Claude Code starts a plugin's language servers from
exactly two places — the plugin's own manifest (`.claude-plugin/plugin.json`,
key `lspServers`) or a `.lsp.json` in the plugin root:

    let K = A.lspServers || await nhY(A, q);   // manifest, else .lsp.json
    if (!K) return;                            // ← neither: silently nothing

The official `typescript-lsp` plugin ships **neither**. Its cached payload is a
README and a LICENSE, nothing else. Its `lspServers` block lives only in the
marketplace catalogue entry, and the CLI deliberately does not read one from
there — it carries the string `"lspServers (not readable from marketplace)"` for
exactly this case. So the plugin can be installed, enabled and perfectly healthy
and still start no server, with no error anywhere. That is why the symptom is
always "no process, no tools, no complaint".

So the repo ships its own. `.claude/plugin-marketplace/` is a local marketplace
registered through `extraKnownMarketplaces` in the checked-in settings, holding
one plugin whose manifest declares the server properly. The official plugin is
set to `false` beside it — leaving it on would mean two `tsserver` processes on
this repo the day upstream ships a manifest.

It points at `website/`, which is not cosmetic: the LSP resolves TypeScript from
its workspace root, and the repo root has no `node_modules`. Started at the root
it reports `Using Typescript version (bundled)`; started at `website/` it reports
`(workspace)` and picks up the version this project actually pins. `${CLAUDE_PLUGIN_ROOT}`
is substituted by Claude Code before any environment expansion, so the relative
hop out to `website/` works in any clone.

Both `typescript-language-server` and `typescript@5` are already present
globally, and `website/node_modules/typescript` covers the workspace, so there is
normally nothing to install. If you do need them:

    cd website && npm install       # website's pinned typescript ^5 (5.9.3)
    npm install -g typescript@5     # global fallback, also works outside website/

The `@5` is not optional. Bare `npm install -g typescript` now resolves to
TypeScript 7 — the native port — which ships `tsc.js` and no `lib/tsserver.js`,
and whose `bin` exposes only `tsc`. It cannot back a language server at all, so
installing it looks like a fix and changes nothing.

The client is spawned once at session start, so a config change fixes the
container but not the running session: restart it afterwards.

To check: `pgrep -af typescript-language-server`. If there is no process, do not
assume TypeScript is missing — check first that the plugin providing the server
actually declares one, with

    cat .claude/plugin-marketplace/plugins/vanta-typescript-lsp/.claude-plugin/plugin.json

A server that is declared but failing is a different problem, and it answers a
plain `initialize` over stdio if you want to see it directly.

## Session startup (checked in)

`.claude/hooks/session-start.sh` runs before every Claude Code on the web
session, registered as a `SessionStart` hook in `.claude/settings.json`. The
cloud container is ephemeral and starts from a fresh clone, so without it
`website/node_modules` is absent and `vitest`, `eslint`, `next build` and the
typescript-lsp plugin all have nothing to run against.

It installs `website`'s dependencies and makes sure a global
`typescript-language-server` and `typescript@5` are present. It is idempotent
(a warm container re-runs it in under a second) and it no-ops entirely unless
`CLAUDE_CODE_REMOTE=true`, so it never mutates a local developer's machine.

It runs synchronously, which costs a few seconds of session startup on a cold
container but guarantees dependencies exist before the first tool call. Switch
it to `{"async": true}` if you would rather have faster startup and accept the
race.

## Other tooling

- **Supabase MCP** — inspect schema and query data when a bug may be
  data-shaped. Read-only against production data unless the user authorises
  a write.
- **Vercel MCP** — deployment status, build logs, runtime errors, and the
  preview URL to browser-test against.
- **Sentry MCP** — check production errors before and after a fix, and use it
  to confirm an error actually stopped occurring.

## Local permission allowlist

Supabase `execute_sql` and `apply_migration` are auto-approved in the checked-in
`.claude/settings.json`, so SQL calls don't prompt in any session, cloud or
local. Auto-approval only removes the permission dialog — the production
Supabase rules above still apply.

`.claude/settings.local.json` is gitignored and available for per-developer
grants on top of that; `scripts/setup-claude-local-settings.sh` recreates it
after a fresh clone.

## Out of scope

- Claude in Chrome is Anthropic's separate local browser extension. Do not
  recreate, package, or bridge it here.
- Never add `/api/mcp/*` routes, browser-control endpoints, or debugging
  backdoors to the customer-facing app. All tooling here is development-only
  and lives outside the Next.js runtime.
