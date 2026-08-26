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

## I-01 — Payment-processor and email provider secrets are written to `admin_audit_logs` in plaintext and rendered by the audit-log viewer

**Grade:** `SOURCE-INSPECTED` · **Severity:** P0 · **Status:** OPEN

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

### Blast radius

1. **Retention.** Rotating a leaked processor key does not remove the leaked
   value; the old row stays forever. There is no redaction path and no TTL on
   `admin_audit_logs`.
2. **Widened access.** Anything with read access to `admin_audit_logs` now holds
   payment and email credentials: the Supabase console, a database backup, a
   read-replica, an analytics export, a support engineer with table access.
   None of those are in the settings screen's threat model.
3. **Realtime broadcast.** `src/components/admin-control-center-client.tsx:227`
   subscribes to `postgres_changes` on `admin_audit_logs` for `event: "*"`. Any
   session subscribed to that channel is on the delivery path for rows carrying
   secrets.

### Root cause

`upsertControlValue` is a *generic* config writer with no notion of
sensitivity, and it doubles as the audit writer. One function is being asked to
do two jobs with opposite requirements: config storage must keep the value,
audit history must not.

### Fix (proposed — not yet applied)

Two independent changes, because either alone leaves a hole:

1. **At the write.** Never persist a sensitive value into the audit metadata.
   Store a redaction marker plus a non-reversible fingerprint (`sha256` prefix)
   so an operator can still answer "did the key change?" without the key.
2. **At the render.** Deny-list by default in `summarizeMetadata` — print
   `value` only for sections/keys known non-sensitive, or suppress `value`
   outright for `admin_control_upsert`. Defence in depth: rows written before
   the fix are still in the table.

### Not yet done

- Regression test proving a secret written through `PATCH /api/admin/settings`
  never reaches `metadata.value`, and that the viewer suppresses it for
  pre-existing rows.
- A migration/backfill decision for rows already carrying secrets. **This needs
  the owner** — it is a production data change (Rule 4).

**`OWNER DECISION NEEDED:`** existing `admin_control_upsert` rows in production
almost certainly contain live or recently-rotated secrets. Redacting them is a
production write. Do not apply without explicit approval. Rotating the affected
credentials is the safer first step and is the owner's call.

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

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN

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

### What is NOT proven

Whether Vercel's edge overwrites `x-forwarded-for` before the function sees it.
If it does, strategy 2 is safe by accident and strategy 1's comment is
over-cautious. Proving it needs a request to a **preview** deployment with a
forged header, reading back the resolved value — network work, not yet run, and
not to be run against production.

The fix is safe under either answer: routing all three through
`getRequestIpAddress` is strictly no worse than the current code and removes the
divergence. Grade stays `SOURCE-INSPECTED` until a preview probe runs.

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

**Grade:** `SOURCE-INSPECTED` · **Severity:** P2 · **Status:** OPEN

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

### Severity

Both routes require `canManageProducts` (manager+), so this is not
externally reachable — it is defence-in-depth, and P2 rather than P0 for that
reason. What it costs: arbitrary bytes under an arbitrary extension, publicly
served, permanently, from a company-branded origin, with no content validation
and no way to tell from the record what was actually stored.

### Fix (proposed — not yet applied)

Reuse the sniffer that already exists rather than writing a second one: sniff
the bytes in `uploadProductImageToStorage`, reject anything that is not a real
image, derive both the extension and the stored `contentType` from the sniffed
type, and apply the 8 MB cap inside the helper so both entry points inherit it.

---

## Status

| Id | Severity | Evidence | Fixed |
|---|---|---|---|
| I-01 | P0 | `SOURCE-INSPECTED` | No — fix proposed, owner decision needed on existing rows |
| I-02 | P1 | `SOURCE-INSPECTED` | No — fix proposed, CROSS-BLOCK with D |
| I-03 | P1 | `SOURCE-INSPECTED` | No — fix proposed |
| I-04 | P2 | `SOURCE-INSPECTED` | No — fix proposed, CROSS-BLOCK unassigned |
| I-05 | P2 | `SOURCE-INSPECTED` | No — fix proposed |

Nothing above has been upgraded past `SOURCE-INSPECTED`: per the execution
plan's step 3, a finding is not proven until a test fails for the right reason.
Tests and fixes follow.
