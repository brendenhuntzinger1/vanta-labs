# Browser Testing Runbook — Blocks G + H

> **Egress note, re-checked 2026-08-27: the block described below has lifted.**
> `https://<ref>.supabase.co/rest/v1/` now answers from the real Supabase edge
> (HTTP 401 `UNAUTHORIZED_MISSING_API_KEY`, with a matching `sb-project-ref`
> header) — a reply, not a refusal. The original premise of this runbook no
> longer holds, so **check egress yourself rather than assuming either way**; it
> has moved once and may move again.
>
> The shim remains the recommended target, but for a better reason than the
> original one: it is isolated *by construction*. It cannot reach production
> even by accident, so no misconfiguration or stray write can touch live
> customer data. Reach for a real Supabase project only when you specifically
> need GoTrue auth or RLS (see the table below), and then use the **harness**
> project (`snnezhxvssochqpqsjcm`), never production.

**Problem this solved:** the audit environment's egress policy denied every
`*.supabase.co` host. Confirmed by three separate sessions, including a
brand-new one on the correct `vanta` environment. A locally running Next.js app
therefore could not reach any Supabase project, production or throwaway, and
every browser phase was blocked — including the one that matters most, proving a
customer can complete a purchase.

Real PostgREST cannot be downloaded either: GitHub release assets are proxied to
this session's own repositories only.

**Solution:** `website/scripts/pgrst-shim.mjs` speaks the PostgREST wire
protocol over a local Postgres. `supabase-js` talks to it without knowing the
difference. npm and `pg` are already available, so nothing needs downloading.

---

## Reaching a live site from a cloud session (TLS 1.3 vs the egress proxy)

Cloud sessions send outbound HTTPS through an intercepting proxy. Chromium
picks that proxy up on its own from `https_proxy`, so **no proxy flag is
needed** — but its default TLS 1.3 ClientHello is reset by the interceptor.
Every navigation fails with `net::ERR_CONNECTION_RESET`, for *any* host:

    page.goto: net::ERR_CONNECTION_RESET at https://example.com/

**This is an environment artefact, not a site defect.** `curl` to the same URL
succeeds, which is the tell: if curl works and the browser does not, suspect
the transport before you suspect the application. Read that failure as a
product bug and you will "reproduce" an outage that does not exist — the same
class of false positive as browser-testing against `npm run dev`.

The fix is committed: `.playwright-mcp.json` launches Chromium with
`--ssl-version-max=tls1.2`, and `.mcp.json` points the Playwright MCP server at
it via `--config`. Capping the QA browser at TLS 1.2 changes nothing about what
the application does, and it is inert on a laptop with no proxy, so the same
config works locally and in the cloud.

Driving Playwright directly (outside MCP) needs the same flag:

    chromium.launch({
      executablePath: '/opt/pw-browsers/chromium',
      args: ['--no-sandbox', '--ssl-version-max=tls1.2'],
    })

Verified 2026-08-27: with the flag, `https://www.vantalabsresearch.com/`
returns 200 and the full storefront is drivable; without it, every host resets.

---

## What this is and is not

It translates HTTP to SQL against a **real** Postgres running the **real**
schema, the **real** constraints and the **real** plpgsql functions. A bug in
`reserve_inventory` still reproduces. A unique-constraint violation still fires.

It does **not** provide:

| Missing | Consequence |
|---|---|
| RLS | It connects as superuser — the same effective privilege as production's service-role key, so app behaviour matches. RLS **policy correctness** is not exercised. |
| GoTrue auth | Signed-in flows do not work. Guest checkout does. |
| Storage / realtime | Not implemented. |

**Grade accordingly.** Application behaviour proven here is `BROWSER-PROVEN`.
Anything auth-dependent or RLS-dependent stays `NOT VERIFIED`. Do not let the
shim launder one into the other — that would be exactly the kind of upgraded
evidence grade this audit exists to prevent.

---

## Setup

### 1. Postgres

```bash
/usr/lib/postgresql/16/bin/initdb -D /tmp/vantapg -A trust -U postgres   # if absent
/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/vantapg -o '-p 55432 -k /tmp' start
createdb -h /tmp -p 55432 -U postgres storefront
```

Run these as the `postgres` user (`su postgres -c "..."`); initdb refuses to run
as root.

### 2. Schema

Generate it from the **harness** Supabase project (`snnezhxvssochqpqsjcm`) using
the Supabase MCP tools, which route over an allowed path. Pull, in this order:

1. `CREATE TABLE` for every table the storefront touches
2. primary keys, unique constraints, check constraints, foreign keys
3. the partial unique indexes that carry correctness — at minimum
   `orders_idempotency_key_uniq`, `inventory_reservations_order_line_key`,
   `order_email_log_one_live`
4. the plpgsql functions: `validate_referral_code`, `reserve_inventory`,
   `finalize_inventory_for_order`, `release_inventory_for_order`,
   `expire_stale_reservations`, `redeem_coupon`, `create_partner_application`,
   `create_partner_invite`

