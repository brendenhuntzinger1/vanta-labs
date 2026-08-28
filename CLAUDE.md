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
  It runs anonymously unless `CONTEXT7_API_KEY` is set, and the anonymous tier
  is a shared monthly quota that does run out — when it does, every lookup
  returns "Monthly quota exceeded" rather than failing loudly at connect time.
  Set the key in the `vanta` environment if you rely on it; until then fall
  back to `website/node_modules/next/dist/docs/`, which is version-exact
  anyway.
- **typescript-lsp** — go-to-definition, find-references and live type errors
  across `.ts/.tsx/.js/.jsx`. Resolved by the type system rather than by text
  match, so it finds every real call site and no false ones.

**typescript-lsp needs a TypeScript 5 it can reach.** The plugin is enabled by
the checked-in settings and the marketplace entry carries its own `lspServers`
config, so nothing is missing on the plugin side. What it needs is a real
`tsserver`, and the session-start hook below now supplies one on every web
session — you should not have to do this by hand.

`typescript-language-server` looks for TypeScript in the **workspace** first and
falls back to the global install. Either one satisfies it:

    cd website && npm install       # website's pinned typescript ^5 (5.9.3)
    npm install -g typescript@5     # global fallback, also works outside website/

The `@5` is not optional. Bare `npm install -g typescript` now resolves to
TypeScript 7 — the native port — which ships `tsc.js` and no `lib/tsserver.js`,
and whose `bin` exposes only `tsc`. It cannot back a language server at all, so
installing it looks like a fix and changes nothing.

With neither in place the server exits during `initialize` with "Could not find
a valid TypeScript installation", and every LSP feature silently does nothing —
no error surfaces anywhere.

The client is spawned once at session start, so installing TypeScript
mid-session fixes the container but not the running session: restart it
afterwards.

To tell a dead server from a broken plugin: `ps aux | grep
typescript-language-server`. No process means it exited at startup, and the
cause is almost always a missing TypeScript 5.

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
