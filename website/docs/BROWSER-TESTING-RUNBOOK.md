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

## Chromium is not Safari, and a spoofed user-agent will not make it one

**Only Chromium is pre-installed, and a UA string changes the string, not the
engine.** Driving Chromium with an iPhone user-agent tests our layout, our DOM
and our JavaScript. It does not test WebKit. That distinction is not academic
here: TikTok, Instagram, Facebook and Snapchat on iOS all render in WKWebView,
which is WebKit — so the platforms this runbook exists to protect are precisely
the ones Chromium cannot speak for. Claiming a page is "verified on Safari"
from a Chromium run is the same class of error as reading an
`ERR_CONNECTION_RESET` as an outage.

**Both other engines can be installed, and should be for any layout claim.**
`playwright install` is otherwise discouraged here because it re-fetches
Chromium for nothing; fetching an engine we do not have is a different matter.
`playwright-core` is deliberately NOT a dependency of the app — nothing in the
product imports it — so install it somewhere scratch along with the engines.
Install into a scratch browsers path too, so the pre-installed Chromium is
untouched, and drive the install with the CLI belonging to the same
`playwright-core` you will `import`: the globally installed `playwright` is a
different version and fetches a build the library then cannot find (it looks
for `webkit-2336` and finds `webkit-2215`).

    mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-engines \
      node /tmp/pw/node_modules/playwright-core/cli.js install webkit firefox
    npx playwright install-deps webkit      # needs root; WebKit needs ~40 shared libs

Then run with `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-engines`, and make
`playwright-core` resolvable from `website/` — a symlink into the scratch
install is enough, and node_modules is gitignored.

**Each engine meets the egress proxy differently.** The TLS 1.3 reset described
above is not Chromium-specific, but the fix is:

| Engine | Proxy behaviour | What it needs |
|---|---|---|
| Chromium | every host resets | `args: ['--ssl-version-max=tls1.2']` |
| Firefox  | `NS_ERROR_NET_RESET` on every navigation | `firefoxUserPrefs: { 'security.tls.version.max': 3 }` (3 = TLS 1.2) |
| WebKit   | negotiates fine | nothing |

Without the Firefox pref every page looks dead, which reads exactly like a
site-wide outage and is not one.

Expect the occasional single-resource TLS handshake failure or `ERR_TIMED_OUT`
even with the caps in place. Treat one that does not reproduce across engines
or viewports as transport; a real layout defect reproduces everywhere.

`scripts/cross-engine-check.mjs` runs the whole matrix and applies all of the
above.

    ENGINE=webkit node scripts/cross-engine-check.mjs            # local harness
    ENGINE=firefox BASE_URL=https://www.vantalabsresearch.com \
      node scripts/cross-engine-check.mjs                        # production, READ-ONLY

