# Block K — findings

**Scope:** time/date/timezone boundaries (coupon and membership expiry), money and
numeric precision, dead/legacy/dormant code, environment and config drift,
legal/policy content, third-party degraded mode, background jobs.

**Rules in force:** [`AUDIT-PARALLEL-ASSIGNMENTS.md`](../AUDIT-PARALLEL-ASSIGNMENTS.md).
This file is Block K's only output. The shared ledger
(`FINAL-CERTIFICATION-AUDIT.md`) and the coverage matrix are **not** edited here —
block M merges this file in and renumbers `K-nn` into the `F-` series.

**Environment:** no network, no database. `npm ci` succeeded and `npx vitest run`
works, so pure functions can be executed. Everything graded
`BEHAVIORAL-TEST-PROVEN` below was actually run in this session, with the output
pasted verbatim.

**Evidence grades** are the ledger's: `BEHAVIORAL-TEST-PROVEN` > `DATABASE-PROVEN`
> `SOURCE-INSPECTED` > `INFERRED` > `NOT VERIFIED`.

---

## Index

| id | severity | grade | title |
|---|---|---|---|
| K-01 | P2 | `BEHAVIORAL-TEST-PROVEN` | Cart-recovery emails state the coupon's expiry in UTC, so a West Coast customer is told they have 7 hours they do not have |
| K-02 | P2 | `SOURCE-INSPECTED` | Both cart-recovery email templates hardcode "5% off" while the discount percent is admin-configurable |

---

## K-01 — Cart-recovery emails state the coupon's expiry in UTC

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P2 · **Status:** OPEN
**Area:** time/date/timezone

### What is wrong

`src/lib/cart-recovery.ts:309` and `:334` format the recovery coupon's expiry for
a customer-facing marketing email with bare `toLocaleString`:

```ts
// src/lib/cart-recovery.ts:309 (t24h stage)
expiresAt: new Date(coupon.expiresAt).toLocaleString("en-US"),
// src/lib/cart-recovery.ts:334 (t72h stage)
expiresAt: new Date(couponForEmail.expiresAt).toLocaleString("en-US"),
```

`toLocaleString` with no `timeZone` formats in whatever zone the process happens
to run in. Emails are sent from the cron sweep on Vercel, which is **UTC**.

This is precisely the defect `src/lib/format-date.ts` was written to eliminate.
Its docblock (lines 1–23) names it:

> WHY THIS EXISTS: every surface called `new Date(iso).toLocaleDateString("en-US", …)`
> with no timeZone, which means "format in whatever zone this code happens to be
> running in". … 1. WRONG DATE. Server rendering and email sending run on Vercel,
> which is UTC.

`formatDisplayDate` pins `DISPLAY_TIME_ZONE = "America/New_York"`. Cart recovery
does not use it. The repair landed but these two call sites were missed.

### Evidence — probe, run in this session

`/tmp/.../scratchpad/tzprobe.mjs`, run as Vercel runs it (`TZ=UTC`), against a
coupon that dies at 6:00 PM Eastern:

```
$ TZ=UTC node tzprobe.mjs
process.env.TZ = "UTC"
resolved zone  = UTC
cart-recovery.ts renders: 8/27/2026, 10:00:00 PM
truth in America/New_York: 8/27/26, 6:00:00 PM
truth in America/Los_Angeles: 8/27/26, 3:00:00 PM
```

### Reachability — confirmed, this is live customer copy

- `src/lib/email/templates.ts:1119` (t24h HTML) —
  `Use code <strong>${escapeHtml(input.couponCode)}</strong> for 5% off - expires ${escapeHtml(input.expiresAt)}.`
- `src/lib/email/templates.ts:1123` (t24h text) — `Code: ${input.couponCode} (expires ${input.expiresAt})`
- `src/lib/email/templates.ts:1141` / `:1145` — the same two lines for t72h.
- `DEFAULT_CART_RECOVERY_CONFIG` (`src/lib/admin-control.ts:243-250`) has
  `t24hEnabled: true`, `t72hEnabled: true`, `couponExpirationHours: 48` — both
  stages ship **on** by default.
- The coupon is real and enforced against that instant:
  `mintCartRecoveryCoupon` (`src/lib/cart-recovery.ts:128`) writes
  `ends_at = new Date(Date.now() + expiresInHours * HOUR_MS).toISOString()`, and
  `validateCoupon` (`src/lib/coupons.ts:157`) rejects on
  `new Date(data.ends_at).getTime() < now`. The instant is correct; only the
  sentence describing it is wrong.

### Impact

A shopper is told a code expires at 10:00 PM. On the East Coast it is already
dead at 6:00 PM; on the West Coast at 3:00 PM. The customer returns inside the
window they were promised and gets *"This coupon has expired"* at checkout — the
last thing a recovery email should produce. The worst case is the full UTC offset:
**4 hours for ET, 7 for PT**, and the copy carries no zone label, so the reader
has no way to tell.

The absolute date can also be wrong, not just the time. Any expiry instant between
00:00 and 07:00 UTC is the *previous evening* in the US, so the email names
tomorrow's date for a coupon that dies tonight.

### Smallest safe root-cause fix

Use the module that exists for this. In `src/lib/cart-recovery.ts`:

