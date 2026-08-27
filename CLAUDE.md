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
