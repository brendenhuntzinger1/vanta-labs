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

## K-03 — The membership renewal charge's only double-charge guard is keyed to the UTC calendar date, and the post-charge state write is unchecked

**Grade:** `BEHAVIORAL-TEST-PROVEN` (key instability) + `SOURCE-INSPECTED` (the
unchecked write) · **Severity:** P1 · **Status:** OPEN
**Area:** background jobs × time/timezone × dormant-code-that-arms-itself

### The invariant this breaks

`src/app/api/cron/sweep/route.ts:19-21` states the contract in its own words:

> **Every job is individually idempotent**, so running this more often than
> necessary is always safe, and running it less often just means coarser timing,
> not incorrect behavior.

Step 5 of `runMembershipBillingSweep` does not hold up its end.

### What is wrong — two defects that compose

**(a) The select has no claim, so the key is the only guard.**
`src/lib/membership-billing.ts:1466-1481`:

```ts
.is("veyra_membership_id", null)
.eq("status", "active")
.eq("cancel_at_period_end", false)
.lte("next_billing_at", now.toISOString());
```

Nothing marks a row in-flight. A row stays selectable until the *post-charge*
update pushes `next_billing_at` forward.

**(b) The idempotency key is derived from the wall clock, not from the period
being paid for.** `src/lib/membership-billing.ts:1497`:

```ts
idempotencyKey: `renewal-${row.user_id}-${tier.id}-${now.toISOString().slice(0, 10)}`,
```

`toISOString().slice(0,10)` is the **UTC calendar date**. So the guarantee this
buys is *"at most one renewal charge per member per UTC day"* — not *"at most one
renewal charge per billing period"*, which is what a recurring charge needs.

**(c) And the write that closes the window discards its own error.**
`src/lib/membership-billing.ts:1500-1510`:

```ts
await supabaseAdmin
  .from("customer_memberships")
  .update({ next_billing_at: nextBillingAt.toISOString(), … })
  .eq("user_id", row.user_id);
```

No `{ error }` destructure, no check, no throw, no alert. If that update fails,
the card has already been charged, the row is still due, and **nothing anywhere
records that it happened**. The loop moves to the next member.

### Evidence — probe, run in this session

```
$ TZ=UTC node keyprobe.mjs
membership-billing.ts:1497 renewal key
  tick1 23:45Z -> renewal-u-123-t-pro-2026-08-27
  tick2 00:15Z -> renewal-u-123-t-pro-2026-08-28
  same key?       false

the period-scoped key the fix would use
  tick1 -> renewal-u-123-t-pro-2026-08-27T23:40:00.000Z
  tick2 -> renewal-u-123-t-pro-2026-08-27T23:40:00.000Z (identical: derived from the row, not the clock)

for contrast, step 2's remainder key (membership-billing.ts:1334) carries no date:
  -> remainder-u-123-t-pro - stable across any number of ticks
```

### The contrast inside the same file is the tell

| step | line | key | stable across ticks? |
|---|---|---|---|
| 2 — first-month remainder | `membership-billing.ts:1334` | `remainder-${user}-${tier}` | **yes** |
| 5 — monthly renewal | `membership-billing.ts:1497` | `renewal-${user}-${tier}-${UTC date}` | **no** |

Step 2 is the recoverable one: a failed state write leaves the row due, the next
tick re-charges with the *same* key, the provider dedupes, `success` comes back
true, and the update retries until it lands. It self-heals. Step 5 cannot,
because the key moves.

### How the row actually stays due across a UTC midnight

Three live mechanisms, in descending likelihood:

1. **The unchecked update fails** (defect *c*). Any Supabase error — a
   connection blip, an RLS change, a missing column after a partial migration —
   and the charge is silently unrecorded on the row.
2. **The function is killed mid-loop.** `maxDuration = 60`
   (`src/app/api/cron/sweep/route.ts:15`) with 13 jobs fanned out concurrently
   via `Promise.allSettled`, two of which page whole tables
   (`runAutomationSweep`). A kill between `chargeCard` resolving and the update
   committing leaves exactly this state — and the map already flags that a
   whole-function timeout raises no alert at all.
3. **`next_billing_at` lands in the 23:30–00:00 UTC band.** The sweep fires every
   30 minutes, so the natural next attempt is on the far side of midnight.

### Why this is latent today and armed tomorrow

Nothing double-charges right now, for a reason that is not a guard:
**neither shipped `BillingProvider` honours `idempotencyKey` at all.**

- `NoopBillingProvider.chargeCard` (`src/lib/billing-provider.ts:59-66`) —
  `void input;` then always `success: false`. This is the **default**
  (`getBillingProvider(process.env.BILLING_PROVIDER ?? "noop")`, line 101), so no
  membership money has ever moved through this sweep.
- `MockBillingProvider.chargeCard` (`src/lib/billing-provider.ts:84-99`) — reads
  only `paymentMethodRef`, and echoes the key back as
  `providerChargeId: \`mock_ch_${input.idempotencyKey}\``. It does not dedupe; it
  charges every time. (It also hard-throws in production, line 114 — correctly.)