**Skip RLS entirely** — the shim connects as superuser, so policies would be
inert anyway, and creating them invites the false impression they were tested.

**Also create a stub `auth` schema** if any function references `auth.uid()`:

```sql
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
```

### 3. Seed

Mirror production **shapes**, not production data. At minimum:

- a product with parent `inventory_quantity = 0` and a stocked dose — this is
  86% of the live catalogue (F-001) and the shape stock display must handle
- a product with every dose at zero, as the out-of-stock control
- a product with a parent image but no gallery rows, and one with the inverse
- ambassadors covering all three discount resolutions: explicit percent,
  NULL (inherits program default), and `info_requested` (must be inert)
- one coupon, one membership tier

### 3b. Turn inventory tracking ON, or stock testing is meaningless

**This one manufactures false P0s. Do not skip it.**

`inventory.tracking_enabled` defaults to **false** (see
`src/lib/inventory-settings.ts`, which documents why that default is
deliberate). While it is off, `resolveStockStatus` in `catalog.ts` returns
`In Stock` for *every* product regardless of quantity — so a zero-stock product
renders a live ADD TO CART, adds to the cart, and is only refused at the final
checkout step.

A fresh harness has no `admin_control` rows at all, so it always starts in that
state. **Production has tracking ON** (set 2026-08-25), so a harness left at the
default does not match production and any stock finding from it is an artifact.
Cost of not knowing this, 2026-08-27: a full false bug report claiming 8 live
products were mis-selling, when the code was correct throughout.

```bash
psql -h /tmp -p 55432 -U postgres -d storefront -c "
insert into admin_audit_logs (actor_user_id, action, target_table, target_id, metadata)
values (null, 'admin_control_upsert', 'inventory', 'tracking_enabled', '{\"value\": true}'::jsonb);"
```

The `action` must be exactly `admin_control_upsert` — the `admin_control_current`
view filters on it, so any other action string inserts a row the app never sees.

Confirm it took, then **clear the cache and restart** (`getCatalogProducts` is
`unstable_cache`-wrapped, so a stale catalogue survives the settings change):

```bash
psql -h /tmp -p 55432 -U postgres -d storefront -tAc \
  "select target_id, metadata from admin_control_current where target_table='inventory';"
rm -rf .next/cache && npm run harness:start
```

With tracking on, a parent-zero/all-doses-zero product correctly renders
`OUT OF STOCK` with a `NOTIFY ME` button in place of the buy CTA, and a
parent-zero/dose-stocked product (F-001) correctly stays purchasable.

### 4. Start the shim

```bash
node scripts/pgrst-shim.mjs --port 54321 \
  --db postgres://postgres@localhost:55432/storefront
curl -s http://127.0.0.1:54321/rest/v1/__health
```

### 5. Point the app at it

`website/.env.local` (gitignored):

```
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=local-shim-not-a-real-key
SUPABASE_SERVICE_ROLE_KEY=local-shim-not-a-real-key
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=local-shim-not-a-real-key
EMAIL_ENABLED=false
EMAIL_PROVIDER=none
NEXT_PUBLIC_ENABLE_ANALYTICS=false
CHECKOUT_ENABLED=true
PAYMENT_PROVIDER=mock
NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED=false
```

`EMAIL_ENABLED=false` and `PAYMENT_PROVIDER=mock` are load-bearing: they make it
impossible for a synthetic test to mail a real person or reach a real processor.

### 5b. Env goes in `.env.test.local`, NOT `.env.local`

`harness:build` and `harness:start` both set `NODE_ENV=test`, and Next does not
load `.env.local` in test — see
`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md`:
*".env.local won't be loaded, as you expect tests to produce the same results
for everyone."* Section 5 above tells you to put everything in the one file the
harness cannot read. Symptom: `Missing NEXT_PUBLIC_SUPABASE_URL` and every
product page 500s.

Put the same contents in **`.env.test.local`** (also gitignored). Keep
`.env.local` too if you ever run `next dev`.

### 6. Build and run — NOT dev

```bash
npm run harness:build && npm run harness:start
```

**Never `npm run dev` in this environment.** The HMR socket is blocked, Next
retries continuously, and Fast Refresh resets React state mid-test. That
produces convincing false bugs — it made a working age gate look like an
un-passable P0 earlier in this audit. (Re-confirmed 2026-08-26: in dev the age
gate cannot be passed even with all four boxes genuinely checked.)

**Clear `.next/cache` after any schema or settings change.** `getCatalogProducts`
is wrapped in `unstable_cache`, which caches FAILURES and persists across
restarts, so a fix looks like a no-op until you do:

```bash
rm -rf .next && npm run harness:build
```

### 7. Payments: run LIVE mode against a local stub

Do **not** try to use `PAYMENT_PROVIDER=mock` on a production build, and do not
weaken the lockout to make it work. The guard

```js
if (process.env.NODE_ENV === "production") throw new Error("PAYMENT_PROVIDER=mock/test is forbidden…")
```

