# Browser Testing Runbook — Blocks G + H

**Problem this solves:** the audit environment's egress policy denies every
`*.supabase.co` host. Confirmed by three separate sessions, including a
brand-new one on the correct `vanta` environment. A locally running Next.js app
therefore cannot reach any Supabase project, production or throwaway, and every
browser phase was blocked — including the one that matters most, proving a
customer can complete a purchase.

Real PostgREST cannot be downloaded either: GitHub release assets are proxied to
this session's own repositories only.

**Solution:** `website/scripts/pgrst-shim.mjs` speaks the PostgREST wire
protocol over a local Postgres. `supabase-js` talks to it without knowing the
difference. npm and `pg` are already available, so nothing needs downloading.

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

### 6. Build and run — NOT dev

```bash
npm run build && npm run start
```

**Never `npm run dev` in this environment.** The HMR socket is blocked, Next
retries continuously, and Fast Refresh resets React state mid-test. That
produces convincing false bugs — it made a working age gate look like an
un-passable P0 earlier in this audit.

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

- **Embedded selects** (`select=a,b,rel(x,y)`) are not implemented. If a query
  needs one, widen the select and join in application code, or add the embed to
  the shim. Do not silently skip the test.
- If a query fails with a SQL error, **that is a finding until proven
  otherwise** — it may be a genuine schema/query mismatch, not a shim gap.
  Check which before dismissing it.
- The shim logs nothing per-request by design. Add logging if a query is
  behaving unexpectedly.