So the key is currently decorative. The module's own header says the design goal
is that "the moment real processor credentials are added … charges start actually
moving money with **zero other code changes required**"
(`src/lib/billing-provider.ts:6-14`). That is exactly the problem: the day a real,
correctly-behaving processor is registered, this key becomes the sole barrier
between a member and a second full monthly charge — and it is a barrier with a
midnight-shaped hole in it. **This is a defect that arms itself on a config
change**, which is the dangerous kind.

### Impact

A member is charged the full monthly tier price twice in one billing period. The
store has no record that it happened: the row's `next_billing_at` says one thing,
`membership_billing_events` holds two `renewal` rows with
`status: "succeeded"`, and no alert fires on either the failed write or the
duplicate. The customer finds it on their statement before the store does.

### Reproduction

Once a processor that honours idempotency keys is wired (or with a mock upgraded
to dedupe on the key):

1. Seed a `customer_memberships` row: `veyra_membership_id` NULL,
   `status='active'`, `cancel_at_period_end=false`,
   `next_billing_at = '<today>T23:40:00Z'`.
2. Revoke `UPDATE` on `public.customer_memberships` for `service_role`
   (this simulates defect *c* deterministically).
3. `curl -H "Authorization: Bearer $CRON_SECRET" /api/cron/sweep` at 23:45Z.
   Confirm one charge at the provider and `next_billing_at` unchanged.
4. Restore the grant. `curl` again at 00:15Z.
5. `select event_type, amount_cents, provider_charge_id, created_at from
   membership_billing_events where user_id='…' and event_type='renewal';`
   → **two succeeded rows, two distinct `provider_charge_id`s**, one billing
   period. Two distinct keys is why the provider did not dedupe them.

Negative control for the same setup: repeat with step 2's remainder charge
(`intro_status='active'`, `intro_ends_at` in the past). Its key does not move, so
the provider dedupes and only one charge lands — proving the key, not the
missing claim, is what differs.

### Smallest safe root-cause fix

Three lines, in `src/lib/membership-billing.ts`:

```ts
// 1. Key the charge to the PERIOD, not the clock. row.next_billing_at is the
//    period being paid for; it is stable until the charge succeeds and is
//    unique per period.
idempotencyKey: `renewal-${row.user_id}-${tier.id}-${row.next_billing_at}`,

// 2. Stop discarding the write that closes the window.
const { error: advanceError } = await supabaseAdmin
  .from("customer_memberships")
  .update({ next_billing_at: nextBillingAt.toISOString(), … })
  .eq("user_id", row.user_id);
if (advanceError) {
  await recordSystemAlert({
    type: "membership_renewal_not_advanced",
    severity: "critical",
    // the card was charged and the row still reads due
  });
}
```

Apply the same `{ error }` check to step 2's update
(`membership-billing.ts:1338-1350`) — same unchecked pattern, and although its
stable key makes it self-healing, a silent failure there still costs a
`first_month_remainder` receipt.

A `.eq("next_billing_at", row.next_billing_at)` guard on the update would add
optimistic concurrency for free, making the write itself the claim.

**Do not** "fix" this by adding a claim column alone. The key is the guard that
survives a process death between the charge and the write; a claim column set
*before* the charge would strand the row instead. Both are wanted; the key is the
one that must be correct.

### CROSS-BLOCK

- `src/app/api/cron/sweep/route.ts` — no change needed, but its stated
  "every job is individually idempotent" invariant is the thing being violated.
  Block M should note it as a documented-contract breach, not just a bug.
- `src/lib/membership-billing.ts` is not on any block's primary-file list. Block D
  owns *membership tier change vs Veyra* in the same file — a fix here touches
  step 5 only and does not overlap that.
- Block A (concurrency/idempotency) will independently reach the missing-claim
  half of this. **The claim and the key are separate defects**; A's fix does not
  close the midnight hole and this one does not close the overlap race. Both are
  needed.

### Also checked, and clear

- `src/lib/membership-status.ts:53-64` `isMembershipActive` — instant comparison,
  `Number.isFinite` guard on a corrupt date, `nextBillingAt ?? renewsAt`
  fallback, 3-day grace with a stated rationale. **Correct.** The one wrinkle is
  that an unparseable date falls through to `return true` (membership stays
  active forever), which is the customer-safe direction but leaves a corrupt row
  invisible. Recorded, not a finding.
- Every date the sweep *shows a customer* already goes through the pinned-zone
  helper — `formatDisplayDate(row.next_billing_at, "long")` at
  `membership-billing.ts:1458` and `formatDisplayDate(nextBillingAt, "long")` at
  `:1521`. The renewal emails are correct; only the internal key is not. Good
  evidence the `format-date.ts` repair was applied deliberately here and merely
  missed cart recovery (K-01).
