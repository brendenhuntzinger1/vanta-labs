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

- **78 admin API route files** under `src/app/api/admin/**`, every exported
  HTTP method, and the auth + capability call in each. Table in I-02.
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

## I-02 — Money-spending fulfillment and shipping routes have no capability gate: `staff` can buy and void shipping labels

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN

Every admin route was enumerated with its methods and its auth calls. 62 of 78
carry both a session check and a capability gate. **16 carry a session check
only** — meaning the lowest-privilege role, `staff`, can call them.

Most of those 16 are read-only and defensible. These are not:

| Route | Methods | What it does with no capability gate |
|---|---|---|
| `orders/[orderId]/shipping/label` | POST, DELETE | **Buys a shipping label (real money) / voids-refunds one** |
| `fulfillment/labels` | GET, POST | **Bulk label purchase** |
| `orders/[orderId]/shipping/rates` | GET, POST | Queries carrier rates |
| `orders/[orderId]/shipping/sync` | POST | Writes tracking state onto an order |
| `fulfillment/batches` | GET, POST, PATCH | Creates/mutates fulfillment batches |
| `orders/[orderId]/communications` | GET, **POST** | **Sends a message to a customer** |
| `tax/export` | GET | Full tax export |

The comparison that makes this a defect rather than a design choice is
*internal*: this codebase already treats spending and customer contact as
manager+ work.

- `canManageRefunds` is manager+ because "refunds move real money once a payment
  processor is connected" (`src/lib/admin-roles.ts:16-23`). Buying a label moves
  real money **today**, through Shippo, with no processor required.
- `canManageEmailCampaigns` is manager+ because "a bad send cannot be recalled"
  (`admin-roles.ts:78-83`). `orders/[orderId]/communications` POST sends to a
  customer and equally cannot be recalled.
- `orders/export` and `customers/export` require `canManageSettings`;
  `tax/export` requires nothing. Three exports of comparable sensitivity, two
  gated, one not.

There is **no `canManageFulfillment` capability at all** in `admin-roles.ts` —
the gate was never written, so the routes could not have used one.

`src/lib/admin-permission-matrix.test.ts` enumerates every exported capability
and fails when a new one is unclassified. It cannot catch this: the failure is
a *missing* capability, not an unclassified one. The matrix proves the gates
that exist are correctly assigned; it says nothing about routes that reference
no gate.

### Fix (proposed — not yet applied)

Add `canManageFulfillment` (manager+, same bar as refunds), apply it to the
label-purchase, label-void, bulk-label, batch-mutation and customer-message
routes, gate `tax/export` behind `canManageSettings` to match its two
siblings, and extend the permission matrix test with the new capability.

**CROSS-BLOCK:** `src/app/api/admin/orders/[orderId]/shipping/**` and
`src/app/api/admin/fulfillment/**` are Block D's primary files (fulfillment).
Per Rule 3 the capability-gate edit is recorded here rather than applied, unless
Block D has not touched them at consolidation time. `src/lib/admin-roles.ts` and
`src/lib/admin-permission-matrix.test.ts` are Block I's own and are safe to edit.

---

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

## I-04 — `GET /api/ads/purchase-event/[orderId]` is a second, weaker, unrated-limited door to order data — and it writes

**Grade:** `SOURCE-INSPECTED` · **Severity:** P2 · **Status:** OPEN

The four non-admin parameterised routes were checked for IDOR:

| Route | Verdict |
|---|---|
| `account/addresses/[addressId]` PATCH/DELETE | **PASS.** Every mutation carries `.eq("user_id", user.id)` alongside `.eq("id", addressId)`, so the path parameter cannot select another customer's row (`route.ts:52-56`, `78-82`). |
| `checkout/order-status/[orderId]` GET | **PASS by design.** Unguessable UUID as bearer token, rate limited via the hardened resolver, returns coarse status only — no email, address, amount or line items, and the reasoning is written down at `route.ts:27-39`. |
| `coa/[coaId]/file` GET | **PASS.** Re-checks published-and-live, mints a short-lived signed URL, 307 + `no-store`. |
| `ads/purchase-event/[orderId]` GET | **See below.** |

`ads/purchase-event/[orderId]` shares the bearer-token model but not the
discipline that goes with it. For any order id, **unauthenticated**, it returns
`amountPaid`, and per line item the product name, quantity and unit price
(`route.ts:98-109`, returned inside `event`/`snapPurchase`/`redditPurchase` at
`305-308`).

That is precisely the data `order-status` refuses to return, from the same
identifier, on the same trust model. `order-status` states the intent
explicitly: *"This must not become a second, weaker way to read an order."*
This is that second way.

Three concrete gaps:

1. **No rate limit.** `order-status` is capped at 120/min per IP *specifically*
   so the id space cannot be swept (`order-status/route.ts:46-52`). This route
   has no limit, so the sweep protection on the guarded door is moot while the
   unguarded one is open.
2. **An unauthenticated GET performs writes and external sends.** It upserts
   `ad_purchase_events_sent` (`route.ts:287-296`), POSTs a conversion to TikTok
   (`260`) and to Reddit (`242`). A GET with side effects, reachable by anyone
   holding an order id, is also a way to force outbound traffic on the store's
   ad credentials.
3. **`?inspect=1` is gated, the default path is not** — and the default path is
   the one that leaks. The admin check at `200-201` guards the *diagnostic*
   view while the anonymous branch below already returns the value and items.
   The comment at `26-30` reasons that the confirmation page renders the same
   total to anyone holding the link, which is true of the total and not of the
   per-line unit prices.

### Fix (proposed — not yet applied)

Rate-limit on the same key and resolver `order-status` uses; drop line-item
`unitPrice`/`productName` from the anonymous response (the pixel needs content
ids and a total, not a priced basket); and gate the send/upsert side effects so
a repeat GET cannot re-trigger outbound calls.

**CROSS-BLOCK:** `src/app/api/ads/**` is not in any block's primary file list.
Recording rather than editing; consolidation should assign it.

---

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

## Status

| Id | Severity | Evidence | Fixed |
|---|---|---|---|
| I-01 | P0 | `DATABASE-PROVEN` + `BEHAVIORAL-TEST-PROVEN` | **Read boundary fixed & tested.** Rotation + historical rows still owed to the owner |
| I-02 | P1 | `SOURCE-INSPECTED` | No — fix proposed, CROSS-BLOCK with D |
| I-03 | P1 | `BEHAVIORAL-TEST-PROVEN` | **Fixed & tested** (incl. I-03b, found by the test) |
| I-04 | P2 | `SOURCE-INSPECTED` | No — fix proposed, CROSS-BLOCK unassigned |
| I-05 | **P1** (raised) | `BEHAVIORAL-TEST-PROVEN` + `DATABASE-PROVEN` | **Fixed & tested** |
| I-05b | — | `SOURCE-INSPECTED` | **PASS** — customer-facing proof upload already correct |
| I-06 | P3 | `DATABASE-PROVEN` | No — owner decision (accept GIFs or not) |

I-01, I-03 and I-05 are proven and fixed, with negative controls recorded
above. I-02 and I-04 remain `SOURCE-INSPECTED`: per the execution plan's
step 3, a finding is not proven until a test fails for the right reason. Their
tests and fixes follow.

Full suite after I-05: **207 files / 3624 tests passed**, 1 file / 7 tests
skipped, zero regressions. `tsc --noEmit` clean, eslint clean.

**CROSS-BLOCK:** `src/app/api/catalog/back-in-stock/route.ts` sits under
`api/catalog/`. Block D owns `catalog.ts` (the library), not this route, so the
edit was made here; flagging it in case D touches the same file.