is **constant-folded away at build time** — the compiled bundle contains an
unconditional throw:

```js
if ("mock" === t || "test" === t) throw Error("PAYMENT_PROVIDER=mock/test is forbidden in production…")
```

so `harness-server.mjs`'s runtime `NODE_ENV = "test"` cannot re-open it; the
check no longer exists to re-evaluate. That control is correct and must stay.

Instead, run the **real live provider against a local stub**. `VEYRA_API_BASE`
is a required env var read by both `LivePaymentProvider.createCheckoutSession`
and the express service, so pointing it at localhost exercises the genuine code
path and reaches no real processor:

```
PAYMENT_PROVIDER=live
VEYRA_API_BASE=http://127.0.0.1:59999
VEYRA_SECRET_KEY=stub-secret-not-real
CHECKOUT_ENABLED=true
```

```bash
node scripts/veyra-stub.mjs      # mints session ids only; never marks anything paid
```

> `scripts/veyra-stub.mjs` originates from the live-inspection session
> (`claude/vanta-labs-live-inspection-h1eh4f`). If it is not on your branch yet,
> take it from there rather than writing a second one.

Then drive the outcome with a signed webhook through the real handler:

```bash
PAYMENT_WEBHOOK_SECRET=<your harness secret> \
  node scripts/harness-pay-order.mjs <order_id>                      # success
PAYMENT_WEBHOOK_SECRET=... HARNESS_EVENT_TYPE=payment.failed \
  node scripts/harness-pay-order.mjs <order_id>                      # decline
```

`HARNESS_EVENT_TYPE` also accepts `payment.canceled` and `refund.completed`.

**This gets you the full loop** — checkout UI → order → payment outcome →
success/decline UI — on a production build, with production protections intact.
Verified 2026-08-26: the decline message, the poll stopping, and the paid-order
redirect to confirmation were all browser-proven this way.

**What it still cannot do:** mount the real card iframe. `SCRIPT_SRC` in
`VeyraCheckout.tsx` is hardcoded to `https://veyragate.com/v1/checkout.js`, and
it should stay hardcoded — an env-configurable script src on a payment page is a
way to point the card form at an arbitrary script. The poll runs independently
of the iframe, which is why the decline and success paths are still reachable.

---

## The one test that outranks everything

Before any other browser work, prove **one complete purchase**:

cart → discount applied → payment (mock) → order row written → inventory
decremented → confirmation email queued → order appears in the fulfilment queue.

Checkout is the core transaction of this business and it has never been
exercised in any environment. Everything else in G+H is secondary.

Check at each step that the **database** agrees with the **screen**. The whole
class of defects this audit exists to find lives in that gap.

---

## Then, in priority order

1. **F-001** — a parent-zero/dose-stocked product must render In Stock and be
   purchasable. 31 of 36 live products have this shape
2. **Historical defect #1** — an ambassador with an explicit 15% must show 15%
   in the cart, and one with NULL must show the program default
3. **`HOLDPROBE`-style code** (`info_requested`) must be rejected in the cart
4. Coupon + referral together; the Buy-3-Get-1 interaction
5. Cart persistence across refresh, back/forward, and a new tab
6. Mobile 390×840 — age gate, nav, cart drawer, checkout form
7. Accessibility — keyboard path through checkout, focus trapping, labels
8. Console errors on every major route (production build only)

---

## Shim limitations to work around

- **Embedded selects** (`select=a,b,rel(x,y)`) ARE implemented, as of
  2026-08-28. Both directions work — a child array (`orders` →
  `order_items(...)`), a parent object (`customer_memberships` →
  `membership_tiers(...)`), aliases (`items:order_items(...)`), `select=*`
  beside an embed, and nesting.

  They resolve the join by reading `pg_constraint`, the way PostgREST does, so
  an embed only works when the foreign key actually exists in the harness
  database. That was the real blocker: the bootstrap's `create table if not
  exists` silently discards `references` clauses, leaving production with 35
  foreign keys and the harness with 17 — including none of the three the
  application embeds most. `harness-prod-parity-foreign-keys.sql` closes that
  and the bootstrap applies it.

  If an embed comes back missing from the row, the shim says why on stderr
  (`no foreign key joins X to Y; dropping embed`). Treat that as a schema gap
  to add to the parity file — not as a reason to widen the select and move on.
  It will not guess a join, because a harness that guesses is a harness that
  lies.

  **This section previously said embeds were "not implemented", and before that
  the shim's own docblock said they were returned as correlated subqueries
  while the code dropped them on the floor.** Three audit phases lost time to
  it: the order-detail page could not be browser-tested at all, a membership
  store-credit grant fell back to unit tests, and a nested `order_items` read
  of a column that does not exist stayed invisible.
- If a query fails with a SQL error, **that is a finding until proven
  otherwise** — it may be a genuine schema/query mismatch, not a shim gap.
  Check which before dismissing it.
- The shim logs nothing per-request by design. Add logging if a query is
  behaving unexpectedly.