```ts
import { formatDisplayDate } from "@/lib/format-date";
// …
expiresAt: formatDisplayDate(coupon.expiresAt, "datetime") ?? "",
```

`"datetime"` renders `Sep 3, 2026, 8:00 PM` in `America/New_York`. Add " ET" to
the template copy so the zone is stated rather than implied.

### Regression test to write

Freeze the clock, mint a coupon whose `ends_at` is `2026-08-27T22:00:00Z`, build
the t24h template, and assert the rendered body contains `6:00 PM`, not
`10:00 PM`, with `process.env.TZ` set to `UTC`. Negative control: revert to
`toLocaleString("en-US")` and confirm the test fails on the `10:00 PM` string —
not on a missing import.

### CROSS-BLOCK

- `src/lib/email/templates.ts:1119,1123,1141,1145` — **Block C.** Appending the
  zone label (` ET`) to the four "expires …" strings is Block C's edit. The
  timezone fix itself is confined to `src/lib/cart-recovery.ts`, which no block
  owns.

### Related, same class, lower value (recorded, not separately numbered)

Other surfaces still bypass `formatDisplayDate` and format a **date** in the
ambient zone. All are UTC on the server:

| file:line | surface | audience |
|---|---|---|
| `src/lib/referral-code-service.ts:155` | "You can change your code again on …" | partner-facing |
| `src/app/api/admin/orders/[orderId]/packing-slip/route.ts` | printed packing slip | internal |
| `src/lib/partner-portal.ts` (2 sites) | partner statement dates | partner-facing — **CROSS-BLOCK: Block A+B** |

`src/lib/coa-format.ts:160-162` looks like the same bug and **is not**: it builds
the `Date` from parsed Y/M/D components in the ambient zone and formats in the
same ambient zone, so the round trip is stable in any zone. Checked and cleared.

---

## K-02 — Both cart-recovery email templates hardcode "5% off" while the discount is admin-configurable

**Grade:** `SOURCE-INSPECTED` · **Severity:** P2 · **Status:** OPEN
**Area:** config drift (with a legal/policy edge)

### What is wrong

The coupon is minted at the **configured** percent:

```ts
// src/lib/cart-recovery.ts:295
: await mintCartRecoveryCoupon(row.email, config.discountPercent, config.couponExpirationHours);
// src/lib/cart-recovery.ts:133
discount_value: discountPercent,
```

The email that announces it is a **literal**:

```ts
// src/lib/email/templates.ts:1119  (t24h HTML)
…for 5% off - expires ${escapeHtml(input.expiresAt)}.
// src/lib/email/templates.ts:1123  (t24h text)
`${input.name || "there"}, here's 5% off to complete your order.`
// src/lib/email/templates.ts:1141 / :1145  — same two, t72h
```

`discountPercent` is not a constant. It is an admin setting with its own input:

- `src/components/admin-cart-recovery-client.tsx:173-179` — a `<input type="number" step="0.5">` labelled **"Discount (%)"**.
- `src/app/api/admin/cart-recovery/settings/route.ts:26` — persists `["discount_percent", body.discountPercent]` into `admin_control` section `cart_recovery`.
- `src/lib/admin-control.ts:261` — `discountPercent: Number(config.discount_percent ?? DEFAULT_CART_RECOVERY_CONFIG.discountPercent)`.

The default happens to be `5` (`src/lib/admin-control.ts:248`), which is why this
is invisible today. The first time the owner uses the control the copy is wrong.

### Impact

Two directions, both bad:

- **Set above 5** (say 15): the customer is offered 5%, gets 15%. The store gives
  away margin it never advertised, and the setting silently does not do what the
  admin screen says it does.
- **Set below 5** (say 3): the email promises 5% off, the code applies 3%. That
  is a misrepresentation in outbound marketing email — an advertised discount the
  store does not honour, in writing, to a named recipient. For a store already
  carrying compliance exposure (see K-series legal findings), this is the
  expensive direction.

The `step="0.5"` on the input means fractional percents are expected, so the copy
must render the number, not a rounded word.

### Reproduction

1. `/admin/cart-recovery` → set **Discount (%)** to `15`, save.
2. Confirm the write: `select metadata from admin_audit_logs where action='admin_control_upsert' and target_table='cart_recovery' and target_id='discount_percent' order by created_at desc limit 1;`
3. Abandon a cart, let it age past 24h (or force the t24h stage).
4. Read the delivered email: it says **5% off**.
5. `select discount_value from coupons where source='cart_recovery' order by created_at desc limit 1;` → **15**.

### Smallest safe root-cause fix

Thread the percent through, exactly as `expiresAt` already is. Add
`discountPercent: number` to both template inputs
(`src/lib/email/templates.ts:1111` and `:1133`) and interpolate it in all four
strings; pass `config.discountPercent` from `src/lib/cart-recovery.ts:295-334`.
Format with a fraction-tolerant helper so `7.5` renders `7.5%` and `15` renders
`15%`, not `15.0%`.

### CROSS-BLOCK

- `src/lib/email/templates.ts:1111,1119,1123,1133,1141,1145` — **Block C owns
  `src/lib/email/**`.** The template-signature change and the four copy strings
  are Block C's edit. Block K supplies the call-site change in
  `src/lib/cart-recovery.ts`, which no block owns.

---

*More findings follow as they are proven. This file is appended to, never
rewritten.*