Last full run, 2026-08-28, against production: WebKit, Firefox and Chromium,
five viewports from 375x548 to 1680x1050, five routes each — no horizontal
overflow and no layout defect in any combination. The only failures were the
transport artifacts above.

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
NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED=false
SHIPPO_WEBHOOK_SECRET=harness-shippo-secret
PAYMENT_PROVIDER=live
VEYRA_API_BASE=http://127.0.0.1:59999
VEYRA_SECRET_KEY=stub-secret-not-real
PAYMENT_WEBHOOK_SECRET=harness-webhook-secret
```

**`PAYMENT_PROVIDER=live`, not `mock`, and this block used to say `mock`.** That
was wrong and it cost a whole diagnosis round: with `mock`, every call to
`/api/checkout/create-session` throws before it does anything, so no order is
ever created and the purchase harness skips twelve of its eighteen steps —
including "exactly one confirmation email" — while still exiting 0. The section
below ("Checkout needs the LIVE provider…") had the right answer all along;
these two blocks disagreed, and the wrong one came first.

`live` here reaches nothing real: `VEYRA_API_BASE` points at
`scripts/veyra-stub.mjs` on loopback, which only mints session ids. That is the
whole point — the genuine live code path, against a stub that cannot take money.

`EMAIL_ENABLED=false` is load-bearing in the same way: it makes it impossible
for a synthetic test to mail a real person.

`SHIPPO_WEBHOOK_SECRET` and `PAYMENT_WEBHOOK_SECRET` are load-bearing in the
other direction. Both webhook routes fail **closed** without them — correctly,
since an unconfigured secret must never mean "accept anything" — so their
absence does not look like a configuration problem, it looks like shipping,
delivery and payment settlement being broken.

`SHIPPO_WEBHOOK_SECRET` is load-bearing in the other direction. Without it
`/api/webhooks/shippo` fails **closed** with 503 — correctly, since an
unconfigured secret must never mean "accept anything" — and section 13 of the
customer journey (shipping, delivery, and both of their emails) cannot pass at
all. It was missing from this list, so those three steps had never run. The
value only has to match `qa-customer-journey.mjs`, which defaults to
`harness-shippo-secret`.

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

**`npm run build` overwrites the harness build, and the harness keeps running
against it.** They share `.next`. A production build is `NODE_ENV=production`, so
Next does not read `.env.test.local` at all — the server comes back up with no
Supabase URL, no payment provider and no webhook secrets, and the failures land
where nobody suspects the build: sign-in stops setting a session cookie, the
account page bounces to the login form, refreshes look like they log the customer
out. Certifying a release is exactly when you run both, so this is easy to walk
into:

```bash
npm run build                       # the certification build
rm -rf .next && npm run harness:build && bash scripts/qa-harness-up.sh
```

Run the production build LAST, or rebuild the harness after it. `qa-harness-up.sh`
now checks the catalogue rather than a 200 on the home page, so this shows up as
`CATALOGUE EMPTY OR FAILING` at bring-up instead of as a dozen unrelated-looking
session failures four minutes later.

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

Checkout is the core transaction of this business. **It was finally driven
end to end on 2026-08-29, in real WebKit, at 393x664 inside a TikTok
user-agent** — the first complete purchase in any environment:

    guest checkout -> order row VL-133391F0 written (pending_payment)
    -> order_items row written -> signed webhook -> paid
    -> inventory 15 -> 14, inventory_committed_at set
    -> confirmation email queued (order_email_log)
    -> /order-confirmation renders "Thank you for your order"

Two harness defects had been blocking it, both since fixed and both invisible
until an engine other than Chromium was tried — see "Shim limitations" below.
Re-run it after any change to cart, pricing, orders or inventory; it is still
the test that outranks everything.

Check at each step that the **database** agrees with the **screen**. The whole
class of defects this audit exists to find lives in that gap.

---

## The QA harnesses — run these before hand-driving anything

Hand-driving a browser proves one path once. These scripts prove the same
things every time, and they are the fastest way to find out whether a change
broke something a long way from where you were working.

    npm run qa:all           # the lot, in order

    npm run qa:seed          # the accounts every role probe needs
    npm run qa:roles         # 1001 probes: every protected route x every role
    npm run qa:crossaccount  # 15 probes: one customer reaching for another's data
    npm run qa:journey       # 60+ steps: age gate -> delivered order -> logout
    npm run qa:purchase      # 13 steps: guest buys, pays, gets ONE receipt
    npm run qa:abuse         # 16 steps: flooding, CSRF, XSS, fixation, cookies

`qa:roles` discovers every route from the filesystem and reads the HTTP methods
each one exports, so a route added without a guard fails it the moment it
exists — which a hand-maintained list can never do, because nobody remembers to
add the route they just wrote.

### Three settings decide whether these prove anything

Every one of them has already turned a green run into a run that checked
nothing, and none of them announces itself.

**Start the harness with `scripts/qa-harness-up.sh`, never by hand.** It starts
the payment stub on :59999 as well as the shim and the app. Without the stub
`createCheckoutSession` gets ECONNREFUSED, `payment-service.ts` cancels the
brand-new order, and every order sits at `payment_status = 'canceled'` — which
reads exactly like a payment bug and is not one. `qa:purchase` then fails at
"the order is canceled, not paid".

**`EMAIL_CAPTURE_DIR=/tmp/vanta-qa` in `.env.test.local`, and email DISABLED in
the Control Center.** The email assertions read what the customer would read
(`providers/noop.ts` writes `captured-emails.jsonl`), and the noop provider only
runs when no real provider is configured. A leftover `email.provider = smtp`
control value beats the env var, so the app tries a dead SMTP host, nothing is
captured, and every email step reports `SKIP — no harness log configured`. Three
of `qa:purchase`'s eighteen steps skipped that way for exactly this reason, and
a skip is not a pass. The capture now records `headers` too, so
`List-Unsubscribe` on a marketing send — and its absence on a receipt — can be
read rather than assumed.

**`VANTA_TEST_DATABASE_URL` for the concurrency proofs.**

    VANTA_TEST_DATABASE_URL=postgres://postgres@localhost:55432/vanta_concurrency npx vitest run

Without it, 121 tests across 14 files skip: double payout, the exactly-once
payout claim, the auto-approve read/write race, refund correctness, the
inventory return path, BXGY redemption claims, partner identity convergence and
admin-invite atomicity. Every one of them is money, none is covered by an
in-memory test, and the suite still prints a green summary without them. The
harness Postgres from `setup-local-harness.sh` is already a throwaway, so a
scratch database on it is all that is needed:

    psql postgres://postgres@localhost:55432/postgres -c 'create database vanta_concurrency'

**`qa:seed` is not optional, and this is why.** `qa:roles` used to take its role
list from a `QA_ROLES` environment variable that nothing in this repository ever
set. The loop that signs the roles in therefore never ran an iteration, the
admin login failed too (`admin_credentials` is empty until seeded), both were
caught and printed as one-line notes, and the run finished:

    166 probes, 0 findings.
    Every protected route refused every role that should not reach it.

...and exited 0. Every word after "guest" in that sentence was unearned — the
only role ever probed was a signed-out visitor. With the accounts present the
same probe set is **1001** probes. A missing role is now fatal rather than a
note, and the roles default to the seeded fixtures instead of to nothing.

`qa:roles` also runs a **positive control**: the admin session must actually
reach the admin routes. Without it, an admin area that refused *everybody* — or
500ed on every request — would score zero findings and read as perfect
isolation. Locked is not the same as secure. The control is reported separately
from the boundary findings, because an admin being refused is a different defect
from an outsider getting in, and only "the admin reached nothing" invalidates
the run.

`qa:crossaccount` answers the question `qa:roles` structurally cannot. Every
`[param]` `qa:roles` substitutes is a placeholder that belongs to nobody, so a
route that looks up a row, finds none, and returns 404 is indistinguishable
there from one that finds the row, checks the owner, and refuses. Both read as
"refused". `qa:crossaccount` gives one customer a real order, address, cart and
partner record, then asks for each by its real id as a *different* signed-in
customer — and checks the database afterwards rather than believing the status
code, because a route can answer 200 and change nothing, or 500 and change
something.

`qa:journey` is the whole customer lifecycle in ONE browser session, which is
the only way to catch state that survives (or fails to survive) a navigation: a
cart that empties on sign-in, a cookie that works on one page and not the next,
two tabs disagreeing about whether you are signed in.

`qa:purchase` is the receipt test. A shopper charged and told nothing writes to
support; one charged and told twice stops trusting the receipts. It creates a
real order through the app's own checkout, settles it with the same signed event
a processor posts, and asserts exactly one confirmation — then retries the
webhook, as a processor does, and asserts no second one. Cart ids there are
`slug` or `slug::doseId`, never a products.id: quote-order.ts keys the catalogue
by slug, and most of this catalogue is dose-stocked.

`qa:abuse` needs `rate_limit_hits` to exist or every limiter FAILS OPEN by
design and the flood tests prove nothing. `setup-local-harness.sh` applies it;
if you see `UNENFORCED` in the output, that table is missing.

### Reading the output

Steps report PASS, FAIL or **SKIP**, and skips are printed again at the end
under "these are NOT verified". Read them. A skip is a check that did not run —
treating it as a pass is precisely the false confidence these scripts exist to
remove.

### If qa:journey fails at signup

Its own signup is being throttled. Each run presents a distinct client IP
(TEST-NET-3) so it does not share a bucket with `qa:abuse`, whose job is to
exhaust them — but deleting `rate_limit_hits` does NOT reset the limiter, which
also holds a spent bucket in memory for the window. Restart the app server, or
wait the window out.

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
- **`PAYMENT_PROVIDER=mock` is still NOT reachable through the harness.** The
  lockout throws `PAYMENT_PROVIDER=mock/test is forbidden in production`,
  because Next re-establishes its own environment after `prepare()` and the
  parent's `NODE_ENV` reassignment does not follow. See the long comment in
  `harness-server.mjs`.

  **Use the live provider against the local stub instead** (section 7 above) —
  and note that this ALSO clears what this entry used to claim was permanently
  lost. With `PAYMENT_PROVIDER=live` + `veyra-stub.mjs`:

      GET /api/catalog/payment-methods  ->  200, card method + badges

  so the card fee disclosure IS reachable, and a complete purchase IS drivable
  here. The old text said neither was possible; it was measuring `mock` mode
  and generalising from it.

  Do not "fix" the `mock` path by weakening the lockout. It is the control that
  stops `/api/checkout/mock-pay` marking orders paid in production, and it
  deliberately has no override variable.

- **Two harness defects that hid behind Chromium, both fixed 2026-08-29.**
  Neither was a site bug; both made the site look broken.

  `harness-server.mjs` passed through `Strict-Transport-Security` and CSP's
  `upgrade-insecure-requests` — correct for production, fatal on a plaintext
  port. WebKit rewrote every asset URL to `https://127.0.0.1:3000`, all 14
  scripts failed the TLS handshake, React never booted and the age gate could
  never be passed. Chromium exempts loopback from the upgrade, so it looked
  fine there for as long as Chromium was the only engine installed. The server
  now strips both; middleware.ts is untouched.

  `pgrst-shim.mjs` had no case for PostgREST's `columns=` bulk-insert spec, so
  it reached the unknown-filter guard and refused — correctly, but `columns`
  narrows a write rather than widening a read. Checkout wrote the order, minted
  the payment session, then died on `Unable to create order items`, leaving an
  orphan. The declared column set is now honoured, which is also what keeps a
  bulk insert's values in the right columns.

- **`bac-water` is not seeded**, so `/api/catalog/bac-water` 404s on every page
  that renders the bacteriostatic-water upsell — which is most of them,
  including the cart. Production returns 200 for it. It is a seed gap, not a
  defect, but it means the upsell and its cart checkboxes are untested here.

- If a query fails with a SQL error, **that is a finding until proven
  otherwise** — it may be a genuine schema/query mismatch, not a shim gap.
  Check which before dismissing it.
- The shim logs nothing per-request by design. Add logging if a query is
  behaving unexpectedly.
