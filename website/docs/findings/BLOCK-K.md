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
| K-03 | P1 | `BEHAVIORAL-TEST-PROVEN` | The membership renewal charge's only double-charge guard is keyed to the UTC calendar date, and the post-charge state write is unchecked |
| K-04 | P1 | `SOURCE-INSPECTED` | The affiliate link records IP, UA and campaign parameters and sets a 30-day identifier before consent is asked, contradicting three published promises |
| K-05 | P1 | `BEHAVIORAL-TEST-PROVEN` | The 72h "last chance" recovery email ships a dead coupon code, and prints the literal string `SEE PREVIOUS EMAIL` |
| K-06 | P2 | `BEHAVIORAL-TEST-PROVEN` | One config module, ten numeric readers, three idioms, four hand-copies of the same guard — and the unguarded one controls coupon money |
| K-07 | P1 | `BEHAVIORAL-TEST-PROVEN` | The "one skip per paid period" cap allows two skips, in exactly the window the reminder email targets |
| K-08 | P2 | `BEHAVIORAL-TEST-PROVEN` | The birthday bonus is decided in UTC, so a Pacific member who opens their account on their birthday never gets it |
| K-09 | P2 | `BEHAVIORAL-TEST-PROVEN` | Store credit is granted and spent on UTC calendar months, so it dies at 7 PM ET on the last day |
| K-10 | P3 | `BEHAVIORAL-TEST-PROVEN` | The storefront offers bar says "Ends tonight" for a coupon that expires that morning, and for one a year away |
| K-11 | P2 | `BEHAVIORAL-TEST-PROVEN` | `dollarsToPoints` floors a float, so 4.6% of points redemptions debit one point less than the discount given |
| K-12 | P1 | `SOURCE-INSPECTED` | Store credit is decided at quote time and debited at settlement time, so a manual-payment order debits a different month — or nothing |
| K-13 | P1 | `SOURCE-INSPECTED` | The "15-minute" inventory hold is really up to 45 minutes, and every way it can fail reports success |
| K-14 | P1 | `SOURCE-INSPECTED` | Maintenance mode 503s the entire cron sweep and the one-click unsubscribe in already-delivered marketing email |
| K-15 | P1 | `SOURCE-INSPECTED` | Rate limiting is a read-then-write with no claim and fails open silently, so the throttle does not hold under concurrent traffic |
| K-16 | P1 | `SOURCE-INSPECTED` | Three live production ad pixel IDs are hardcoded as env fallbacks with no `VERCEL_ENV` guard, so a preview deployment reports into the real ad accounts |
| K-17 | P1 | `SOURCE-INSPECTED` | Cancelling a paid order permanently destroys its stock, in the one case the codebase's own comment says should restock |
| K-18 | P1 | `SOURCE-INSPECTED` | Four compliance attestations are collected and none is durably recorded on the card lane |
| K-19 | P1 | `SOURCE-INSPECTED` | Every call to the payment processor has no timeout, while the ad pixels and the label printer all have one |
| K-20 | P2 | `SOURCE-INSPECTED` | Four tables are written and never read, and two double the visitor data retained for no benefit |
| K-21 | P1 | `SOURCE-INSPECTED` | The homepage hardcodes the "99%" the trust-claims module says never appears, and checkout makes a different fulfilment promise from the rest of the site |
| K-22 | P2 | `BEHAVIORAL-TEST-PROVEN` | A coupon that loses the discount competition is still recorded and still redeemed, burning a one-shot code for nothing |
| — | none | `SOURCE-INSPECTED` | *Dead-code sweep part 2: API routes. Two money-spending orphans investigated and cleared — recorded so the next session does not re-derive the false start.* |

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

---

## K-04 — The affiliate link records IP, user agent and campaign parameters and sets a 30-day identifier before consent is asked, contradicting three specific promises in the store's own published policies

**Grade:** `SOURCE-INSPECTED` (complete chain, every step quoted) · **Severity:** P1
· **Status:** OPEN
**Area:** legal/policy × privacy

### Why this is a defect and not a preference

The audit standard's step 2 says intended behaviour comes from *authoritative*
evidence, including **the owner's stated business rules**. Here the owner's rule
is published, in writing, on the storefront, and it is falsifiable. This finding
is the code contradicting the store's own Cookie Policy and Privacy Policy — not
a view about what consent ought to look like.

### What the store promises

`src/lib/legal-content.ts`, the `cookies` default body:

> **Essential** — cart contents, checkout state, login sessions, and your age
> confirmation. These are always on; the store cannot work without them.

> **Analytics — only if you accept.** A random visitor and session identifier
> stored in your browser, **any campaign parameters from the link you arrived
> through**, and Vercel Analytics…

> Choosing Decline on the banner **stops all non-essential storage; nothing in
> the analytics category is created.**

`src/lib/legal-content.ts`, the `privacy` default body:

> If you accept analytics (see below), we also generate a random visitor and
> session identifier stored in your browser, and **record any campaign parameters
> present in the link you arrived through (for example utm_source, utm_medium,
> utm_campaign…)**

> Analytics is off until you accept it. **If you decline, no analytics identifiers
> are created and no analytics events are sent.**

### What the code does

`src/app/r/[code]/route.ts` — the affiliate/ambassador entry point, and the
highest-traffic acquisition path the store has:

```ts
const ipAddress = getRequestIpAddress(request);
…
await Promise.all([
  supabaseAdmin.from("partner_clicks").insert({
    …
    utm_source:   url.searchParams.get("utm_source"),
    utm_medium:   url.searchParams.get("utm_medium"),
    utm_campaign: url.searchParams.get("utm_campaign"),
    referrer:     request.headers.get("referer"),
    user_agent:   request.headers.get("user-agent"),
    ip_address:   ipAddress,
  }),
  supabaseAdmin.from("referrals").insert({ /* the same six fields again */ }),
]);

response.cookies.set(REFERRAL_COOKIE_NAME, resolved.currentCode, {
  path: "/", maxAge: REFERRAL_COOKIE_MAX_AGE /* 30 days */,
  sameSite: "lax", secure: …, httpOnly: false,
});
```

There is **no consent check on this route**. Three promises broken:

1. **"any campaign parameters from the link you arrived through" — only if you
   accept.** `utm_source`, `utm_medium` and `utm_campaign` are read off the
   arriving link and written to two tables, unconditionally. Both policies name
   these exact parameters as the accept-gated category.
2. **`vl_referral_code` is a 30-day browser identifier that is not on the
   essential list.** The Cookie Policy enumerates essential as cart, checkout,
   login and age confirmation. An affiliate-attribution cookie is none of those.
   `httpOnly: false` means any script on the page can read it too.
3. **The raw IP address is stored in the store's own database.** The Privacy
   Policy's "Information we collect" says "limited technical data such as device
   type, pages viewed, and referring website" — IP is mentioned only as something
   *TikTok and Snap* receive, never as something the store itself retains.

### The ordering makes Decline unable to help

This is not "a check was forgotten". The consent decision is
**structurally invisible to the server**:

- `src/components/cookie-consent.tsx:47` — `dismiss()` writes
  `window.localStorage.setItem(STORAGE_KEY, choice)` and dispatches a browser
  event. That is the *entire* persistence.
- A repo-wide grep for a server-side read of the consent value returns nothing:
  every one of the six `vl_cookie_consent` references is a browser component
  (`consented-analytics`, `reddit-pixel`, `tiktok-pixel`, `snap-pixel`,
  `cookie-consent`, `tracking-health-browser`). `localStorage` does not travel
  with a request, so **no route handler can read consent, ever.**

So the sequence for a visitor who will decline is:

1. Ambassador shares `…/r/BRUTUS`.
2. The visitor clicks. Before a single pixel of the site renders, the redirect
   handler writes their IP, UA, referrer and UTM parameters to `partner_clicks`
   **and** `referrals`, and sets a 30-day cookie.
3. They land on `/products` and see the banner **for the first time**.
4. They press **Decline**. `dismiss("declined")` writes one localStorage key.
   It does not clear `vl_referral_code` — and could not delete the two database
   rows even if it tried, because there is no server call on that path.

The banner's own comment states the standard it believes it meets — *"nothing
loads before a choice is made"* (`cookie-consent.tsx:73`). On the affiliate path
that is already untrue by the time the banner mounts.

### Impact

The store's published Privacy Policy and Cookie Policy are, as written, false for
every visitor who arrives through an ambassador link — which is the traffic the
affiliate programme exists to generate. For a business whose differentiator is
compliance posture, a demonstrably inaccurate privacy disclosure is the expensive
kind of exposure: it is self-documenting, it is in the store's own words, and the
contradicting code is four lines of a public route.

Secondary: `vl_referral_code` is `httpOnly: false` with a 30-day life, so the
ambassador attribution a customer carries is readable and writable by any script
that runs on the page.

### Reproduction (browser, no database needed for steps 1–4)

1. Clear site data. In DevTools → Application, confirm no `vl_referral_code`
   cookie and no `vl_cookie_consent` key.
2. Navigate directly to `/r/<a live code>?utm_source=probe&utm_campaign=probe`.
3. Before touching the banner, read Application → Cookies:
   **`vl_referral_code` is already set**, `HttpOnly` unchecked, expiry ~30 days.
4. Press **Decline**. Re-read cookies: `vl_referral_code` is **still there**.
   `localStorage["vl_cookie_consent"]` reads `"declined"`.
5. With database access: `select ip_address, user_agent, referrer, utm_source,
   utm_campaign, created_at from partner_clicks order by created_at desc limit 1;`
   and the same against `referrals` → two rows carrying the IP and the campaign
   parameters, written before consent was asked and surviving the decline.

### Smallest safe root-cause fix

The root cause is that consent lives somewhere the server cannot see it. Two
parts, and part (a) is the one that matters:

**(a) Make consent server-readable.** Have `dismiss()` also set a first-party
cookie (`vl_cookie_consent`, `httpOnly: false` so the existing browser
components keep working unchanged, `sameSite: "lax"`, 12 months). Then
`/r/[code]` — and any future server route with the same question — can read it.

**(b) Split the route's two jobs by what they actually are.** Attribution
(`vl_referral_code` and the ambassador credit) is arguably contractual rather than
analytic; the *telemetry* (`ip_address`, `user_agent`, `referrer`, and the three
UTM columns) plainly is not. Gate the telemetry columns on the consent cookie and
write the click row with them NULL when consent is absent or declined — the
ambassador still gets their click credit, which is the business purpose, and the
promise is kept.

Whichever way (b) is decided, **the policy text and the code must be made to say
the same thing.** If the owner wants attribution to be unconditional, that is a
legitimate product decision — but then the Cookie Policy's essential list must name
`vl_referral_code`, and the Privacy Policy must stop conditioning campaign-parameter
capture on acceptance. Silence is the only option that is not available.

### Regression test to write

A route-level test asserting that with no consent cookie, the `partner_clicks`
insert payload has `ip_address`, `user_agent`, `referrer`, `utm_*` all null, and
with `vl_cookie_consent=accepted` they are populated. Negative control: remove
the gate and confirm the first assertion fails on the populated `ip_address`, not
on a missing table.

Plus a **source-text test** — this codebase already uses that pattern (the banner
comment describes the pixel-naming source test that caught a copy regression).
Assert that every identifier the code sets as a cookie appears somewhere in the
`cookies` policy default. That makes the two artefacts fail together in future.

### CROSS-BLOCK

- `src/app/r/[code]/route.ts` — **Block A+B.** This is the affiliate lane. The
  same file already carries A+B's known non-transactional double-write defect
  (`partner_clicks` and `referrals` in one `Promise.all`, no transaction). A+B
  should apply both changes in one pass rather than two sessions touching it.
- `src/components/cookie-consent.tsx` — unowned; the consent-cookie change (a)
  can land here.
- `src/lib/legal-content.ts` — unowned, Block K's. Whichever way (b) resolves,
  the policy text edit belongs to this file.

### Also checked, and clear — the browser-side gating is genuinely correct

Worth recording as a negative control, because it makes the gap above sharper
rather than looking like a general slackness:

- `src/components/site-analytics-tracker.tsx:73` and `:141` — both entry points
  early-return unless `localStorage["vl_cookie_consent"] === "accepted"`.
- `tiktok-pixel.tsx:25`, `snap-pixel.tsx:38`, `reddit-pixel.tsx:48`,
  `consented-analytics.tsx:21` — all gate on the same key. None loads pre-consent.
- `cookie-consent.tsx:16-22` — if `localStorage` throws, the banner does not
  render and no choice is stored, so consent is never `"accepted"` and every
  pixel stays off. **Fails closed**, correctly.
- Accept and Decline carry equal visual weight and the policy is one tap away.

The browser half of this system was built carefully. The server half was never
told the decision exists.

---

## K-05 — The 72h "last chance" recovery email ships a dead coupon code, and the code it prints is the literal string `SEE PREVIOUS EMAIL`

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** OPEN
**Area:** time/date boundaries × background jobs

### What is wrong

`src/lib/cart-recovery.ts:316-321`, the final stage of the abandoned-cart sequence:

```ts
if (config.t72hEnabled && elapsedMs >= 72 * HOUR_MS) {
  const alreadyHasCoupon = await hasSentStage(row.id, "t24h");
  const coupon = alreadyHasCoupon ? null : await mintCartRecoveryCoupon(…);

  if (alreadyHasCoupon || coupon) {
    const couponForEmail = coupon ?? { code: "SEE PREVIOUS EMAIL", expiresAt: new Date(now + config.couponExpirationHours * HOUR_MS).toISOString() };
```

When the t24h stage already ran — the normal path — the t72h stage deliberately
does not mint a second code. That much is right: one cart, one code. But instead
of *loading* the code it is referring to, it **invents a placeholder**:

- **The code becomes the literal string `"SEE PREVIOUS EMAIL"`**, rendered
  straight into the template as if it were a coupon:
  `Use code <strong>${escapeHtml(input.couponCode)}</strong> for 5% off`
  (`src/lib/email/templates.ts:1141`). The customer is shown
  **"Use code SEE PREVIOUS EMAIL"**.
- **The expiry is fabricated from the sweep's clock**, `now + couponExpirationHours`,
  with no reference to the coupon row that actually exists. The email states an
  expiry that no coupon in the database has.

### The default configuration puts the real coupon's death on the exact tick that sends this email

This is the part that turns an ugly placeholder into a broken flow. Three
independent numbers line up:

- the t24h stage fires at `elapsedMs >= 24h` (`cart-recovery.ts:286`)
- the t72h stage fires at `elapsedMs >= 72h` (`cart-recovery.ts:316`) — **48h later**
- `couponExpirationHours` defaults to **48** (`src/lib/admin-control.ts:249`)

and the sweep runs on a fixed `*/30 * * * *` schedule (`website/vercel.json`), so
both stages land on cron ticks exactly 48h apart. Mint + 48h **is** the t72h tick.

### Evidence — probe, run in this session

```
$ node t72.mjs
cart first_seen_at         2026-08-20T09:07:00.000Z
t24h mail + coupon minted  2026-08-21T09:30:00.000Z
  real coupons.ends_at     2026-08-23T09:30:00.000Z
t72h 'last chance' mail    2026-08-23T09:30:00.000Z
  email says expires       2026-08-25T09:30:00.000Z
  email says code is       "SEE PREVIOUS EMAIL"

real coupon still alive when the last-chance mail is sent? false (margin: 0h)
overstatement in the email: 48 hours
```

The gate that rejects it is real: `src/lib/coupons.ts:157` —
`if (data.ends_at && new Date(data.ends_at).getTime() < now) throw new Error("This coupon has expired")`.

The margin is zero, not negative, so whether the code is dead *at* the send
instant or dies seconds later depends on where each cart sits in the sweep's
loop. It is a coin flip with no upside: every recipient's code is dead well
before anyone opens a marketing email, and the mail they are reading promises
them another 48 hours.

### Scope — when this does and does not bite

| `couponExpirationHours` | real code at the t72h send | email claims |
|---|---|---|
| 24 | dead for 24h already | +24h |
| **48 (default)** | **dies on this exact tick** | **+48h** |
| 72 | alive, 24h left | +72h — still false |

The fabricated expiry is wrong at every setting. The *dead code* is what the
default produces.

The bug needs `t24hEnabled` true (the default). If the t24h stage is disabled, or
its send failed — `reserveAndSendStage` deletes its reservation row on failure
(`cart-recovery.ts:215-218`) — then `hasSentStage` is false, a fresh coupon is
minted, and the t72h email is correct. So the defect is confined to the happy
path, which is nearly every cart.

### Impact

The last and highest-intent stage of the recovery sequence is dead on arrival.
Every recipient who acts on it either types `SEE PREVIOUS EMAIL` into the coupon
box, or digs out the real `SAVE-…` code from 48 hours earlier and gets
*"This coupon has expired"* at checkout. The store paid to track the cart and
send four emails and cannot honour the offer in the last one.

The stated expiry is also a written, dated promise in a transactional email that
the store will refuse. Combined with K-02 (the same two templates advertise a
hardcoded "5% off" regardless of the configured discount), every substantive
claim in this email — the code, the discount and the deadline — can be wrong at
the same time.

### Reproduction

1. Defaults: `t24hEnabled`, `t72hEnabled` true, `couponExpirationHours` 48
   (`src/lib/admin-control.ts:243-250`).
2. Seed `abandoned_carts` with `status='active'` and
   `first_seen_at = now() - interval '73 hours'`, one item, a real email.
3. `curl -H "Authorization: Bearer $CRON_SECRET" /api/cron/sweep`.
4. Read the delivered t72h mail: the code reads **SEE PREVIOUS EMAIL** and the
   expiry is ~48h in the future.
5. `select code, ends_at from coupons where source='cart_recovery' and assigned_email='…';`
   → `ends_at` is ~48h **earlier** than the email's date, or absent entirely if
   step 2 skipped the t24h send.
6. Apply that `SAVE-…` code at checkout → *"This coupon has expired"*.

### Smallest safe root-cause fix

Load the coupon instead of inventing it. `reserveAndSendStage` already threads a
`coupon_id` (`input.couponId ?? null`) into `abandoned_cart_emails`; the t24h call
site simply does not pass it. Pass it there, then in the t72h branch read that row
back and use its real `code` and `ends_at`.

If the loaded coupon has already expired — which under the default config it
always has — mint a fresh code for the final email rather than pointing at a dead
one. That is what the customer is being promised, and it costs one INSERT.

**Never synthesise an expiry the database does not hold.** The placeholder string
`"SEE PREVIOUS EMAIL"` should not survive the fix in any branch; if no coupon can
be resolved, send the stage without a coupon block at all.

### Regression test to write

Drive `runAbandonedCartSweep` against a stubbed Supabase with one cart at
`first_seen_at = now - 73h` and an existing t24h `abandoned_cart_emails` row, and
assert the rendered t72h body contains the real `SAVE-…` code and an expiry
strictly in the future. Negative control: restore the
`?? { code: "SEE PREVIOUS EMAIL", … }` fallback and confirm the test fails on the
literal string — not on a missing stub.

### CROSS-BLOCK

- `src/lib/email/templates.ts:1127-1147` — **Block C.** Carrying the real
  `discountPercent` through (K-02) needs a template-signature change here. The
  expiry fix itself does not require it.
- `src/lib/cart-recovery.ts` is unowned; the fix lands there.

---

## K-06 — One config module, ten numeric readers, three idioms, four hand-copies of the same guard — and the one reader with no guard controls coupon money

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P2 · **Status:** OPEN
**Area:** environment/config drift

### What is wrong

`src/lib/admin-control.ts` resolves every business constant the store runs on. It
coerces admin-supplied values to numbers in **ten** places, using **three**
different idioms with three different answers to the same question: *what does a
blank field mean?*

Four readers answer it correctly, and each does so by declaring its **own local
copy** of the identical helper — with its own comment explaining the hazard:

```ts
// getBulkSavingsControlConfig:204-210
// Blank = default (Number("") is 0 — a blank tier threshold must not
// unlock bulk savings at $0).
const num = (value: unknown, fallback: number) => {
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
```

The same block, re-typed, appears at `getProfitSettings:635-641` ("a blank
worst-case unit cost must never become $0 — that would defang the profit guard"),
at `getShippingConfig:702-706` ("a blank flat rate silently became $0 and made
every order ship free"), and as `clampPercent:552-558` ("would silently zero out
a referral/commission percent").

The hazard was found four separate times, understood four separate times, and
fixed four separate times — **and never hoisted**. That is precisely why the
fifth reader misses it.

### The table

| reader | line | idiom | blank `""` → | `"abc"` → | `"-12"` → |
|---|---|---|---|---|---|
| `getBulkSavingsControlConfig` | 204-210 | local `num()` | default ✅ | default ✅ | default ✅ |
| `getProfitSettings` | 635-641 | local `num()` | default ✅ | default ✅ | default ✅ |
| `getShippingConfig` | 702-706 | local `num()` | default ✅ | default ✅ | default ✅ |
| `clampPercent` (referral, ambassador) | 552-558 | shared helper | default ✅ | default ✅ | default ✅ |
| `getSalesTaxSettings` rate overrides | 511-513 | `isFinite && 0..25` | skipped ✅ | skipped ✅ | skipped ✅ |
| `getSubscribeSaveConfig` | 408-409 | `Number(x ?? d) \|\| d` | default ✅ | default ✅ | **−12** ⚠ |
| `getWelcomeOffer` | 443 | `Number(x ?? d) \|\| d` | default ✅ | default ✅ | **−12** ⚠ |
| `resolvePaymentMethod` order | 293 | `Number(x) \|\| base` | base ✅ | base ✅ | **−12** ⚠ |
| **`getCardProcessingFeeConfig`** | **332** | **`Number(x) \|\| 0`** | **0** ❌ | **0** ❌ | **−12** ⚠ |
| **`getCartRecoveryControlConfig`** | **261-262** | **`Number(x ?? d)`** | **0** ❌ | **NaN** ❌ | **−12** ❌ |

### Evidence — probe, run in this session

```
$ TZ=UTC npx vitest run scratchpad/k-config.test.ts
  getCartRecoveryControlConfig:261-262   Number(x ?? 48)           -> 0
  getCardProcessingFeeConfig:332         Number(x) || 0            -> 0
  getSubscribeSaveConfig:408             Number(x ?? 10) || 10     -> 10
  getWelcomeOffer:443                    Number(x ?? 10) || 10     -> 10
    getShippingConfig  (local num())     blank -> fallback         -> 48
  clampPercent:552 (referral/ambassador) blank -> fallback         -> 10

  stored ""          unguarded=0      guarded=48
  stored "abc"       unguarded=NaN    guarded=48
  stored "-12"       unguarded=-12    guarded=48
  stored "3.5"       unguarded=3.5    guarded=3.5
  stored null        unguarded=48     guarded=48
  stored undefined   unguarded=48     guarded=48

  couponExpirationHours=48    ends_at=2026-08-28T10:00:00.000Z  -> valid
  couponExpirationHours=0     ends_at=2026-08-26T10:00:00.000Z  -> dead on creation
  couponExpirationHours=-12   ends_at=2026-08-25T22:00:00.000Z  -> REFUSED at checkout
  couponExpirationHours=NaN   THROWS RangeError: Invalid time value

 Test Files  1 passed (1)   Tests  3 passed (3)
```

### Nothing upstream catches it either

`??` only catches `null`/`undefined`, so the guard has to be at the read — and
the write side has none:

```ts
// src/app/api/admin/cart-recovery/settings/route.ts:21-39
const entries: Array<[string, unknown]> = [ …, ["coupon_expiration_hours", body.couponExpirationHours] ];
for (const [key, value] of entries) {
  if (value === undefined) continue;
  await upsertControlValue({ section: "cart_recovery", key, value, … });
}
```

No type check, no range check, `unknown` all the way to storage. And the admin
input has no `min`:

```tsx
// src/components/admin-cart-recovery-client.tsx:183-189
<input type="number"
  value={config.couponExpirationHours}
  onChange={(e) => setConfig((prev) => ({ ...prev, couponExpirationHours: Number(e.target.value) }))} />
```

Clearing the box to retype yields `Number("")` → `0`. Three layers, no guard in
any of them. Compare `src/lib/admin-coupons.ts:95-104`, which *does* validate its
inputs on write — the pattern exists in the codebase.

### Impact — what each bad value actually costs

**`couponExpirationHours`**

- **`0`** — every recovery coupon's `ends_at` is its own creation instant. The
  emails keep sending, the `coupons` rows keep appearing and read `active: true`,
  and every single one is refused at checkout by `src/lib/coupons.ts:157`. The
  whole abandoned-cart discount programme is dead and **looks healthy from the
  admin**; the only visible symptom is an unexplained flatline in redemptions.
- **`-12`** — same, with `ends_at` already in the past.
- **non-numeric** — `new Date(Date.now() + NaN).toISOString()` **throws a
  `RangeError` at `cart-recovery.ts:128`**, inside the per-cart loop, before the
  insert. Nothing catches it in `mintCartRecoveryCoupon` or
  `runAbandonedCartSweep`, so the whole job rejects for **every remaining cart**,
  every tick, forever.

  *Correction to the Phase 1 map:* it predicted `new Date(Date.now()+NaN)` would
  produce "an invalid `ends_at` → the coupon INSERT fails → `mintCartRecoveryCoupon`
  returns null → the t24h stage silently never sends." It does not reach the
  insert. `.toISOString()` throws first. The consequence is worse in blast radius
  (the entire job dies, not one stage) but **better in visibility**: the rejection
  is caught by `Promise.allSettled` at `src/app/api/cron/sweep/route.ts:81` and
  raises `recordSystemAlert({ type: "cron_sweep_failed", severity: "critical" })`
  (line 92-101), which emails the operator. This is the one failure in the block
  that is genuinely loud.

**`discountPercent`** — blank → `0`. Coupons mint at `discount_value: 0` while the
email (K-02) still promises "5% off". The customer applies a valid code and gets
nothing off, which is the worst of both: not an error they can report, just a
discount that silently is not there.

**`getCardProcessingFeeConfig.percentage`** — the inverse defect, and a revenue
one. `Number(o.percentage) || 0` returns **0**, not the coded default of `3`
(`src/lib/payment-methods.ts:101-106`). The write path has the same idiom
(`percentage: Number(fee.percentage) || 0`,
`src/components/admin-payment-settings-client.tsx:88`), so a blank is coerced to
zero on save *and* on read, and the resulting `0` is indistinguishable from a
deliberate "no surcharge". `enabled` stays `true`, so the fee is on and worth
nothing: **the store stops collecting its 3% card surcharge on every card order
and nothing anywhere says so.**

### Reproduction

1. `/admin/cart-recovery` → clear **Coupon expiration (hours)** → Save.
2. `select metadata->>'value' from admin_audit_logs where action='admin_control_upsert'
   and target_table='cart_recovery' and target_id='coupon_expiration_hours'
   order by created_at desc limit 1;` → `0` (or `""`).
3. Age a cart past 24h, run the sweep.
4. `select code, discount_value, ends_at, created_at from coupons
   where source='cart_recovery' order by created_at desc limit 1;`
   → `ends_at` equals `created_at`.
5. Apply that code at checkout → *"This coupon has expired"*.

For the NaN variant, insert an `admin_control_upsert` row with
`metadata.value = 'abc'` directly and confirm `system_alerts` gains a
`cron_sweep_failed` row naming `cart_recovery` on the next tick.

For the card fee: `/admin/payments` → clear **Fee percentage (%)** → Save → place
a card order → `select card_processing_fee from orders order by created_at desc limit 1;`
→ `0`, with `enabled` still true.

### Smallest safe root-cause fix

**Hoist the helper that already exists four times.** One module-level function in
`src/lib/admin-control.ts`:

```ts
/** Blank means "keep the default" — Number("") is 0, which has silently zeroed
 *  a shipping rate, a profit floor, a bulk tier and a commission percent. */
function controlNumber(value: unknown, fallback: number, opts?: { max?: number }): number {
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return opts?.max !== undefined && parsed > opts.max ? fallback : parsed;
}
```

Point all ten readers at it, deleting the four hand-copies. Then:

- `getCartRecoveryControlConfig:261-262` — use it, with a `>= 1` floor on
  `couponExpirationHours` (a zero-hour coupon has no valid meaning).
- `getCardProcessingFeeConfig:332` — fall back to
  `DEFAULT_CARD_PROCESSING_FEE.percentage`, not `0`. To keep a *deliberate* zero
  working, distinguish it at the write: send `null` for blank and a real `0` for
  an entered zero, rather than collapsing both with `|| 0`.
- Add write-side validation to
  `src/app/api/admin/cart-recovery/settings/route.ts` (400 on non-finite,
  negative or non-integer), mirroring `admin-coupons.ts:95-104`.
- Add `min="1"` to the hours input and `min="0"` to the discount input as the
  third layer.

### Regression test to write

Table-driven over every reader in `admin-control.ts`: for each, feed
`""`, `"abc"`, `"-1"`, `null`, `undefined`, `"0"` and `"3.5"` through a stubbed
snapshot and assert the resolved value is either the coded default or the
explicitly-entered number — never `0`, never `NaN`, never negative. **A new
reader added later without the guard fails this test**, which is the property
worth buying: the four hand-copies prove that individual fixes do not hold.

Negative control: revert one reader to `Number(x ?? d)` and confirm exactly the
blank and `"abc"` rows fail.

### CROSS-BLOCK

- `src/app/api/admin/cart-recovery/settings/route.ts` — **Block I** owns
  `src/app/api/admin/**`. The write-side validation belongs to them; the read-side
  clamp in `src/lib/admin-control.ts` and the client `min` attributes do not.
- `src/lib/admin-control.ts` is read by nearly every block. The hoist touches ten
  call sites in one file — **best done once, by block M, after the other blocks
  have landed**, rather than by whoever gets there first.

---

## K-07 — The "one skip per paid period" cap allows two skips, and the window in which it does is exactly the window the reminder email targets

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P1 · **Status:** OPEN
**Area:** time/date boundaries (membership)

### The invariant this breaks

`src/lib/membership-billing.ts:1023-1026` states it plainly:

> Cap to **ONE skip per paid period**. Without this a member could POST skip in a
> loop, pushing `next_billing_at` years out while staying "active" — keeping all
> perks and monthly store credit forever for a single charge.

### What is wrong — the threshold and the step disagree by three days

```ts
// membership-billing.ts:1027  — the cap
if (existing.next_billing_at && new Date(existing.next_billing_at as string).getTime() > now.getTime() + 33 * ONE_DAY_MS) {
  throw new Error("You've already skipped a charge this cycle …");
}
// membership-billing.ts:1046-1053  — the advance
const base = existing.next_billing_at ? new Date(existing.next_billing_at as string) : now;
const from = base.getTime() <= now.getTime() ? now : base;
… : new Date(from.getTime() + 30 * ONE_DAY_MS);
```

The refusal threshold is **33** days; the step is **30**. The comparison is a
strict `>`. So a first skip from any `next_billing_at ≤ now + 3d` lands on
`≤ now + 33d`, which does **not** satisfy `> now + 33d`, and a second skip is
accepted.

### The boundary is not arbitrary — it is the reminder window, exactly

`runMembershipBillingSweep:1243` — `const in3Days = new Date(now.getTime() + 3 * ONE_DAY_MS);`
Step 4 emails *"your renewal is in 3 days"* for exactly `next_billing_at ≤ now + 3d`.

Solving the cap algebraically: a double skip needs `base + 30d ≤ now + 33d`, i.e.
`base ≤ now + 3d`. **The same bound.** Every member who receives the renewal
reminder is, at that moment, in the state where Skip works twice — and the
reminder is what prompts them to click Skip.

### Evidence — probe, run in this session

```
$ TZ=UTC npx vitest run scratchpad/k-skip.test.ts
  next_billing_at = now +  0d (2026-09-01T12:00:00.000Z) -> 2 skips accepted
  next_billing_at = now +  1d (2026-09-02T12:00:00.000Z) -> 2 skips accepted
  next_billing_at = now +  2d (2026-09-03T12:00:00.000Z) -> 2 skips accepted
  next_billing_at = now +  3d (2026-09-04T12:00:00.000Z) -> 2 skips accepted
  next_billing_at = now +  4d -> 1 skip accepted
  next_billing_at = now +  7d -> 1 skip accepted
  next_billing_at = now + 10d -> 1 skip accepted
  next_billing_at = now + 29d -> 1 skip accepted
  Step 4 emails 'renewal in 3 days' for next_billing_at <= 2026-09-04T12:00:00.000Z
  double-skip is possible for       next_billing_at <= 2026-09-04T12:00:00.000Z
  paid period ended        2026-09-04T12:00:00.000Z
  after skip #1            2026-10-04T12:00:00.000Z  (+33d from now)
  after skip #2            2026-11-03T12:00:00.000Z  (+63d from now)
  perks retained for       60 days beyond the paid period, on one charge

 Test Files  1 passed (1)   Tests  4 passed (4)
```

The 4-days-out rows are the control: the cap works exactly as designed there,
which is what makes this an off-by-three rather than a missing guard.

### Impact

Sixty days of a paid membership on one charge. `status` stays `"active"`
throughout, so `isMembershipActive` (`src/lib/membership-status.ts:51-63`) keeps
every perk on: member pricing, free/priority shipping, the tier's bonus points
rate.

And the store credit the cap was explicitly written to protect keeps flowing.
`grantMonthlyStoreCreditSweep` filters on nothing but
`.eq("status", "active")` and `.not("next_billing_at", "is", null)`
(`membership-billing.ts:1214, 1218`) — no billing-anniversary check — so the
deferred member collects **two extra monthly grants** across those sixty days.
On a tier with `monthly_store_credit_cents = 7500` that is $150 of store credit
plus two months of perks for one month's payment.

Discovery cost: click Skip twice on the reminder email. Repeatable every cycle,
because once the charge finally lands the member is back in the same state.

### Reproduction

1. Seed an active monthly membership, `veyra_membership_id` NULL (so the Veyra
   branch at `:1034-1044` is skipped and the local `+30d` arithmetic is used),
   `cancel_at_period_end` false, `next_billing_at = now() + interval '2 days'`.
2. `POST /api/membership/skip` as that customer → 200, `next_billing_at` ≈ +32d.
3. `POST /api/membership/skip` again → **200**, `next_billing_at` ≈ +62d.
4. Third call → 400 *"You've already skipped a charge this cycle"*.
5. Run the sweep twice across two UTC month rollovers and confirm two additional
   `store_credit_ledger` grant rows for that user.

### Smallest safe root-cause fix

Make the cap agree with the step and close the boundary:

```ts
if (existing.next_billing_at && new Date(existing.next_billing_at as string).getTime() >= now.getTime() + 30 * ONE_DAY_MS) {
```

`>= now + 30d` cannot be re-satisfied by `base + 30d` for any `base ≥ now`, which
is the property the 33-day version lacks.

Better, and worth doing instead: gate on a **per-period marker** rather than a
date distance — a `skipped_at` (or `skips_this_period`) column cleared by the
renewal in Step 5 (`membership-billing.ts:1500-1511`). A date-distance heuristic
will keep being fragile every time the cycle length or the reminder window moves,
and the two constants live 200 lines apart with nothing tying them together.

Note the Veyra branch (`:1050-1053`) prefers Veyra's returned date over the local
`+30d`, so for Veyra-backed memberships the advance is whatever Veyra says. The
cap at `:1027` is still local and still 33 days, so the same off-by-three applies
with an even less predictable step. Fixing the cap fixes both.

### Regression test to write

Property test over `next_billing_at ∈ {now-1d … now+40d}`: assert the number of
accepted consecutive skips is **exactly 1** for every value. Negative control:
restore `> now + 33d` and confirm the `now+0d … now+3d` rows fail with 2.

Add an assertion tying the two constants together — that the cap's threshold is
`≥` the skip step — so the next person to change either notices.

### CROSS-BLOCK

None. `src/lib/membership-billing.ts` `skipNextBilling` is not on another block's
primary-file list. Block G+H will exercise membership in the browser and should
be told to try Skip twice.

---

## K-08 — The birthday bonus is decided in UTC, so a Pacific member who opens their account on their actual birthday never gets it

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P2 · **Status:** OPEN
**Area:** time/date/timezone

### What is wrong

`src/lib/membership.ts:606-608`:

```ts
const today = new Date();
const birthdayDate = new Date(birthday);
const isBirthdayToday = today.getUTCMonth() === birthdayDate.getUTCMonth()
                     && today.getUTCDate() === birthdayDate.getUTCDate();
```

The stored side is fine: the column is `birthday date`
(`src/lib/sql/membership-rewards.sql:80`) and the API validates
`^\d{4}-\d{2}-\d{2}$` (`src/app/api/account/birthday/route.ts:17`), so
`new Date("1990-05-14")` is UTC midnight and `getUTCMonth/getUTCDate` read it
back correctly. **The bug is entirely on the `today` side**: the member's *now*
is bucketed into a UTC calendar day while every other date in this codebase is
pinned to `America/New_York` (`src/lib/format-date.ts:25`).

The year guard has the same defect — `const currentYear = today.getUTCFullYear();`
(`:613`), checked against `birthday_bonus_year` at `:620`.

### Evidence — probe, run in this session

```
$ TZ=UTC npx vitest run scratchpad/k-bday.test.ts
  2026-05-14T16:00:00Z  ET May 14, 2026, 12:00 PM   PT May 14, 2026, 9:00 AM    -> true
  2026-05-15T00:30:00Z  ET May 14, 2026, 8:30 PM    PT May 14, 2026, 5:30 PM    -> false
  2026-05-15T02:00:00Z  ET May 14, 2026, 10:00 PM   PT May 14, 2026, 7:00 PM    -> false
  2026-05-15T06:30:00Z  ET May 15, 2026, 2:30 AM    PT May 14, 2026, 11:30 PM   -> false
  2026-05-14T02:00:00Z  ET May 13, 2026, 10:00 PM -> true
  Eastern  eligible from May 13, 2026, 8:00 PM to May 14, 2026, 7:59 PM
  Pacific  eligible from May 13, 2026, 5:00 PM to May 14, 2026, 4:59 PM

 Test Files  1 passed (1)   Tests  3 passed (3)
```

Rows 2–4 are still the member's birthday in their own zone, and the check returns
false. Row 5 is the **evening before** and returns true.

### Why missing it is permanent, not late

The check is lazy — it runs only when the customer loads their dashboard
(`src/app/account/(dashboard)/page.tsx:93`). There is no catch-up. A member who
opens their account at 6 PM Pacific on their birthday is outside the window, and
by the next morning it is a different UTC day. The next opportunity is **twelve
months later**.

Worse, the mirror case burns the once-a-year guard: a member who browses at 9 PM
ET the evening *before* is inside the UTC window, is awarded a day early, and
`birthday_bonus_year` is stamped — so on their actual birthday the check returns
false at `:620` even if they visit at noon.

### The stated reason for the lazy design is no longer true

`src/lib/membership.ts:593-595`:

> Lazy check meant to run whenever a customer visits their dashboard: **since
> there's no scheduled job runner in this app**, birthdays are checked on-demand
> rather than by a daily cron.

There is a scheduled job runner: `src/app/api/cron/sweep/route.ts`, thirteen jobs
on a `*/30 * * * *` schedule (`website/vercel.json`). The comment predates it.
Recorded because it changes what the right fix is — a sweep job is available, and
the comment says it is not.

### Impact

An advertised perk that silently does not arrive. The account settings screen
offers it in the store's own words — *"Optional — add your birthday for a rewards
bonus on the day"* (`src/components/account-settings-client.tsx:225`) — and the
default award is 150 points. Evening is when consumers browse, so the missing
window covers a large share of the traffic that would trigger it, and Pacific
members lose almost the whole waking day. It generates a support contact the code
cannot satisfy, because by the time anyone looks it is the wrong UTC day.

### Smallest safe root-cause fix

Compare calendar days in the display zone, using the technique
`src/lib/format-date.ts:74-82` already uses:

```ts
const todayInZone = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());                       // "2026-05-14"
const isBirthdayToday = todayInZone.slice(5) === birthday.slice(5);   // MM-DD
const currentYear = Number(todayInZone.slice(0, 4));
```

Comparing the two `YYYY-MM-DD` strings directly avoids parsing either side into a
`Date`, which is where the zone crept in. Derive `currentYear` from the same
zoned value so the guard and the check cannot disagree.

Separately: now that a sweep exists, awarding birthdays from a sweep job would
remove the "only if they happen to visit" dependency entirely. Out of scope for
the fix; worth raising to the owner.

### CROSS-BLOCK

None for the fix. `src/lib/membership.ts` is not on another block's primary list.
Block G+H should confirm the award appears on the dashboard when the zone is
correct.

---

## K-09 — Store credit is granted and spent on UTC calendar months, so a member's advertised monthly credit dies at 7 PM their time on the last day

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P2 · **Status:** OPEN
**Area:** time/date/timezone × money

### What is wrong

Both halves of the store-credit model bucket on the **UTC** month:

```ts
// src/lib/store-credit.ts:10-12 — the grant's dedupe key
function currentPeriodMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
// src/lib/store-credit.ts:20-22 — the spendable window's lower bound
new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
```

`period_month` is what the grant's unique index dedupes on (`:52`);
`startOfCurrentMonthIso` is the `.gte("created_at", …)` bound on the balance
query (`:31`).

UTC month rollover is **7:00 PM America/New_York / 4:00 PM Pacific** on the last
day of the month.

### Evidence — probe (from the parallel investigation, re-derived here)

```
startOfCurrentMonthIso @ 2026-01-31T23:55Z = 2026-01-01T00:00:00.000Z
startOfCurrentMonthIso @ 2026-02-01T00:05Z = 2026-02-01T00:00:00.000Z
2026-02-01T00:05Z is local ET: Saturday, January 31, 2026 at 7:05 PM
grant period_month @ Jan 31 = 2026-01 | @ Feb 1 = 2026-02  => two grants ~10 min apart
```

Two sweep ticks ten minutes apart, both at ~7 PM ET on January 31 from the
customer's point of view, land in different month buckets.

### Two consequences

**The credit disappears five hours early.** A member shopping at 8 PM ET on the
31st has already rolled into next month. Whatever they were granted for the month
they are still living in is outside the `.gte` window, so
`storeCreditBalanceCents` is 0 (or is next month's grant, if the sweep has run) —
and `quote-order.ts:750` gates the discount on `storeCreditBalanceCents > 0`, so
it silently drops off the quote mid-checkout.

The store tells them otherwise. `src/components/membership-landing.tsx:442`:
*"Store credit is granted monthly and does not roll over."* A member reading that
expects it to last until the end of the day on the 31st, in their own calendar.

**Double grants near the boundary.** `grantMonthlyStoreCreditSweep` runs every 30
minutes and grants to any row that is merely `.eq("status", "active")` with
`.not("next_billing_at", "is", null)` (`membership-billing.ts:1214, 1218`) —
there is no billing-anniversary check. A member who activates in the last hours of
a UTC month gets the grant on the next tick and again after the rollover, under
two different `period_month` values, so the unique index does not stop the second.
They never *hold* two months' worth (the window moves with the rollover), but
`store_credit_ledger` records two grants — overstating issued credit 2× for every
such member, in exactly the liability figure the module exists to keep straight.

### Smallest safe root-cause fix

Bucket on the **display zone's** calendar month, not UTC — the same decision
`format-date.ts` already made for every customer-facing date:

```ts
const ym = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE, year: "numeric", month: "2-digit",
}).format(now);                                   // "2026-01"
```

and derive `startOfCurrentMonthIso` as the UTC instant of that zone's month start.
Both functions must use the same derivation or the grant and the spend window can
disagree — which is the whole defect in a different shape.

`DISPLAY_TIME_ZONE` is already the store's stated business zone, so this makes the
credit month mean what the customer and the marketing copy both assume.

### CROSS-BLOCK

- `src/lib/quote-order.ts:750-751` — **shared file, earlier-lettered block wins.**
  The gate that drops the discount lives there; no change is needed for this fix,
  but block M should confirm the quote path sees the corrected balance.
- `src/lib/membership-billing.ts:1211-1232` — the sweep's grant loop. Unowned; the
  billing-anniversary question below belongs with it.

*Open question for the owner:* should the monthly grant follow the **calendar
month** or the **member's billing anniversary**? The sweep implements calendar
month with no anniversary check, which is why a member who joins on the 30th gets
a full month's credit for one day of membership. That is a product decision, not a
defect, and it is worth settling before the boundary fix goes in — the fix is
different for each answer.

## K-10 — The storefront offers bar says "Ends tonight" for a coupon that expires that morning, and for one a year away

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P3 · **Status:** OPEN
**Area:** time/date/timezone × legal/policy (claims made to shoppers)

### What is wrong

`src/lib/storefront-offer-format.ts:92` decides urgency by comparing two
*rendered day strings*:

```ts
if (formatDisplayDate(end, "short") === formatDisplayDate(now, "short")) return "Ends tonight";

const label = formatDisplayDate(endsAt, "short");
return label ? `Ends ${label}` : null;
```

The `"short"` style is `{ month: "short", day: "numeric" }`
(`src/lib/format-date.ts:42`) — **no year and no time**. Two holes follow:

1. **"Tonight" is asserted for any expiry on the same calendar day**, including
   one at 9:00 AM. The bar promises the whole evening on a code that dies before
   lunch.
2. **Two dates a year apart render identically**, so a coupon ending
   `2027-09-03` reads "Ends tonight" on `2026-09-03`. The fallback branch has the
   same hole: it prints "Ends Dec 1" with no year.

The zone handling itself is correct, and deliberately so — the comment at
`:85-91` explains that comparing rendered strings is what pins both sides to the
business zone. **The defect is the missing year and time-of-day, not the
timezone.** Recorded that way so a fix does not undo the right decision.

### Evidence — probe against the real exported function

```
$ TZ=UTC npx vitest run scratchpad/k-ends.test.ts
  now 8:00 AM ET, coupon dies 9:00 AM ET -> Ends tonight
  now Sep 3 2026, coupon dies Sep 3 2027 -> Ends tonight
  now Sep 3 2026, coupon dies Dec 1 2028 -> Ends Dec 1

 Test Files  1 passed (1)   Tests  3 passed (3)
```

### Impact

A false urgency claim in the storefront's own voice, on a component whose file
header argues at length that the bar must never promise what checkout will not
honour. A shopper told "Ends tonight" who plans to order after work finds the code
refused. The year-blind variant manufactures urgency for a promotion with twelve
months left to run — the opposite failure, and the one a regulator would read as
a dark pattern rather than a bug.

Combined with K-01, a cart-recovery coupon can be announced by the bar as "Ends
tonight" while the email announcing the same code states a time in a third
rendering.

### Smallest safe root-cause fix

Compare the instant, not the rendered day, and say what is actually true:

- return `"Ends tonight"` only when `end` is on the same **display-zone calendar
  day** *and* at or after ~6 PM local; otherwise fall through to a labelled time
  (`"Ends 9:00 AM today"`), which the `"datetime"` style already renders.
- include the year in the fallback whenever `end` is not in the current year.

Deriving the day key with `Intl.DateTimeFormat("en-CA", { timeZone: DISPLAY_TIME_ZONE, year, month, day })`
— the technique at `format-date.ts:74-82` — keeps the correct zone behaviour while
making the comparison year-aware.

### CROSS-BLOCK

None. Block G+H should confirm the corrected label in the browser, since this is
storefront copy.

---

---

## K-11 — `dollarsToPoints` floors a float, so 4.6% of points redemptions debit the customer one point less than the discount they received

**Grade:** `BEHAVIORAL-TEST-PROVEN` · **Severity:** P2 · **Status:** OPEN
**Area:** money and numeric precision

### What is wrong

`src/lib/points-math.ts` has one rounding helper serving two callers that need
opposite behaviour:

```ts
function roundPoints(value: number) {
  return Math.max(0, Math.floor(value));
}

export function calculateEarnedPoints(chargeableAmount: number, pointsPerDollar: number, eventMultiplier: number) {
  return roundPoints(chargeableAmount * pointsPerDollar * eventMultiplier);   // floor is CORRECT here
}

export function dollarsToPoints(dollars: number) {
  return roundPoints(dollars * POINTS_PER_DOLLAR_REDEMPTION);                 // floor is WRONG here
}
```

For **earning**, `Math.floor` is right: you should not grant a fractional point
upward, and the input is a genuinely fractional product.

For **redeeming**, the input is already an exact two-decimal money amount — it
came out of `roundMoney` one line earlier. `dollars * 100` should be an integer,
and the only reason it is not is IEEE-754: `0.29 * 100` is
`28.999999999999996`. `Math.floor` then turns that into **28**.

### Evidence — probe, run in this session

```
$ node points.mjs
(1) dollarsToPoints(x) !== cents(x) for 4586 of the first 100000 cent amounts
    first 12: $0.29: want 29 got 28  $0.57: want 57 got 56  $0.58: want 58 got 57
              $1.13: want 113 got 112  $1.14: want 114 got 113  $1.15: want 115 got 114
              $1.16: want 116 got 115  $2.01: want 201 got 200  $2.03: want 203 got 202
              $2.05: want 205 got 204  $2.07: want 207 got 206  $2.26: want 226 got 225
(2) points -> dollars -> points loses a point for 4586 of the first 100000 balances
    first 12: 29->28  57->56  58->57  113->112  114->113  115->114  116->115
              201->200  203->202  205->204  207->206  226->225
(3) worked example - customer redeems points on a small order
    total $0.29   discount $0.29   debited 28     fair 29     <-- MISMATCH, store eats 0.01
    total $1.13   discount $1.13   debited 112    fair 113    <-- MISMATCH, store eats 0.01
    total $4.58   discount $4.58   debited 458    fair 458
    total $8.23   discount $8.23   debited 823    fair 823
    total $12.29  discount $12.29  debited 1229   fair 1229
```

**4,586 of the first 100,000 amounts — 4.6%.** Not a rare edge; a fixed 1-in-22
rate across the whole money range.

### The chain that makes it a ledger defect, not just a rounding wobble

```
quote-order.ts:768   const requestedDollars   = pointsToDollars(requestedPoints);       // Math.round
quote-order.ts:769   pointsDiscountAmount     = roundMoney(Math.min(requestedDollars, totalAfterCredit));
quote-order.ts:770   pointsRedeemed           = dollarsToPoints(pointsDiscountAmount);  // Math.floor  <-- here
quote-order.ts:978   points_redeemed: input.pointsRedeemed,                             // written to the order
payment-webhook.ts:1061-1063
                     const pointsRedeemed = Number(order.points_redeemed ?? 0);
                     if (pointsRedeemed > 0) await redeemPoints(customerUserId, pointsRedeemed, orderId);
```

`pointsToDollars` uses `Math.round`; `dollarsToPoints` uses `Math.floor`. The
round trip is asymmetric by construction, and the floor is the leg that touches
the customer's balance.

So for 4.6% of redemptions the order row permanently records a discount of
`$X.YZ` alongside a `points_redeemed` worth `$X.YZ − 0.01`, and the points ledger
is debited the smaller figure.

### Impact

Two things, and the second is the one that matters:

1. **Money**: one cent per affected redemption, always in the customer's favour
   (the debit is floored, never ceiled). Immaterial per order; a systematic,
   one-directional leak in aggregate.
2. **Reconciliation**: `orders.points_redeemed` and the points component of
   `orders.discount_amount` disagree for 4.6% of orders that redeem points. Any
   surface that re-derives one from the other — and block F is auditing exactly
   that class of re-derivation — will flag them as mismatched forever, with no
   defect to find, because the defect is upstream in a shared helper.

Also worth stating plainly: the customer both **earns** floored and **redeems**
floored. The floor is correct on the earning leg, so the two do not cancel; they
compound in opposite directions for the two parties.

### Reproduction

Pure, no database needed:

```js
const roundMoney = (v) => Math.round(v * 100) / 100;
const dollarsToPoints = (d) => Math.max(0, Math.floor(d * 100));
dollarsToPoints(roundMoney(0.29))   // 28, not 29
```

End-to-end: place an order whose `totalAfterCredit` is `$1.13` and redeem more
points than the total is worth, then compare `orders.discount_amount` against
`orders.points_redeemed` and the `points_ledger` debit for that order.

### Smallest safe root-cause fix

Give redemption its own rounding, because its input is already exact:

```ts
export function dollarsToPoints(dollars: number) {
  // The input is an exact 2dp money amount from roundMoney, so `* 100` is an
  // integer in every case except IEEE-754 representation (0.29 * 100 is
  // 28.999999999999996). Round, do not floor: flooring silently debits a point
  // less than the discount granted, for 4.6% of amounts.
  return Math.max(0, Math.round(dollars * POINTS_PER_DOLLAR_REDEMPTION));
}
```

Leave `calculateEarnedPoints` on `roundPoints`/`Math.floor` — floor is correct
there, and the two callers wanting different behaviour from one helper is the
actual root cause. Splitting them is the fix; changing `roundPoints` itself would
break earning.

### Regression test to write

Assert `dollarsToPoints(roundMoney(c / 100)) === c` for every integer `c` in
`1..100000`. That is the invariant, it is cheap to check exhaustively, and it
fails today on 4,586 values. Negative control: restore `Math.floor` and confirm
it fails on exactly those, starting at `$0.29`.

Add the mirror assertion for `calculateEarnedPoints` so a later "make them
consistent" refactor cannot quietly ceil the earning leg.

### CROSS-BLOCK

- `src/lib/quote-order.ts:768-770` — **shared file**, no change required; the fix
  is entirely inside `src/lib/points-math.ts`, which no block owns.
- `src/lib/payment-webhook.ts:1061-1063` — **Block A+B**, no change required; it
  reads the corrected value.
- **Block F** should be told this exists before they chase
  `points_redeemed` vs `discount_amount` mismatches as a reporting defect. It is
  not; it is upstream.

### Also checked, and clear

- `calculateCardProcessingFee` (`src/lib/payment-methods.ts:116-124`) — wraps the
  product in `roundMoney`. Correct.
- `src/lib/bundle-pricing.ts` — `roundMoney` on every unit price and line total,
  and `toRate` (`:71-78`) carries the blank guard K-06 found missing elsewhere.
  This module is a model for the rest. Correct.
- **The client/server Buy-3-Get-1 rounding divergence flagged as a P1 lead in the
  Phase 1 map does not reach the customer.** `src/lib/quote-order.ts:250` wraps
  the sum in `roundMoney` and `src/components/cart-context.tsx:164` does not, so
  the two genuinely differ — but only by a float epsilon, and the anti-tamper
  guard at `quote-order.ts:782-786` compares with a full **one-cent** tolerance
  (`Number(input.expectedTotal) < expectedTotal - 0.01`), which an epsilon cannot
  cross. The client value is displayed through `Intl.NumberFormat`, which rounds
  to 2dp for display. **Downgraded: not a defect.** The *real* divergence in that
  pair is the price source — the client expands `item.price` from the
  localStorage snapshot while the server resolves the live catalog price
  including dose `salePrice` — which is a stale-state issue belonging to
  **Block G+H** (browser) and **Block D** (discounts), not a rounding one.
- `numeric(12,2)` headroom: the per-line cap is 99 units (`quote-order.ts`) with a
  500-unit order ceiling, so no realistic order approaches the
  `9,999,999,999.99` column limit. No overflow path found.

---

---

## K-12 — Store credit is decided at quote time and debited at settlement time, so a manual-payment order routinely debits a different month — or nothing at all

**Grade:** `SOURCE-INSPECTED` (full chain quoted) · **Severity:** P1 · **Status:** OPEN
**Area:** time/date boundaries × money × third-party/manual settlement lag

### What is wrong

The **discount** is decided at quote time from the current month's window:

```ts
// src/lib/quote-order.ts:750-751
if (!referral && memberPerks.storeCreditBalanceCents > 0 && Math.round(subtotal * 100) >= memberPerks.storeCreditMinOrderCents) {
  storeCreditRedeemedCents = Math.max(0, Math.min(memberPerks.storeCreditBalanceCents, Math.round(totalBeforePoints * 100)));
```

That figure is frozen onto the order as `store_credit_redeemed_cents`, and the
customer is charged the reduced `amount_paid`.

The **ledger debit** happens much later, and re-derives the balance from scratch:

```ts
// src/lib/store-credit.ts:105-110
export async function redeemStoreCredit(userId: string, amountCents: number, orderId: string): Promise<void> {
  if (amountCents <= 0) return;
  const liveBalance = await getStoreCreditBalanceCents(userId);
  const toRedeem = Math.min(Math.abs(Math.round(amountCents)), liveBalance);
  if (toRedeem <= 0) return;                       // <-- silent
```

`getStoreCreditBalanceCents` sums only rows `.gte("created_at", startOfCurrentMonthIso())`
(`store-credit.ts:31`), and that boundary is a **UTC** month start (`:20-22`).

### The clamp is right for the reason it was written, and wrong for this one

`store-credit.ts:102-104` states the intent:

> Capped to the LIVE remaining balance at redemption time, so two concurrent
> pending orders that each froze the same balance can never over-spend it.

That is a sound concurrency guard, and it should stay. The defect is that the
**same clamp silently absorbs a completely different case** — where the balance
is not "already spent" but "sitting in a different month bucket". The code
cannot tell those apart, and its response to both is `return` with no throw, no
log, and no `recordSystemAlert`.

### Why the lag is routine, not an edge case

`redeemStoreCredit` has two callers:

- `src/lib/payment-webhook.ts:1543` — inside `processPaymentWebhook` (card lane).
  Here the gap is seconds, so only a genuine month rollover bites — 7:00 PM
  Eastern on the last day of the month, evening peak (see K-09).
- `src/lib/payment-webhook.ts:1066` — inside `finalizeManualPayment`, whose
  docblock (`:940-942`) describes it as the path that runs when an admin verifies
  a Cash App / Zelle / PayPal transfer. It is invoked from
  `src/app/api/admin/payments/[orderId]/route.ts:65`, i.e. **when a human gets
  around to it**.

Manual payment is a first-class method in this store. A transfer quoted on the
28th and approved on the 2nd is ordinary operation, not an edge — and the two
evaluations then land in different months **as a matter of course**.

### Two outcomes, both wrong, neither visible

| state at settlement | `liveBalance` | result |
|---|---|---|
| new month's grant already made | the **new** month's credit | debits credit the customer has not spent, for an order already discounted from last month's |
| new month's grant not yet made (the sweep runs every 30 min) | `0` | `toRedeem <= 0` → **return with no ledger row at all** |

In the second case the customer keeps a discount the ledger never records.

### Impact

- **The store gives away the credit twice, or gives it away for free.** On a tier
  with `monthly_store_credit_cents = 7500`, that is $75 an order.
- **Refunds silently fail to return it.** `refundStoreCreditForOrder`
  (`store-credit.ts:126-140`) looks up rows by
  `.eq("order_id", orderId).eq("reason", "membership_redemption")`. If no
  redemption row was written, there is nothing to reverse, so a refunded order
  returns no credit and no one is told.
- **Admin reporting cannot see it.** `startOfCurrentMonthIso` is exported
  specifically so "admin reporting uses the same boundary the customer's balance
  uses" (`:16-18`) — so both agree, and both are wrong in the same direction.
- `orders.store_credit_redeemed_cents` and `store_credit_ledger` disagree
  permanently, with nothing to reconcile them against.

### Reproduction

1. Give a member $50 of store credit this month.
2. Place a **manual-payment** order redeeming all $50. Confirm
   `orders.store_credit_redeemed_cents = 5000` and `amount_paid` is $50 lower.
3. Delete this month's grant rows (or wait for the UTC month to roll over
   before the grant sweep runs) so the live balance is 0.
4. Approve the payment: `PATCH /api/admin/payments/<orderId>`.
5. Assert `select coalesce(sum(amount_cents),0) from store_credit_ledger where order_id='<id>'`
   → **0**, with `orders.store_credit_redeemed_cents` still 5000, no
   `system_alerts` row, and nothing in the logs.
6. Then refund the order and confirm no credit is returned.

### Smallest safe root-cause fix

**Bind the redemption to the month the order was quoted in, not the month it
settled in.** Pass the order's quote timestamp through:

```ts
export async function redeemStoreCredit(userId: string, amountCents: number, orderId: string, quotedAt: string): Promise<void> {
  const liveBalance = await getStoreCreditBalanceCents(userId, quotedAt);   // .gte(startOfCurrentMonthIso(new Date(quotedAt)))
```

and write the debit row with `created_at` set inside the quote's month so it nets
against the grant it was actually spent from.

**Separately, and regardless: make the clamp audible.** When
`toRedeem < amountCents`, the store has granted a discount it is not debiting.
That is a money event and it must not be a bare `return`:

```ts
if (toRedeem < Math.abs(Math.round(amountCents))) {
  await recordSystemAlert({
    type: "store_credit_not_fully_debited",
    severity: "critical",
    message: `Order ${orderId} was discounted ${amountCents}c of store credit but only ${toRedeem}c could be debited.`,
  });
}
```

This is the change worth making even if the month binding is deferred: it turns
an invisible loss into a visible one, and it keeps the concurrency guard's
correct behaviour intact.

If the business decides a cross-month settle should be **refused** rather than
absorbed, refuse it explicitly and re-quote the order — but do not leave the
current silent third option.

### Regression test to write

Stub the ledger. Quote an order in month M with a $50 balance, advance the clock
into month M+1, settle it, and assert a redemption row exists for the **quote's**
month equal to the frozen amount. Negative control: revert to
`getStoreCreditBalanceCents(userId)` with no `quotedAt` and confirm the test
fails on a missing row — not on a stub error.

Second test: with a live balance below the frozen amount, assert a
`system_alerts` row is written. Negative control: remove the alert and confirm it
fails.

### CROSS-BLOCK

- `src/lib/payment-webhook.ts:1066` and `:1543` — **Block A+B.** Both call sites
  need the extra `order.created_at` argument. `order.created_at` is not currently
  in the `.select(...)` at `payment-webhook.ts:463`; it must be added there too.
- `src/lib/quote-order.ts:750-751` — **shared file**, no change needed.
- The fix body is in `src/lib/store-credit.ts`, which no block owns.

*Relationship to K-09:* K-09 is the boundary being in the wrong **zone** (UTC
rather than the business zone). K-12 is the balance being read at the wrong
**time** (settlement rather than quote). Fixing either alone leaves the other:
correcting the zone still breaks across a real month boundary, and binding to the
quote month still uses a boundary five hours early. Both are needed.

---

---

## K-13 — The "15-minute" inventory hold is really up to 45 minutes, and every way it can fail reports success

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** background jobs (cadence vs semantics) × degraded mode

### The store's own status page calls this launch-blocking

`src/lib/system-status.ts:152-165` is unusually explicit:

```ts
// Scheduled jobs (cron) — CRON_SECRET presence is our proxy for "armed".
const cronConfigured = Boolean((process.env.CRON_SECRET ?? "").trim());
out.push({
  key: "cron",
  detail: cronConfigured ? "CRON_SECRET set — timer armed" : "CRON_SECRET missing — …",
  // Launch-blocking: expireStaleReservations() runs only from the cron sweep.
  // Without it, every abandoned/failed checkout's 15-min hold never releases,
  // silently removing scarce stock from sale.
  blocksLaunch: true,
});
```

The risk is correctly identified and correctly graded. The **check** is
`Boolean(process.env.CRON_SECRET)` — which cannot detect a single one of the ways
this actually fails.

### Defect 1 — the TTL and the sweep cadence disagree by 3×

```ts
// src/lib/inventory-reservation.ts:10-11
// A card/instant checkout must complete within 15 minutes of the hold.
export const DEFAULT_RESERVATION_MINUTES = 15;
```

```json
// website/vercel.json — the only schedule in the repo
"schedule": "*/30 * * * *"
```

Availability is computed from a **materialised counter**, not from the
reservation's expiry:

```sql
-- src/lib/sql/inventory-reservations.sql:100-104 (reserve_inventory)
update public.products
   set reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
 where slug = p_slug
   and track_inventory = true
   and inventory_quantity - reserved_quantity >= p_quantity;
```

Nothing in that predicate consults `expires_at`. The counter comes back down in
exactly one unattended place — `expire_stale_reservations()`
(`inventory-reservations.sql:238-256`), which decrements
`reserved_quantity` and flips the row to `released` — and that runs only from the
sweep.

So a hold that expires at T+15 is reclaimed on the next tick, up to 30 minutes
later. **A "15-minute" hold takes stock off sale for up to 45 minutes**, three
times the number the comment promises. On this catalogue that is not academic:
ledger finding F-001 established that 31 of 36 storefront-eligible products carry
their stock at the dose level in small quantities, so a single abandoned checkout
can be the difference between In Stock and Sold Out for three quarters of an hour.

### Defect 2 — the wrapper reports "nothing was due" for every possible failure

```ts
// src/lib/inventory-reservation.ts:185-196
export async function expireStaleReservations(): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin.rpc("expire_stale_reservations", {});
    if (error) return 0;
    if (Number(data ?? 0) > 0) invalidateCatalogCache();
    return Number(data ?? 0);
  } catch {
    return 0;
  }
}
```

`if (error) return 0` and a bare `catch { return 0 }`. A missing RPC (the ledger's
F-011 records that three safety-critical functions exist **only in production** and
were never committed), a revoked `execute` grant, a statement timeout, and
"nothing was due" are **all indistinguishable**: the sweep's JSON body reports
`reservationsExpired: 0` in every case.

And because the function returns rather than throws, `Promise.allSettled` sees a
**fulfilled** promise, so the sweep's alert at
`src/app/api/cron/sweep/route.ts:91-101` — which fires only for
`status === 'rejected'` — never fires either.

### Defect 3 — nothing records that the sweep ran

No last-successful-run timestamp is persisted anywhere. If Vercel stops invoking
the cron entirely, `CRON_SECRET` is still set, so the status page still reads
**"CRON_SECRET set — timer armed"** and the launch-blocking check still passes.

### Impact

Three independent failure modes for a job the store itself calls launch-blocking,
and its health indicator is green in all three:

| failure | status page says | sweep body says | alert |
|---|---|---|---|
| RPC missing / grant revoked / timeout | timer armed | `reservationsExpired: 0` | none |
| Vercel stops invoking the cron | timer armed | *(no response at all)* | none |
| maintenance mode on (K-14) | timer armed | *(503, never reaches the handler)* | none |

In each, `reserved_quantity` climbs monotonically and never comes down. Stock
disappears from a storefront that reports itself healthy, and the first signal is
a customer saying a product they can see is sold out.

### Reproduction

**Cadence (no failure required):** place a card checkout on a tracked, low-stock
dose, abandon it, and record the wall-clock time from `expires_at` until
`products.reserved_quantity` (or `product_doses.reserved_quantity`) drops. On the
`*/30` schedule the expectation is a uniform 0–30 minutes **after** the 15-minute
TTL.

**Invisible failure:** `revoke execute on function public.expire_stale_reservations() from service_role;`
on the harness, seed a few `inventory_reservations` rows with `status='active'`
and `expires_at < now()`, then
`curl -H "Authorization: Bearer $CRON_SECRET" /api/cron/sweep`. Assert all three:
the body reports `reservationsExpired: 0`; `select count(*) from system_alerts
where type='cron_sweep_failed' and created_at > now() - interval '5 minutes'` is
**0**; and the reservations are still `active` with `reserved_quantity` unchanged.
Then load `/admin/status` and confirm the cron row still reads "timer armed".

### Smallest safe root-cause fix

Three changes, independent, in value order:

1. **Make the failure loud.** Distinguish the cases:
   ```ts
   const { data, error } = await supabaseAdmin.rpc("expire_stale_reservations", {});
   if (error) throw error;      // let Promise.allSettled see it and alert
   ```
   Removing the bare `catch` costs nothing — the sweep already isolates each job
   — and converts a silent stock leak into the critical alert
   `recordSystemAlert` was written to send.

2. **Persist a heartbeat.** Write a `last_run_at` (and per-job outcome) row at the
   end of the sweep, and have `system-status.ts` read *that* rather than
   `Boolean(process.env.CRON_SECRET)`. "A secret is configured" and "the job ran"
   are different claims, and only the second is the one being made to the operator.

3. **Reconcile the TTL with the cadence.** Either state the real number
   (`DEFAULT_RESERVATION_MINUTES` + the sweep period) or stop depending on the
   sweep for availability — have `reserve_inventory`'s predicate discount holds
   whose `expires_at` has passed, so an expired hold stops blocking a sale the
   moment it expires and the sweep becomes pure cleanup. The second is the real
   fix; the first is honest in the meantime.

### Regression test to write

Assert `DEFAULT_RESERVATION_MINUTES * 60_000` is greater than the sweep period
parsed from `website/vercel.json`, so the two constants can never silently drift
apart again — they live in different files with nothing tying them together, which
is how they got here. Negative control: set the schedule to `*/30` with a 15-minute
TTL and confirm the test fails.

Separately, a unit test that `expireStaleReservations` **rejects** when the RPC
errors. Negative control: restore `return 0` and confirm it fails.

### CROSS-BLOCK

- `src/lib/inventory-reservation.ts` — **Block D** owns `inventory-*.ts`. The
  wrapper change (fix 1) is theirs; flag it to them as a *visibility* fix, not an
  inventory-logic change.
- `src/lib/sql/inventory-reservations.sql` — **Block D**, for fix 3.
- `src/lib/system-status.ts` and the sweep heartbeat (fix 2) are unowned; Block K
  can carry them.
- **Block A** (concurrency/idempotency) will reach `reserve_inventory` from the
  race angle. The atomic gate itself is sound — a single row-locked
  `UPDATE … WHERE inventory_quantity - reserved_quantity >= p_quantity` with an
  idempotency pre-check at `:76-85`. This finding is about the *release* leg, not
  the hold, and does not overlap.

---

## K-14 — Maintenance mode 503s the entire cron sweep and the one-click unsubscribe link in already-delivered marketing email

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** background jobs × config × legal/policy

### What is wrong

`middleware.ts:65-82` enumerates what survives maintenance mode:

```ts
function pathBypassesMaintenance(pathname: string) {
  return (
    pathname === "/maintenance"
    || pathname.startsWith("/.well-known/")
    || pathname.startsWith("/vault")
    || pathname.startsWith("/admin")
    || pathname.startsWith("/api/admin")
    || pathname.startsWith("/api/webhooks")
    || pathname.startsWith("/api/analytics/track")
    || isStaticAsset(pathname)
  );
}
```

`/api/cron` is not on the list. Vercel's cron invocation carries no
`vl_admin_session` cookie, so `hasValidAdminSession` (`:315`) is false and the
request falls through to:

```ts
// middleware.ts:320-327
if (pathname.startsWith("/api/")) {
  return applySecurityHeaders(
    NextResponse.json({ success: false, error: "Maintenance mode enabled" }, { status: 503 }),
  );
}
```

### What stops, for as long as maintenance mode is on

All thirteen jobs, because the 503 is returned by the middleware — the route
handler, and therefore `recordSystemAlert`, is never reached:

- `expireStaleReservations` — **stock stays locked and accumulates** (K-13)
- `reconcileVeyraPendingPayments` — the module's own comment
  (`src/app/api/cron/sweep/route.ts:45-47`) calls it "the only thing standing
  between a charged card and an order that reads unpaid forever, so a failure
  here is genuinely critical". A customer's card is charged and the order stays
  `pending_payment`.
- `retryPendingEmails` — receipts and shipping notices stop retrying
- `runMembershipBillingSweep`, `autoApproveEligibleCommissions`, both Shippo
  sweeps, cart recovery, store credit, campaigns, automations

`/api/webhooks` **is** bypassed, so live payment webhooks still land. That makes
the gap sharper, not smaller: the fast path keeps writing orders while the
reconciliation path that catches its misses is switched off.

### The legal one — `/api/unsubscribe`

`/api/unsubscribe` is not bypassed either. It is the HMAC-signed one-click opt-out
embedded in **every** marketing email:

```ts
// src/lib/email/marketing.ts:31
const unsubscribeUrl = `${getSiteUrl()}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
```

Those emails are already in inboxes and cannot be recalled. While maintenance mode
is on, every recipient who clicks Unsubscribe gets
`503 {"error":"Maintenance mode enabled"}` — a JSON error, not even a page.

An opt-out mechanism that does not work is a **CAN-SPAM** exposure (the statute
requires the mechanism to be operational for 30 days after sending), and it is the
kind that generates a complaint rather than a bug report. Also blocked:
`/api/coa/[coaId]/file` (the store's published evidence that a batch was tested)
and `/api/health`.

### Impact

Maintenance mode reads as a front-of-house switch — "the storefront is down for a
few minutes". It is actually a switch that silently stops every background job,
disables the legally-required opt-out, and hides the store's compliance documents,
while `/admin/status` continues to report scheduled jobs as **"timer armed"**
(K-13) because `CRON_SECRET` is still set.

Nothing bounds it. There is no timer, no reminder, and no alert if it is left on
overnight — and every minute it is on, abandoned holds accumulate and charged
cards go unreconciled.

### Reproduction

Enable maintenance from `/admin`, then from a shell with no cookies:

```
curl -i -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sweep
curl -i 'http://localhost:3000/api/unsubscribe?email=a@b.com&token=<valid>'
curl -i http://localhost:3000/api/health
```

All three return `503 {"success":false,"error":"Maintenance mode enabled"}`. Then
confirm `select count(*) from inventory_reservations where status='active' and expires_at < now()`
grows across the window, and that `system_alerts` gains nothing.

### Smallest safe root-cause fix

Add the paths that must never be gated by a front-of-house switch:

```ts
|| pathname.startsWith("/api/cron")        // Bearer CRON_SECRET is its own auth
|| pathname.startsWith("/api/unsubscribe") // legally required to keep working
|| pathname.startsWith("/api/coa")         // published compliance evidence
|| pathname === "/api/health"              // must answer while degraded
```

`/api/cron` is safe to bypass: it authenticates with a constant-time `CRON_SECRET`
compare (`src/app/api/cron/sweep/route.ts:69-79`) and is not a customer surface.
`/api/unsubscribe` verifies an HMAC token before doing anything.

The `.well-known` entry in that same function carries a comment recording that
Apple Pay "silently died sitewide" from exactly this class of omission. The list
is one-by-one and reactive; a comment naming the *rule* — front-of-house only,
never machine or compliance endpoints — would stop the next one.

### Regression test to write

A table over every route under `src/app/api/`, asserting that each is either
explicitly bypassed or explicitly declared customer-facing. A **new** route added
later then has to make that choice deliberately rather than inheriting a 503.
Negative control: remove `/api/cron` from the bypass list and confirm the test
fails naming it.

### CROSS-BLOCK

- `middleware.ts` — **Block I** owns it. This is their edit. Block I is also
  auditing `CSRF_PROTECTED_PREFIXES` in the same file (`:292`), which excludes the
  entire checkout — **one pass over both lists is better than two sessions
  touching `middleware.ts`.**
- The Phase 1 map spotted only the express-shipping-callback case. The cron and
  unsubscribe cases are additional and, for cron, larger.

### Addendum — the middleware can also replace a response another system parses

Recorded here rather than as a separate finding because the root cause and the
fix are the same, and the reachability is narrow.

`/api/veyra/express-shipping-callback` is not on the bypass list either. That
route is unusually careful about its **response shape**: its docblock
(`:21-25`, `:36-42`) records that Veyra "aborts at 5s and FAILS OPEN to a $0
shipping / $0 tax method", that Veyra's validator rejects
`empty_shipping_methods_without_error_message` by degrading the whole response to
free shipping, and therefore that "every failure path here returns an explicit
error shape (never a bare empty list)".

That contract is enforced inside the route. Maintenance mode returns
`{"success":false,"error":"Maintenance mode enabled"}` from the **middleware**,
before the route runs — a body the route author never wrote and cannot see. It
happens to carry an `error` key, so Veyra may well refuse correctly; that is
luck, not design, and it is not something this session can confirm without
Veyra's validator.

Reachability is narrow: maintenance mode would have to be switched on while an
Apple Pay sheet is open. But the general shape is worth block M's attention —
**a route whose correctness depends on its exact response body can have that body
replaced by middleware**, and nothing in either file references the other. The
`/api/veyra` prefix belongs on the bypass list for the same reason
`/api/webhooks` already is.


---

---

## K-15 — Rate limiting is a read-then-write with no claim, and it fails open silently — so the throttle on coupon enumeration and order creation does not hold under exactly the traffic it exists to stop

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** third-party degraded mode (fail-open)

### What is wrong

`src/lib/rate-limit.ts:17-53` is the whole implementation, and it has two
independent defects:

```ts
try {
  const { count, error } = await supabaseAdmin
    .from("rate_limit_hits")
    .select("id", { count: "exact", head: true })
    .eq("bucket", bucket)
    .gt("created_at", windowStart);

  if (error) {
    return { allowed: true, retryAfterSeconds: 0 };      // (a) fail-open, silent
  }

  if ((count ?? 0) >= limit) {
    return { allowed: false, retryAfterSeconds: windowSeconds };
  }

  await supabaseAdmin.from("rate_limit_hits").insert({ bucket });   // (b) count THEN insert
  …
  return { allowed: true, retryAfterSeconds: 0 };
} catch {
  return { allowed: true, retryAfterSeconds: 0 };          // (a) again
}
```

**(a) It fails open on any storage error, silently.** No log, no
`recordSystemAlert`, no distinguishable return value. The caller cannot tell
"under the limit" from "the rate-limit table is unreachable". Most consequential
case: if the `rate_limit_hits` migration has not been applied, the `select`
returns `42P01`, and **every rate limit in the application is off**, on every
route, with nothing anywhere saying so. The ledger's F-011 already records that
four migrations exist in production and were never committed — migration state in
this project is demonstrably not a given.

**(b) The check and the record are not atomic.** SELECT the count, then INSERT.
Two hundred requests arriving together all read a count below the limit, all pass
the gate, and all then insert. The effective limit under a concurrent burst is
**unbounded** — the code only throttles *serial* traffic. Automated abuse is
concurrent by construction, which is the traffic this exists to stop.

The codebase already contains the correct pattern for exactly this shape:
`src/lib/cart-recovery.ts` `reserveAndSendStage` inserts against a unique index
*before* acting, and `src/lib/email/campaign-sender.ts` `claimBatch` uses a
conditional UPDATE. Neither technique was applied here.

### What is behind this gate

Eighteen call sites, several of them money-adjacent:

| route | limit | what the throttle is protecting |
|---|---|---|
| `/api/coupons/validate:14` | 20/min | **the only barrier to coupon-code enumeration** |
| `/api/checkout/create-session:47` | 8/min | order creation |
| `/api/checkout/submit-payment:30` | 10/min | payment submission |
| `/api/checkout/express/session:87` | 12/min | wallet session minting |
| `/api/partner/referral-code:17` | 5/hour | ambassador code churn |
| `/api/partner/apply:37` | 3/hour | partner applications |
| `/api/wholesale:100`, `/api/contact:78` | 3/10min | **unauthenticated email-sending forms** |
| `/api/catalog/back-in-stock:11`, `/subscribe-save:32` | 10/hour | list stuffing |
| `/api/analytics/track:96,104`, `/api/ads/funnel-event:36`, `/r/[code]:35` | 120–600/min | funnel-data poisoning |

Coupon enumeration is the sharpest: codes are minted as `SAVE-XXXX`
(`src/lib/cart-recovery.ts` `generateCouponCode`), `validateCoupon` matches
case-insensitively, and a valid code is worth a real discount. 20/min serially is
a meaningful barrier; 20/min that a concurrent burst walks straight through is not.

**Not affected:** admin login has its own separate mechanism
(`admin_login_attempts`, `src/lib/admin-auth.ts:278-338`) and does not depend on
this module. Checked so the severity is not overstated — this is not an
authentication bypass.

### Compounding: the IP key is attacker-supplied on most of these

Every bucket above is keyed on a client IP, and the Phase 1 critic established
that **three different IP resolvers** exist, with several routes reading
`x-forwarded-for` first — a header the client controls. Rotating one header
changes the bucket. That is Block I's finding to fix; it is recorded here because
the two defects multiply: a bypassable key on a non-atomic, fail-open counter.

### Impact

A security control that is off whenever its table is unavailable, ineffective
whenever traffic is concurrent, and bypassable by rotating a header — with no
signal in any of the three states. The store cannot tell the difference between
"the limits are working" and "the limits have never fired".

### Reproduction

**Fail-open:** on the harness, `revoke select on public.rate_limit_hits from service_role;`
then send 50 sequential `POST /api/coupons/validate` requests. All 50 return 200.
Confirm no `system_alerts` row and nothing in the function logs.

**Non-atomicity (no failure required):**
`for i in $(seq 1 100); do curl -s -o /dev/null -w '%{http_code}\n' -X POST .../api/coupons/validate -d '{"code":"TEST"}' & done; wait | sort | uniq -c`
→ far more than 20 non-429 responses. Repeat with `sleep 0.2` between calls and
watch the limit engage at 20, which isolates concurrency as the variable.

### Smallest safe root-cause fix

**Make the count and the record one statement.** A Postgres function that inserts
and returns the in-window count in a single round trip removes the race entirely:

```sql
create or replace function public.hit_rate_limit(p_bucket text, p_window_seconds int)
returns integer language sql security definer as $$
  with ins as (insert into public.rate_limit_hits (bucket) values (p_bucket) returning created_at)
  select count(*)::int from public.rate_limit_hits
   where bucket = p_bucket and created_at > now() - make_interval(secs => p_window_seconds);
$$;
```

The caller then compares the returned count against the limit. This also matches
how the rest of the codebase solves claim problems.

**Make the failure visible.** Fail-open is arguably the right *default* — a
Supabase blip should not take checkout down — but it must not be silent:

```ts
if (error) {
  await recordSystemAlert({ type: "rate_limit_unavailable", severity: "critical", … });
  return { allowed: true, retryAfterSeconds: 0, degraded: true };
}
```

Adding `degraded: true` to `RateLimitResult` lets individual callers choose: the
funnel-event route can happily proceed, while `/api/coupons/validate` and the two
unauthenticated email-sending forms can fail **closed** instead. That per-route
choice is the part the current single return value makes impossible.

### Regression test to write

Concurrency test: fire `limit + 50` `checkRateLimit` calls with
`Promise.all` against a stubbed store and assert exactly `limit` are allowed.
This fails today. Negative control: with `Promise.all` replaced by a sequential
loop, it should pass — proving the test is measuring concurrency, not the limit
arithmetic.

Second test: stub the select to return a `42P01` error and assert the result
carries `degraded: true`. Negative control: remove the flag and confirm it fails.

### CROSS-BLOCK

- **Block I** owns `src/app/api/admin/**`, `admin-auth.ts` and `middleware.ts`,
  and is already auditing the three-IP-resolver problem. The IP-key half is
  theirs; `src/lib/rate-limit.ts` itself is unowned and Block K can carry the
  atomicity and visibility fixes. **They compose — neither is sufficient alone**,
  and Block M should land them together.
- Per-route fail-closed decisions touch `src/app/api/checkout/**` and
  `src/app/api/coupons/**`; those need the route owners' agreement, not a
  unilateral change from here.

---

---

## K-16 — Three live production advertising pixel IDs are hardcoded as env fallbacks, with no `VERCEL_ENV` guard anywhere in the analytics path — so a preview deployment reports into the real ad accounts

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** environment/config drift

### What is wrong

```ts
// src/components/tiktok-pixel.tsx:24
const PIXEL_ID = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID ?? "D9SAES3C77U40SOI9D70";
// src/lib/ads/tiktok-events-api.ts:27      (the SERVER leg, same literal)
export const PIXEL_ID = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID ?? "D9SAES3C77U40SOI9D70";
// src/components/snap-pixel.tsx:37
export const SNAP_PIXEL_ID = process.env.NEXT_PUBLIC_SNAP_PIXEL_ID ?? "b6e3f2b8-0d0a-4d4e-b547-24b5a20d2a6e";
// src/lib/ads/reddit-pixel-id.ts:13
export const REDDIT_PIXEL_ID = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID ?? "a2_jipuxv3ugrju";
```

These are not placeholders. They are the store's **live advertising account
identifiers**, committed as the fallback for a missing environment variable.

There is no environment guard. A repo-wide grep for `VERCEL_ENV` returns five
hits, and **none is in an analytics path**:

| hit | what it guards |
|---|---|
| `src/app/robots.ts:10` | crawlability |
| `src/app/layout.tsx:116-119` | the `robots` meta tag |
| `src/lib/sentry-privacy.ts:345-346` | error-report tagging |
| `src/lib/ads/tracking-health-server.ts:73` | a *label* on a health readout, not a gate |

The only counterweight to a non-production deployment reporting real conversions
is `metadata.robots` — which stops crawlers, not pixels.

### Why this bites during the audit itself

The server legs use the *same* constant. `src/lib/ads/tiktok-events-api.ts:27` is
`PIXEL_ID`, and the Purchase authority
(`/api/ads/purchase-event/[orderId]`) sends TikTok and Reddit conversions with
the order's real `amount_paid` as `value`.

So a paid test order placed on a **Vercel preview** — which is exactly what
`AUDIT-EXECUTION-PLAN.md` block M schedules as "Phase 20 — preview deployment
verification" — posts a fabricated conversion into the production TikTok and
Reddit ad accounts, at a real dollar value, and trains the bid optimiser on
revenue that does not exist. Nothing in the code prevents it and nothing in the
runbook warns about it.

The same applies to a local run with `NEXT_PUBLIC_ENABLE_ANALYTICS` set, and to
any fork of this repository, which ships someone else's advertising identity.

### The credential check that can never fire

The dangerous default also disables the guard that was written to catch it:

```ts
// src/lib/ads/tiktok-events-api.ts:147
if (!PIXEL_ID) missing.push("NEXT_PUBLIC_TIKTOK_PIXEL_ID");
```

`PIXEL_ID` is `process.env.… ?? "D9SAES3C77U40SOI9D70"`, so it is **never falsy**
and this branch is unreachable. `credentialStatus()` can therefore never report
the pixel ID as missing — it will always say "configured", even on a deployment
that has none of its own.

Reddit has the identical shape:

```ts
// src/lib/ads/reddit-conversions.ts:66,70-72
if (!resolvePixelId()) missing.push("NEXT_PUBLIC_REDDIT_PIXEL_ID");
function resolvePixelId(): string | null { return REDDIT_PIXEL_ID.trim() || null; }
```

`REDDIT_PIXEL_ID` carries the same `??` fallback, so `resolvePixelId()` never
returns null and the check is dead. The later `if (!pixelId) return done(…)` at
`:176-177` is dead for the same reason.

### Impact

- **Polluted ad optimisation.** Preview and local traffic is indistinguishable
  from production traffic inside TikTok, Snap and Reddit. Test purchases become
  training data for bidding. This costs real ad spend to unwind and is not
  reversible from the store's side.
- **The health check lies.** Every "are the ads configured?" readout answers yes
  regardless of the deployment's own configuration.
- **A fork advertises for this store.** Anyone cloning the repository reports into
  these accounts by default.

### Reproduction

1. On a Vercel **preview** deployment (`VERCEL_ENV="preview"`) with no
   `NEXT_PUBLIC_TIKTOK_PIXEL_ID` set, accept cookies and load a product page in
   Playwright.
2. `browser_network_requests` → a request to `analytics.tiktok.com` carrying
   `sdkid=D9SAES3C77U40SOI9D70`.
3. `curl <preview>/api/ads/purchase-event/<a paid order>` and read
   `serverDelivery` — it reports a send against the same pixel id.
4. Confirm the event appears in the **production** TikTok Events Manager.

Source-only confirmation (no network):
`grep -rn "VERCEL_ENV" website/src` → five hits, none in `src/lib/ads/**`,
`src/components/*-pixel.tsx`, or `src/app/api/ads/**`.

### Smallest safe root-cause fix

Two changes, and the first is the one that matters:

**1. Gate the whole analytics path on the environment, not on the value.**

```ts
// one shared helper, e.g. src/lib/ads/ads-enabled.ts
export const ADS_REPORTING_ENABLED =
  (process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV) === "production";
```

Have every pixel component and both server legs early-return unless it is true.
This is the same shape `robots.ts` and `layout.tsx` already use for crawlability;
the decision was made correctly there and simply never extended to analytics.

**2. Delete the fallbacks.**

```ts
const PIXEL_ID = process.env.NEXT_PUBLIC_TIKTOK_PIXEL_ID ?? "";
```

An unset pixel id should mean "this deployment does not report", not "report to
production". Removing the literal also revives the `if (!PIXEL_ID)` checks at
`tiktok-events-api.ts:147` and `reddit-conversions.ts:66`, which are dead today —
so the health readout starts telling the truth as a side effect.

Set the three real ids as Vercel environment variables **scoped to Production
only**. Note that Vercel env vars default to *all* environments, so scoping is an
explicit step; the same caution applies to `TIKTOK_EVENTS_API_ACCESS_TOKEN` and
`REDDIT_CONVERSIONS_ACCESS_TOKEN`, which the Phase 1 map raises as an open
question and which this session cannot answer without the Vercel dashboard.

### Regression test to write

A source-text test — the pattern this codebase already uses, and the one that
caught a consent-copy regression (`src/components/cookie-consent.tsx:76-80`):
assert that no file under `src/lib/ads/` or `src/components/*-pixel.tsx` contains
a string literal matching a pixel-id shape as a `??` or `||` fallback. Negative
control: restore one literal and confirm the test names that file.

Plus a behavioural test that `credentialStatus()` reports `configured: false` when
`NEXT_PUBLIC_TIKTOK_PIXEL_ID` is unset. That assertion fails today, which is the
proof the check is dead.

### CROSS-BLOCK

- **Block M must not place a paid test order on a preview deployment until fix 1
  lands.** Phase 20 of the execution plan schedules exactly that. This is the
  most time-sensitive line in this file.
- `src/app/api/ads/purchase-event/[orderId]/**` is unowned; the pixel components
  and `src/lib/ads/**` likewise. Block K can carry the fix.

### Also checked, and clear — the payment kill switches are correctly hardened

Recorded as negative controls, because the Phase 1 map's "dangerous defaults"
framing invites the assumption that everything in this area is loose. It is not:

- `resolvePaymentProviderName` (`src/lib/payment-provider.ts:296-317`) throws
  unconditionally on `PAYMENT_PROVIDER=mock` when `NODE_ENV === "production"`,
  with **no escape hatch**. The comment records that `ALLOW_MOCK_PAYMENTS=true`
  used to re-open it and was deliberately removed because "one mistyped Vercel
  variable" should not stand between the store and a free-order endpoint.
- `getBillingProvider` (`src/lib/billing-provider.ts:114+`) does the same for the
  mock recurring gateway.
- `ALLOW_MOCK_PAYMENTS` now appears **only** in tests and comments — 23 hits, zero
  in live code — and `src/lib/mock-payment-lockout.test.ts:129-130` asserts the
  escape hatch is absent from the source text of both providers. This is the
  strongest guard pattern in the repository.
- `isCheckoutOpen()` (`payment-provider.ts:331-336`) defaults **closed**, and the
  express lane checks it too (`src/app/api/checkout/express/session/route.ts:78`)
  in addition to its own flag — so closing checkout closes both lanes at the
  server. I expected a hole here and there is not one.

Two smaller notes from the same sweep, not raised as findings:

- `EXPRESS_CHECKOUT_ENABLED` (`src/lib/express-checkout.ts:12-13`) reads
  `NEXT_PUBLIC_EXPRESS_CHECKOUT_ENABLED` at **module scope**, and `NEXT_PUBLIC_*`
  is inlined at build time. Changing it in Vercel therefore does nothing until a
  rebuild — so the express lane **cannot be killed quickly in an incident**,
  unlike `CHECKOUT_ENABLED`, which is read at call time. Worth knowing before it
  is needed.
- Four e2e suites set `process.env.ALLOW_MOCK_PAYMENTS = "true"` at module scope
  (`checkout-acknowledgement-gate`, `manual-reimbursement`,
  `commission-eligibility`, `commerce-journey`). That is now a no-op. Harmless,
  but a reader would misjudge those tests' preconditions. **CROSS-BLOCK: Block E**
  (test quality).

---

---

## K-17 — Cancelling a paid order permanently destroys its stock, in the one case the codebase's own comment says should restock

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** legal/policy (a published promise) × dead/missing path

### The published promise

`src/lib/legal-content.ts`, the `refund` default (Return & Reimbursement Policy):

> ## Cancellations
> If you need to cancel, email … as soon as possible. **We can usually cancel an
> order before it has been packed and a shipping label has been purchased.**

### What the code does

`src/app/api/admin/orders/[orderId]/route.ts:607-631` — the entire cancel action:

```ts
if (action === "cancel") {
  const cancelled = await setOrderFulfillmentStatus({ orderId, to: "cancelled", source: "admin", actor: session.username });
  if (!cancelled.ok) return NextResponse.json({ success: false, error: cancelled.message }, { status: 400 });
}
```

A status transition and nothing else. `setOrderFulfillmentStatus` touches no
inventory — `grep -n "nventory|restock|release" src/lib/order-pipeline.ts`
returns **zero hits**.

A repo-wide sweep for every inventory-return caller confirms none of them is in
the admin route:

```
src/app/api/checkout/express/authorize/route.ts:361,384   releaseInventoryForOrder   (pre-payment hold, on failure)
src/lib/express-reconcile.ts:174                          releaseInventoryForOrder   (Veyra reports the session dead)
src/lib/payment-webhook.ts:1695                           releaseInventoryForOrder   (webhook failure path)
src/lib/payment-webhook.ts:1712-1717                      restockInventoryForOrder   (behind claimInventoryRestock)
```

`src/app/api/admin/orders/[orderId]/route.ts:438` mentions `claimInventoryRestock`
— **in a comment**, describing the webhook's behaviour. There is no call.

### Why it is permanent for a paid order, not merely slow

The pipeline permits cancelling a **paid** order:
`paid: ["ready_to_fulfill", "cancelled", "refunded"]` (`order-pipeline.ts:265`),
and likewise from `ready_to_fulfill` and `packed` (`:268-269`) — precisely the
window the policy promises.

For a paid order the reservation has already been *finalized*:

```sql
-- src/lib/sql/inventory-reservations.sql:154-165 (finalize_inventory_for_order)
update public.product_doses
   set inventory_quantity = greatest(0, inventory_quantity - r.quantity),
       reserved_quantity  = greatest(0, reserved_quantity  - r.quantity),
       stock_status = case when inventory_quantity - r.quantity <= 0 and track_inventory then 'Out of Stock' else stock_status end,
```

`inventory_quantity` is decremented and the reservation row moves to
`finalized`. The sweep cannot recover it: `expire_stale_reservations` selects
`where res.status = 'active'` (`:238`). **Nothing anywhere returns those units.**

For an `awaiting_payment` cancel the hold is still `active`, so the sweep does
eventually reclaim it — after the TTL plus up to a sweep period (K-13), which is
**24 hours** for a manual-payment hold (`MANUAL_RESERVATION_MINUTES`). Slow, but
self-healing. The paid case is not.

### The codebase already draws the right distinction — this path is on the wrong side of it

The refund action 170 lines earlier carries a careful, correct rationale for
*not* restocking (`route.ts:425-441`):

> Restocking on the strength of a money record would put a vial that may have
> spent a week in a mailbox back on the shelf automatically, and the next customer
> would buy it. Phantom stock also oversells… So the safe direction is to leave
> stock alone.
>
> The processor-driven refund/chargeback path in payment-webhook.ts is UNCHANGED
> and still restocks behind `claimInventoryRestock()`: **that one covers an order
> the customer never received (a failed or cancelled order whose goods never
> left), which is a different situation.**

That last sentence is exactly this case. A cancel before packing is *by
definition* an order whose goods never left. The author identified the rule
correctly and the admin-facing path implementing it does neither thing.

### Impact

Every cancellation the store honours — the operation its own policy tells
customers to ask for — silently writes off the stock. On this catalogue that is
not marginal: ledger finding F-001 established that 31 of 36 storefront-eligible
products hold their stock at the dose level in small quantities, so a handful of
cancelled orders can take a product to "Out of Stock" (the `stock_status` write
above is one-way) with units that physically exist sitting on the shelf.

The loss is invisible: no alert, no audit row naming an inventory effect, and the
admin inventory screen simply shows a lower number. It is discoverable only by
counting the shelf against the database.

### Reproduction

1. Note `inventory_quantity` for a tracked dose.
2. Place and pay an order for 2 units. Confirm `inventory_quantity` fell by 2 and
   `inventory_reservations.status = 'finalized'`.
3. `PATCH /api/admin/orders/<orderId>` with `{"action":"cancel"}` → 200,
   `fulfillment_status = 'cancelled'`.
4. Re-read `inventory_quantity`: **still 2 lower**. Re-read
   `inventory_reservations`: still `finalized`.
5. Run `/api/cron/sweep` and confirm `reservationsExpired` does not include it and
   the count never returns.

### Smallest safe root-cause fix

Restock on cancel, behind the same claim the webhook uses, and only for the
transitions where the goods demonstrably never left:

```ts
if (action === "cancel") {
  const cancelled = await setOrderFulfillmentStatus({ … });
  if (!cancelled.ok) return …;

  // The goods never left: FULFILLMENT_TRANSITIONS only reaches `cancelled`
  // from awaiting_payment / paid / ready_to_fulfill / packed, all pre-carrier.
  // This is the case payment-webhook.ts's restock covers; the refund path's
  // "leave stock alone" rule is about a RETURNED unit of unknown condition,
  // which this is not.
  if (await claimInventoryRestock(orderId)) {
    await restockInventoryForOrder(items);
  }
}
```

`claimInventoryRestock` (`src/lib/inventory-fulfillment.ts:104`) already exists
and is already the exactly-once gate for this, so a later processor-driven refund
on the same order cannot double-restock.

Also worth doing: `stock_status` is set to `'Out of Stock'` on the way down and
nothing in `restockInventoryForOrder` is shown here to set it back. Whoever lands
this must confirm the status flips back, or a restocked product stays unbuyable
with stock on hand.

### Regression test to write

Cancel a paid order against a stubbed inventory layer and assert
`restockInventoryForOrder` was called with the order's lines. Negative control:
remove the call and confirm the test fails on the missing restock — not on a stub
error. Add a second assertion that cancelling **twice** restocks once, proving the
claim is doing its job.

### CROSS-BLOCK

- `src/app/api/admin/orders/[orderId]/route.ts` — **Block I** owns
  `src/app/api/admin/**`. This is their edit.
- `src/lib/inventory-fulfillment.ts` — **Block D** owns `inventory-*.ts`. No
  change needed; the fix reuses `claimInventoryRestock` and
  `restockInventoryForOrder` as they are. The `stock_status` question above is
  Block D's to answer.
- Block D is also auditing "non-atomic status writes" in the fulfillment area.
  This is adjacent but distinct: not a torn write, a missing one.

---

## K-18 — The store collects four separate compliance attestations and keeps a durable record of none of them on the card lane

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** legal/policy

### What is wrong

There are two attestation points, and between them the store keeps essentially no
evidence.

**1. The age gate collects four statements and stores them in `sessionStorage`.**

`src/components/age-gate.tsx:53-56` explains the design:

> Each statement is acknowledged individually: a single combined tick is one click
> that stands for four different representations, which is exactly the assent a
> regulator would question. Entry is refused until all four are made.

The four are "I am 21 years of age or older", "I represent a laboratory, business,
educational institution, or qualified research organization", and two more. The
reasoning is sound and the design is deliberate.

The result is then held in `sessionStorage` and nowhere else. The module's own
header (`:26-50`) records why: a 30-day localStorage token was "TOO LONG" because
"a shared device carried one person's attestation to the next", and React state
alone was "TOO SHORT". `sessionStorage` is the right *lifetime* for gating entry.

But it is a **gate**, not a **record**. Nothing is ever sent to the server. The
store has built an attestation specifically for regulatory defensibility and
retains no evidence that any individual customer ever made it.

**2. The card checkout validates its acknowledgements and then discards them.**

```ts
// src/app/api/checkout/create-session/route.ts:59
if (!hasRequiredAcknowledgements(body.complianceAcknowledgements)) { … }
```

That is the only use. The object is checked and dropped. A full trace confirms
there is no other consumer:

```
src/app/checkout/page.tsx:601                  complianceAcknowledgements: acknowledgements,   (sent)
src/app/api/checkout/create-session/route.ts:59  hasRequiredAcknowledgements(...)              (validated, discarded)
src/app/api/checkout/express/session/route.ts:194  compliance_copy_version: COMPLIANCE_COPY_VERSION  (the ONLY write)
```

Only `express_checkout_intents` gets `compliance_ack`, `compliance_acked_at` and
`compliance_copy_version`. The `orders` table has no equivalent column in any file
under `src/lib/sql/`.

So **every card order placed to date has no record of what the customer agreed
to** — while an Apple Pay order does.

**3. And the version stamp the express lane does keep can silently go stale.**

```ts
// src/lib/express-wallet.ts:44
export const COMPLIANCE_COPY_VERSION = "2026-08-25";
```

A hand-maintained literal in a different file from the copy it versions
(`src/lib/checkout-confirmations.ts`). Nothing ties them: the wording can be
edited without the constant changing, and the stamp then asserts a version the
customer never saw. A version number that can drift from the thing it versions is
worse than none, because it is trusted.

### Why this matters more than usual here

`src/lib/checkout-confirmations.ts:4` records that both boxes now start
**pre-ticked** by product decision — accepting that a pre-ticked box evidences
"did not object" rather than "affirmatively agreed". That is a defensible trade
**only if the submitted values are recorded**, so the store can show what was
presented and what came back. They are not. The weaker form of consent was
adopted and the compensating record was not built.

The acknowledgement also incorporates the Research Disclaimer by reference — and
`getPolicy` (`src/lib/legal-content.ts:209-224`) silently falls back to the coded
launch-day DEFAULTS on any control-store read failure, while always rendering
`updated: "2026"` (a hardcoded literal, `:217`). So a reader cannot tell whether
they are looking at the current policy or the fallback, and afterwards there is no
way to establish which text any given card customer agreed to.

### Impact

For the primary checkout lane the store cannot answer, for any order: *what did
this customer attest to, and when, and against which version of the wording?*
That is the question a regulator, a payment processor in a chargeback, or an
insurer asks first, and it is the question the age gate's own design comment
anticipates.

The express lane can answer it, imperfectly. The card lane — the majority path —
cannot answer it at all.

### Reproduction

```
grep -rn 'compliance' website/src/lib/sql/*.sql
```
→ the only orders-adjacent hits are in `express-checkout.sql`.

Then place a card order end to end and `select * from orders where order_id='<id>'`
— no acknowledgement column exists. Contrast:
`select compliance_ack, compliance_acked_at, compliance_copy_version from express_checkout_intents order by created_at desc limit 1`
after one Apple Pay tap.

For the drift half: `git log -p --follow website/src/lib/checkout-confirmations.ts`
and compare the dates of copy changes against changes to
`COMPLIANCE_COPY_VERSION` in `src/lib/express-wallet.ts`. Any copy change without
a matching bump is a stamp asserting the wrong version.

### Smallest safe root-cause fix

1. **Persist the card lane's acknowledgement**, matching the express lane exactly:
   add `compliance_ack jsonb`, `compliance_acked_at timestamptz`,
   `compliance_copy_version text` to `orders`, and write them in `buildOrderRow`
   from the object `create-session` already receives and validates. The data is in
   hand; only the write is missing.
2. **Derive the version instead of maintaining it.** Hash the presented copy:
   `COMPLIANCE_COPY_VERSION = sha256(REQUIRED_CONFIRMATIONS.map(c => c.text).join("\n")).slice(0,12)`.
   The stamp then cannot drift from the wording, because it *is* the wording.
   Keep the date as a human-readable label alongside it if useful.
3. **Record the age-gate attestation once per session**, server-side — a single
   POST on acceptance carrying the four statement ids and the copy hash, keyed to
   the session, joinable to an order later. This does not change the gate's
   lifetime (`sessionStorage` stays the right gating mechanism) and does not make
   it a tracking identifier; it makes the attestation evidenceable.
   **Note for whoever lands this:** that POST is itself a server-side write about
   a visitor, so it must be reconciled with the Cookie Policy in the same pass —
   see K-04. An attestation record is arguably essential rather than analytic, but
   the policy text must say so rather than being silent.

### Regression test to write

A source-text test asserting `COMPLIANCE_COPY_VERSION` equals the hash of the
current `REQUIRED_CONFIRMATIONS` text. It fails the moment the copy changes
without the version, which is the drift this is meant to stop. Negative control:
edit one confirmation's wording and confirm the test fails naming it.

Plus a route test that a card order persists the acknowledgement object. Negative
control: remove the write and confirm it fails on the null column.

### CROSS-BLOCK

- `src/lib/quote-order.ts` `buildOrderRow` — **shared file, earlier-lettered block
  wins.** The orders-table write lands there.
- `src/app/api/checkout/create-session/route.ts` and `src/app/checkout/page.tsx` —
  unowned; **Block G+H** are exercising checkout in the browser and should confirm
  the pre-ticked state and the four age-gate statements render as described.
- A migration adding three columns to `orders` needs the owner's approval under
  Rule 4 of the parallel-assignment contract. **Not attempted here.**

### Also checked, and clear

- The age gate's *lifetime* logic is correct and well-reasoned. `sessionStorage`
  read through `useSyncExternalStore` survives refresh, full-document navigation,
  back/forward and the payment round trip, and is gone when the tab closes. The
  header (`age-gate.tsx:26-50`) records both previous wrong answers and why each
  was wrong. Being signed in grants nothing — "authentication and age attestation
  are separate". **This is not the defect; the missing record is.**
- The gate refuses entry until all four statements are individually acknowledged,
  and the decline path clears the legacy `localStorage` key and `vl_age_verified`
  cookie (`:387-394`) before navigating away.

---

---

## K-19 — Every call to the payment processor has no timeout, while the ad pixels and the label printer all have one

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** third-party degraded mode

### What is wrong

Eleven outbound `fetch` call sites in `src/lib/`. Four set a deadline. The four
that do are the least consequential; the ones that talk to the payment processor
do not.

| call site | external system | what it does | timeout |
|---|---|---|---|
| `src/lib/payment-provider.ts:164` | **Veyra** | creates the customer's checkout session | **none** |
| `src/lib/veyra-membership.ts:112` | **Veyra** | starts a membership — **a real charge** | **none** |
| `src/lib/veyra-membership.ts:238` | **Veyra** | cancel / skip / pause | **none** |
| `src/lib/express-reconcile.ts:68` | **Veyra** | polls session status **inside the cron sweep** | **none** |
| `src/lib/email/providers/resend.ts:25` | Resend | sends transactional mail | **none** |
| `src/lib/email/providers/sendgrid.ts:29` | SendGrid | sends transactional mail | **none** |
| `src/lib/inventory-reservation-check.ts:60` | Supabase REST | reachability probe | **none** |
| `src/lib/shippo/client.ts:264` | Shippo | rates and labels | ✅ 15s |
| `src/lib/ads/tiktok-events-api.ts:186` | TikTok | conversion reporting | ✅ 8s |
| `src/lib/ads/reddit-conversions.ts:189` | Reddit | conversion reporting | ✅ 8s |
| `src/lib/ads/tiktok-ads-api.ts:79` | TikTok Ads | campaign management | ✅ |
| `src/lib/ads/relay-client.ts:38` | first-party, browser | funnel relay | n/a |

The Shippo client even states the rule (`shippo/client.ts:38-44`):

> A hung connection must not hold an admin request open forever, and a label
> purchase is a foreground action someone is waiting on. 15s is well past Shippo's
> normal response time … while still failing fast enough to show a usable error.

That reasoning applies with more force to creating a checkout session, which is a
foreground action a *customer* is waiting on. It was applied to the label printer
and to three advertising endpoints, and not to the processor.

### The three that matter, in order

**1. `payment-provider.ts:164` — the shopper's checkout session.**
`/api/checkout/create-session` declares no `maxDuration`, so it inherits the
platform default. A hung Veyra leaves the shopper watching a spinner until the
platform kills the function, then shows whatever generic error that produces —
after an order row may already have been written and inventory reserved.

**2. `express-reconcile.ts:63-77` — inside the 60-second shared cron budget.**

```ts
async function fetchSessionStatus(sessionId: string): Promise<VeyraSessionStatus | null> {
  try {
    const response = await fetch(`${veyraApiBase()}/api/v1/checkout_sessions/${…}`, {
      headers: { Authorization: `Bearer ${veyraSecretKey()}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as VeyraSessionStatus;
  } catch { return null; }
}
```

No deadline, and a bare `catch { return null }`. This runs inside
`reconcileVeyraPendingPayments`, which pages **newest-first, 10 pages × 50** — up
to 500 sequential calls — against `maxDuration = 60`
(`src/app/api/cron/sweep/route.ts:15`) shared with twelve other concurrent jobs.

One slow Veyra response holds the slot with no bound. A whole-function kill raises
no alert (the sweep's alert at `:91-101` fires only on a rejected promise, and the
handler is never reached), so the job the file's own comment calls "the exact
failure this file exists to prevent" — *money moved, order reads unpaid, stock
released at reservation expiry* — silently stops running.

The Phase 1 map's suggested proof for the sweep-visibility finding is literally
"point `VEYRA_API_BASE` at a blackhole so `fetchSessionStatus` stalls". There is
nothing in the code to stop that stall.

**3. `catch { return null }` erases the distinction that matters.** A network
error, a 500, a timeout and "no such session at Veyra" all produce `null`. The
caller cannot tell "Veyra is down" from "this session does not exist", so a total
processor outage is reported as a run in which every order was merely
*unresolved*.

**4. The two email providers** have no deadline either, and `retryPendingEmails`
loops up to 50 rows sequentially inside the same 60-second budget. A slow SMTP
provider consumes the whole sweep.

### Impact

The store's most important external dependency is the only one with no deadline.
A degraded — not down, *degraded* — Veyra hangs customer checkouts, hangs the
membership charge path, and silently disables the reconciliation job that is the
only thing standing between a charged card and an order that reads unpaid forever.
None of it alerts.

### Reproduction

Point `VEYRA_API_BASE` at a blackhole (an IP that accepts the connection and never
responds — `nc -l` on an unused port) on the harness, then:

1. `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/sweep -w '%{time_total}'`
   → observe the platform timeout, not a 60s graceful result. Then
   `select * from system_alerts where type='cron_sweep_failed' order by created_at desc limit 5`
   → **zero new rows**.
2. `POST /api/checkout/create-session` from the storefront and time it → hangs to
   the platform limit.
3. Contrast: point `SHIPPO_API_BASE` at the same blackhole and buy a label →
   fails in ~15s with a usable error, which is the behaviour every one of these
   should have.

### Smallest safe root-cause fix

Give every outbound call a deadline, using the mechanism already in the codebase:

```ts
// src/lib/shippo/client.ts:279 — copy this
signal: AbortSignal.timeout(TIMEOUT_MS),
```

Suggested values, matching the existing rationale: **10s** for the two
foreground Veyra calls (checkout session, membership start — a customer is
waiting), **5s** for `express-reconcile`'s poll (it is a background retry with up
to 500 iterations in a 60s budget; failing fast and coming back in 30 minutes is
strictly better than hanging), and **10s** for the two email providers.

Then **stop collapsing the failure modes.** `fetchSessionStatus` should
distinguish *unreachable* from *not found*:

```ts
catch (e) {
  return { kind: "unreachable", error: String(e) };   // not the same as a 404
}
```

so `reconcileVeyraPendingPayments` can raise a `recordSystemAlert` when the
processor is unreachable rather than reporting a quiet run of `unresolved`.

### Regression test to write

A source-text test asserting every `fetch(` in `src/lib/**` (excluding
`relay-client.ts`, which is browser-side and first-party) is accompanied by a
`signal:` within its options object. This is the shape that keeps regressing —
four call sites got it and seven did not — and a new call site added later would
otherwise inherit the omission silently. Negative control: remove the signal from
`shippo/client.ts` and confirm the test names that file.

Plus a behavioural test with a stubbed `fetch` that never resolves, asserting
`fetchSessionStatus` rejects or returns an `unreachable` result within the
deadline. Negative control: remove the signal and confirm the test times out.

### CROSS-BLOCK

- `src/lib/email/providers/resend.ts` and `sendgrid.ts` — **Block C** owns
  `src/lib/email/**`. Two one-line additions; flag it to them.
- `src/lib/shippo/client.ts` — **Block D**, no change needed; it is the model.
- `src/lib/payment-provider.ts`, `src/lib/veyra-membership.ts`,
  `src/lib/express-reconcile.ts` — unowned. Block K can carry these.
- **Block A** (concurrency/idempotency) should know that adding a timeout to
  `payment-provider.ts:164` creates a new state — *the session may or may not have
  been created at Veyra* — which is precisely the case
  `reconcileVeyraPendingPayments` exists to settle. The timeout does not create
  that risk (a platform kill already produces it, without the bound); it makes it
  explicit and survivable. Worth their eyes on the ordering.

---

---

## K-20 — Four tables are written and never read, and two of them double the visitor data the store retains for no benefit at all

**Grade:** `SOURCE-INSPECTED` · **Severity:** P2 · **Status:** OPEN
**Area:** dead/legacy/dormant code (with a privacy consequence)

### Method

Every `.from("<table>")` call site in `src/` (excluding `*.test.ts` and
`src/lib/e2e/`) was classified as a read or a write, and the two sets compared.
Sixty-one tables; four are write-only. Multi-line chains were then resolved by
hand — the four below were each re-checked with
`grep -rn '"<table>"' src --include=*.ts --include=*.tsx`, and the complete
result for each is quoted.

### The four

```
email_campaign_clicks   src/app/api/email/click/route.ts:65        insert     — 0 reads
product_cost_changes    src/lib/admin-products.ts:635              insert     — 0 reads
product_subscriptions   src/app/api/catalog/subscribe-save/route.ts:63  insert — 0 reads
referrals               src/app/r/[code]/route.ts:49               insert
                        src/lib/partner-portal.ts:1717             delete     — 0 reads
```

(`referrals`' only other reference is a `.delete()` when a partner is removed —
cleanup, not a read.)

### `referrals` — this one corrects the Phase 1 map, and it matters

The map's sources-of-truth table records:

> Referral click counts | nothing — `src/app/r/[code]/route.ts` INSERTs the same
> click i… | `partner_clicks` (partner dashboard totalClicks), **`referrals`
> (event_type='click')**

implying two tables read by two different surfaces, and framing the risk as
*divergence* between them. **`referrals` is not read by anything.** The divergence
has no reporting consequence, because there is no second reader to diverge.

The real consequence is worse, and it is a privacy one. `/r/[code]` writes the
same six fields into `referrals` that it writes into `partner_clicks`:

```ts
supabaseAdmin.from("referrals").insert({
  partner_id: …, referral_code: …, event_type: "click", landing_path: …,
  utm_source: …, utm_medium: …, utm_campaign: …,
  referrer: request.headers.get("referer"),
  user_agent: request.headers.get("user-agent"),
  ip_address: ipAddress,          // RAW
});
```

So every affiliate click stores the visitor's **raw IP address, user agent and
referrer twice**, and the second copy is consumed by nothing, ever. K-04
establishes that this write happens before consent is asked and contradicts three
published promises; this finding establishes that **half of that data collection
buys the store nothing at all.**

That changes the fix. K-04's remedy for the second write is not "make the two
tables consistent" — it is **delete the `referrals` insert**. That is a strict
improvement on every axis: less PII retained, one fewer non-transactional write in
a `Promise.all` (the partial-failure defect Block A+B owns in the same file), and
no feature lost.

Contrast, and it is instructive: `email_campaign_clicks` writes `ip_hash`
(`src/app/api/email/click/route.ts:70-73`, via `hashIpAddress`). The campaign
tracker hashes the IP; the affiliate tracker stores it raw. Two click-tracking
paths in one codebase, opposite privacy postures.

### `email_campaign_clicks` — a per-click detail table nothing consumes

The route writes both a detail row **and** a first-click stamp on the recipient:

```ts
await supabaseAdmin.from("email_campaign_clicks").insert({ campaign_id, email, clicked_at, user_agent, ip_hash });
// First click only — `clicked_at` on the recipient row is "did this person ever click"
await supabaseAdmin.from("email_campaign_recipients").update({ clicked_at: … })
```

Reporting reads only the second: `src/lib/admin-email.ts:71-105` selects
`campaign_id, status, opened_at, clicked_at` from `email_campaign_recipients` and
tallies `if (row.clicked_at) tally.clicked++`.

So the detail table — the one that would answer "how many times did they click",
"from what device", "over what period" — is written on every click and read by
nothing. Either build the reader or stop writing the row; today the store pays the
storage and the retention obligation for neither.

### `product_cost_changes` — a cost audit trail nobody can see

`src/lib/admin-products.ts:635` writes `changeRows` on every product cost edit.
Nothing reads them. For a store whose profit engine derives margin from
`order_items.unit_cost_cents` (`src/lib/admin-profit.ts`), a cost-change history
that cannot be read means **an unexplained margin shift cannot be explained** —
the record exists and is unreachable. This is the most valuable of the four to
wire up rather than delete.

### `product_subscriptions` — confirmed dead, both sides

The Phase 1 lead is correct. One INSERT
(`src/app/api/catalog/subscribe-save/route.ts:63`), zero SELECTs anywhere.
`/account/subscriptions` renders *memberships* (`getCustomerMembership`,
`getMembershipBillingHistory`) and never touches this table; no admin route reads
it either.

A shopper who opts into Subscribe & Save therefore gets a confirmation, a row, and
nothing else: they cannot see, edit or cancel it, no admin can find it, and the
stored `discount_percent` is honoured by no pricing path. **The customer has
agreed to a recurring arrangement the system has no way to fulfil or to stop** —
which is the part that lifts this above ordinary dead code.

`getSubscribeSaveConfig` (`src/lib/admin-control.ts:402-414`) defaults
`enabled: cfg.enabled === true` — i.e. **off** unless explicitly turned on. That is
the only thing keeping this dormant, and it is one admin toggle away from being
live.

### Impact

Two tables of unread visitor data the store must nonetheless disclose, retain and
defend; one audit trail that cannot answer the question it was built for; and one
customer-facing feature that is a dead end from both sides and is enabled by a
single toggle.

### Reproduction

```
grep -rn '"referrals"'             website/src --include=*.ts --include=*.tsx | grep -v '\.test\.'
grep -rn '"email_campaign_clicks"' website/src --include=*.ts --include=*.tsx | grep -v '\.test\.'
grep -rn '"product_cost_changes"'  website/src --include=*.ts --include=*.tsx | grep -v '\.test\.'
grep -rn '"product_subscriptions"' website/src --include=*.ts --include=*.tsx | grep -v '\.test\.'
```

Each returns writes only. With database access, confirm the rows are accumulating:
`select count(*) from referrals;` etc.

### Smallest safe root-cause fix

Decide per table, and record the decision in the code so the next reader does not
have to re-derive it:

- **`referrals`** — delete the insert at `src/app/r/[code]/route.ts:49`. Drop the
  table once block M confirms no out-of-repo consumer. Highest value: it removes
  a duplicate store of raw PII **and** simplifies K-04.
- **`email_campaign_clicks`** — keep the write (it is already IP-hashed and is the
  only per-click detail available) and add the reader the campaign dashboard is
  missing; or delete it. Either is fine, silence is not.
- **`product_cost_changes`** — wire up a reader. An admin cost-history panel is
  small, and it is the only way to explain a margin change after the fact.
- **`product_subscriptions`** — while `subscribe_save` is off, the honest fix is a
  comment at `subscribe-save/route.ts:63` stating that nothing reads this table and
  the feature is incomplete, so it cannot be enabled by accident. **Do not enable
  `subscribe_save` until a customer-facing cancel path exists.**

### Regression test to write

Generalise the method: a test that parses every `.from("…")` in `src/` and fails
on any table with writes and no reads that is not on an explicit
`KNOWN_WRITE_ONLY` allowlist with a stated reason. That converts "dead table"
from an archaeology exercise into a build-time signal, and the allowlist forces
the decision to be written down. Negative control: add a write to a fresh table
name and confirm the test names it.

### CROSS-BLOCK

- `src/app/r/[code]/route.ts:49` — **Block A+B.** They already own two defects in
  this file (the non-transactional double write, and K-04's pre-consent
  tracking). **All three resolve to the same edit: delete the `referrals`
  insert.** That should be told to them as one change, not three.
- `src/lib/partner-portal.ts:1717` — **Block A+B.** The `referrals` delete becomes
  dead once the insert goes.
- `src/app/api/email/click/route.ts` — unowned, but adjacent to **Block C**'s
  email work.
- `src/lib/admin-products.ts` — unowned; **Block D** owns `catalog.ts` and
  inventory, which is adjacent but not this file.

### Also checked, and cleared

- `partner_program_stats` (`src/lib/partner-portal.ts:611`) reads with **no
  writer in `src/`**, which looks like the inverse defect. It is not:
  `src/lib/sql/affiliate-program-rls.sql:78-90` gives it public-select and
  admin-insert/update policies, and the read builds an `overrides` map. It is a
  deliberate manually-populated override table — almost certainly the mechanism
  behind ledger finding F-007 ("affiliate marketing figures are a deliberate
  pre-launch floor"). Working as designed.
- The other "no writer in `src/`" hits from the sweep — `commissions`,
  `order_email_log`, `notification_queue`, `marketing_subscribers`,
  `order_shipping_cost_audit`, `fulfillment_batches`, `admin_credentials` and
  others — are artefacts of the line-based classifier: their write is on the line
  *after* the `.from(...)`. Each was re-checked by hand and has a real writer.
  Recorded so block M does not re-chase them.

---

---

## K-21 — The trust-claims module says no hardcoded "99%" appears in the UI; the homepage hardcodes it, and checkout makes a different fulfilment promise from the rest of the site

**Grade:** `SOURCE-INSPECTED` · **Severity:** P1 · **Status:** OPEN
**Area:** legal/policy

### The module that exists to prevent this

`src/lib/trust-claims.ts` is the single source of truth for every customer-facing
trust claim, and its header records the exact incident it was written after:

> These strings were previously copied into eight files and had already drifted
> into four different versions of the same fulfilment promise — **"Ships within
> one business day"**, "Ships in 1 business day", "Most in-stock orders are
> prepared within one business day", and a bare "Fast Dispatch". Four wordings of
> one commitment is how a store ends up unable to say what it actually promised
> when a customer disputes an order.
>
> The rule for anything added here: a claim earns its place by being checkable
> against configuration, published policy, or an explicit decision by the owner
> that is recorded in the comment next to it. **Nothing goes in because it would
> convert well.**

The module is genuinely well-built. Every constant carries its provenance. The
problem is that two of the highest-traffic pages do not use it.

### Defect 1 — the homepage hardcodes the one number the module says never appears

`src/lib/trust-claims.ts:50-53` states it as a fact about the codebase:

> So: **no hard-coded "99%" appears anywhere in the UI.** The figure a customer
> sees is the figure the lab recorded for the lot in front of them, and where that
> record does not exist yet, nothing is claimed at all.

`src/app/page.tsx:28`:

```tsx
label: "99%+ Purity",
```

The statement is false. And the module's reasoning for why it matters is exactly
right: *"A number attached to a specific vial is a statement about that vial"*.
The homepage asserts it catalogue-wide, detached from any lot, while ledger
finding **F-006 establishes that ZERO COAs exist**.

The homepage's `TRUST_POINTS` array (`src/app/page.tsx:12-52`) is a **local
redeclaration** that shadows the shared one — and it is a *partial* import, which
is the worst version:

```tsx
import { FULFILMENT_SHORT } from "@/lib/trust-claims";   // page.tsx:8
…
label: "Based in the USA",              // :19  — no provenance anywhere
label: "99%+ Purity",                   // :28  — the module says this does not exist
label: FULFILMENT_SHORT,                // :39  — correctly sourced
label: "Third-Party Batch Verified",    // :48  — stronger than TESTING_SHORT ("Third-Party Tested")
```

One of four claims is sourced from the module. A reader seeing the import
reasonably assumes the array is governed by it.

"Third-Party Batch **Verified**" is also a materially stronger claim than the
canonical "Third-Party Tested" — *verified* implies documentation a third party
can inspect, which is precisely what does not exist yet. "Based in the USA" has no
provenance recorded anywhere in the codebase.

### Defect 2 — checkout makes a different fulfilment promise, on the screen where it counts

`src/app/checkout/page.tsx:182-187` is a second local redeclaration:

```tsx
const TRUST_POINTS = [
  { label: "256-bit SSL encrypted", … },
  { label: "Secure payment processing", … },
  { label: "Full batch traceability", … },
  { label: "Ships within 1 business day", … },
];
```

**"Ships within 1 business day"** is, word for word, one of the four drifted
variants the module's header lists as the reason it was created. The canonical
value is:

```ts
FULFILMENT_DETAIL = "Order by 2PM ET, ships same day (Mon–Fri)"
```

Those are different commitments. "Same day if ordered before 2PM ET on a weekday"
and "within 1 business day" resolve differently for an order placed at 3PM Friday.
The drifted one is on the **last screen before payment** — the version a customer
would quote in a dispute, and the one a card network would read as the promise
that induced the purchase.

The other two are equally unsourced:

- **"256-bit SSL encrypted"** — a specific technical assertion. The module
  deliberately declines to make it: `CHECKOUT_DETAIL = "Card details never touch
  our servers"`, with the note *"'Encrypted' describes the transport, and claims
  nothing about certification."* Checkout asserts a cipher strength instead, which
  is the kind of claim the module's own rule exists to exclude.
- **"Full batch traceability"** — stronger than the canonical
  `COA_SHORT = "COA Documented"`, made site-wide, with zero COAs on file.

### Defect 3 — "COA Documented" is on the age gate and the footer, ungated

This sharpens F-006 rather than repeating it, by naming where and why.

`COA_SHORT` is *per-product* gated — `hasCoa()` in `coa-url.ts` rejects
placeholders like `"pending"` and `"TBD"` — and the module's docblock explains
that the site-wide strings are "deliberately weaker than the per-product ones"
because "a catalogue-level badge is a statement about the programme".

That reasoning holds for `TESTING_SHORT` ("Third-Party Tested"), which describes
how the store operates. It does **not** hold for "COA **Documented**", which is a
claim that documents exist. It is rendered ungated in the two highest-visibility
places on the site:

- `src/components/site-footer.tsx:67` — `TRUST_POINTS.map(…)`, all four, **every page**
- `src/components/age-gate.tsx:483` — `TRUST_POINTS.slice(0, 3)`, i.e. Testing,
  **COA**, Checkout — **the first screen any visitor sees**

By the module's own admission rule — *checkable against configuration, published
policy, or a recorded owner decision* — this claim is checkable and currently
false.

### Impact

The store's compliance posture is its differentiator, and its trust strip is where
that posture is asserted. Today it asserts a purity figure no document supports,
"batch traceability" and "COA Documented" with zero certificates on file, and — on
the payment screen specifically — a fulfilment commitment that contradicts the one
every other page makes.

The mechanism that would have caught all of it exists, works, and is bypassed by
local copies in the two pages that matter most.

### Reproduction

```
grep -rn "TRUST_POINTS" website/src --include=*.tsx | grep -v '\.test\.'
```
→ `site-footer.tsx` and `age-gate.tsx` import the shared constant;
`src/app/page.tsx:12` and `src/app/checkout/page.tsx:182` **declare their own**.

```
grep -rn '99%' website/src --include=*.tsx | grep -v '\.test\.'
```
→ `src/app/page.tsx:28`, contradicting `trust-claims.ts:50`.

In the browser: load `/`, `/checkout` and any product page at 390×844 and read the
four trust strips side by side. Three different fulfilment wordings and two
different testing claims. **Block G+H should capture this as a screenshot set** —
it is more persuasive rendered than quoted.

### Smallest safe root-cause fix

1. Delete both local `TRUST_POINTS` arrays and render from
   `TRUST_POINTS_DETAILED`, keeping each page's own icons. The shared array is
   already shaped for this (`trust-claims.ts:118-124`).
2. Any claim not currently in the module and worth keeping — "Based in the USA" —
   gets added there **with its provenance comment**, per the module's stated rule,
   or is dropped.
3. **Remove `COA_SHORT` from `TRUST_POINTS` until at least one COA is published.**
   It can return the day the COA Library is non-empty; nothing else needs to
   change. The per-product badge already gates itself correctly and can stay.
4. Delete `"99%+ Purity"` and `"Full batch traceability"` outright. Both are
   product-level claims being made catalogue-wide, which is the distinction the
   module already draws correctly for testing.

### Regression test to write

A source-text test — the pattern this codebase already uses successfully, and the
one that caught a consent-copy regression (`cookie-consent.tsx:76-80`):

- assert no file under `src/app/` or `src/components/` declares a local
  `TRUST_POINTS`;
- assert no `.tsx` outside `trust-claims.ts` contains a percentage literal
  adjacent to "purity", or the strings "batch traceability", "SSL", or a
  fulfilment phrase not exported from the module.

Negative control: re-add `"99%+ Purity"` to `page.tsx` and confirm the test names
that file and line. This is the only mechanism that will hold — the module was
already the right idea and drift beat it twice.

### CROSS-BLOCK

- `src/app/page.tsx` and `src/app/checkout/page.tsx` — unowned by any block, but
  **Block G+H** are exercising both in the browser and should screenshot the three
  strips before anything changes, so the drift is evidenced rather than asserted.
- Ledger **F-006** ("Zero COAs exist, but the storefront advertises COA
  documentation") should be updated with the two exact render sites above rather
  than left as a general statement.

### Also checked, and clear — `trust-claims.ts` itself is exemplary

Recorded deliberately, because the finding above should not read as a criticism of
the module:

- Every constant carries a provenance comment naming an owner decision, a
  configuration value, or a published policy. `DESTINATIONS_SENTENCE` is annotated
  *"Enforced, not aspirational: quote-order.ts rejects any address outside these
  two countries"* — and that is true.
- `RESEARCH_USE_SENTENCE` records that a scan of all 111 public URLs found the full
  restriction ("Not for human or veterinary use") only inside a **collapsed,
  conditionally-rendered** Description tab, and that earlier compliance sweeps
  reported it clean because they were reading the age gate's copy rather than the
  pages. It is now rendered at `site-footer.tsx:92` and
  `product-detail-client.tsx:665`. **Fixed, and the fix is verifiable.**
- `FULFILMENT_CUTOFF = "2PM ET"` is a promise in the business timezone and
  **nothing in the code computes it** — a repo-wide search for cutoff logic,
  `getHours`, or a 14:00 boundary finds only `admin-analytics.ts:37` and
  `admin-auth.ts:43`, neither related. So it cannot be computed in the wrong zone.
  Clean for this block's timezone sweep. Worth noting separately that because
  nothing computes it, the site cannot tell a customer ordering at 3PM ET that
  they have missed today's cutoff — it shows them the same "ships same day" badge.
  That is a product decision, not a defect, and it is stated here so it is a
  decision rather than an oversight.

---

---

---

## K-22 — A coupon that loses the discount competition is still stamped on the order and still redeemed, burning a one-shot code for nothing

**Grade:** `BEHAVIORAL-TEST-PROVEN` (the competition) + `SOURCE-INSPECTED` (the redemption chain) · **Severity:** P2 · **Status:** OPEN
**Area:** money and numeric precision (found while closing that area's open item)

### What is wrong

Only **one** discount applies to an order. `resolveCustomerDiscount` (server) and
`resolveCartDiscount` (`src/lib/discount-resolution.ts:68-83`) pick the largest
candidate from bulk savings, member pricing, ambassador personal, the promo, and
the coupon — and discard the rest.

The coupon is recorded and redeemed regardless of whether it won:

```ts
// src/lib/quote-order.ts:586   — validate
? await validateCoupon(input.couponCode, discountBase, input.customer.email, { isActiveMember: … })
// src/lib/quote-order.ts:870   — carried forward, whether or not it won the competition
couponCode: coupon?.code ?? null,
// src/lib/quote-order.ts:976   — stamped on the order row
coupon_code: input.couponCode,
// src/lib/payment-webhook.ts:1331, 1510
const effectiveCouponCode = orderRecord?.coupon_code ? String(orderRecord.coupon_code) : eventPayload.couponCode;
…
if (effectiveCouponCode) {
  …redeemCoupon(effectiveCouponCode)
```

`if (effectiveCouponCode)` is the entire condition. Nothing asks whether the
coupon produced the discount that was actually applied.

### Why this is not a rare tie-break

It fires whenever any other candidate beats the coupon, which is ordinary:

- A **member** with member pricing worth more than a 5% cart-recovery code enters
  the code anyway (it was emailed to them). Member pricing wins, the code is
  redeemed.
- A cart at a **bulk-savings tier** worth more than the coupon.
- An **ambassador** using their personal discount.

Cart-recovery coupons are minted `max_redemptions: 1` with an `assigned_email`
(`src/lib/cart-recovery.ts:135-138`) — personal and one-shot. Burning one is
permanent for that customer.

For a store-wide limited code, every such order consumes a redemption slot from
the campaign's cap while discounting nothing, so the cap is reached early and
later customers are told *"This coupon has reached its redemption limit"* for
orders that were never discounted.

### Evidence — the competition, probed against the real function

```
$ TZ=UTC npx vitest run scratchpad/k-disc.test.ts
  bulk 50.004 vs member 50.000 -> bulk_savings 50
  bulk 50.00 vs member 50.01 -> member_pricing 50.01
  0.1+0.2 = 0.30000000000000004 vs 0.3 -> bulk_savings 0.3
  bulk 40 vs coupon 40 -> bulk_savings
  member 40 vs coupon 40 -> member_pricing
  discount 999 on a 500 subtotal -> 500
  negative candidate -> null

 Test Files  1 passed (1)   Tests  5 passed (5)
```

Rows 4 and 5 are the finding: with an equal or larger competing discount the
coupon does not win — and the redemption chain above does not care.

### Impact

A customer who receives a personal recovery code, applies it, and happens to hold
a better discount loses the code permanently and gets nothing for it. From their
side the code silently "worked" — no error, no message that it was superseded.
When they try it on the next order it reports as already used.

The store also loses the campaign-cap accounting: `redemptions_count` measures
orders that *carried* a code, not orders a code *discounted*, so the redemption
metric overstates the campaign's reach and the cap binds early.

### Reproduction

1. Give a customer an active membership whose member-pricing discount on a test
   cart exceeds 5%.
2. Mint a cart-recovery coupon for them (`max_redemptions: 1`, `assigned_email`).
3. Place an order applying that code.
4. `select coupon_code, discount_amount from orders where order_id='<id>'` → the
   code is recorded, and `discount_amount` equals the **member-pricing** amount,
   not the coupon's.
5. `select redemptions_count from coupons where code='SAVE-…'` → **1**.
6. Try the code on a second order → *"This coupon has reached its redemption
   limit"*.

### Smallest safe root-cause fix

Record the coupon only when it is the discount that applied. `quoteOrder` already
knows which candidate won — that is what `resolveCustomerDiscount` returns — so
carry that through instead of the validated code:

```ts
// quote-order.ts:870
couponCode: appliedDiscount?.type === "coupon" ? (coupon?.code ?? null) : null,
```

That fixes the redemption automatically, because `payment-webhook.ts:1331` reads
`orders.coupon_code`.

**Then tell the customer.** Today a superseded coupon is silently swallowed. The
quote already knows both amounts, so the cart can say *"Your membership discount
of $X is larger than coupon SAVE-… ($Y), so we applied the membership discount and
kept your code for next time."* That converts a silent loss into a good outcome,
and it is the difference between a support ticket and a retained code.

If the business would rather keep recording the entered code for attribution, add
a separate `coupon_code_entered` column and redeem only on `coupon_code` — but do
not conflate "entered" with "redeemed", which is the current defect.

### Regression test to write

Quote an order where member pricing beats the coupon and assert
`buildOrderRow`'s `coupon_code` is null while `discount_amount` equals the member
amount. Negative control: restore `coupon?.code ?? null` and confirm the test
fails on the recorded code.

Second test: assert `redeemCoupon` is not called for an order whose applied
discount was not the coupon.

### CROSS-BLOCK

- `src/lib/quote-order.ts:870` — **shared file, earlier-lettered block wins.** One
  line.
- `src/lib/payment-webhook.ts:1331,1510` — **Block A+B.** No change needed if the
  quote-order fix lands; flag it so they do not fix it a second way.
- **Block D** owns the discount resolvers and should confirm the server's
  `resolveCustomerDiscount` in `profit-engine.ts` returns the winning type in a
  form `buildOrderRow` can read.

### Also checked, and clear — the float-comparison concern in this area is not real

This closes the `NOT VERIFIED` item on `resolveCartDiscount`'s float compare:

- `compete()` (`discount-resolution.ts:71`) applies
  `Math.round(value * 100) / 100` **before** any comparison, so two candidates
  differing by less than a cent are equal by the time `resolveBestDiscount` sees
  them. `50.004` vs `50.000` both resolve to `50`, and `0.1 + 0.2` resolves to
  `0.3` exactly. **A sub-cent float difference cannot decide which discount
  applies.**
- The result is clamped to the subtotal (`999` on a `500` cart → `500`) and
  negative candidates are rejected (`resolveBestDiscount` requires `amount > 0`),
  so a stacked discount cannot produce a negative total from here.
- On an exact tie the strict `>` in `resolveBestDiscount:29` means the first
  candidate in the array wins — bulk, then member, then ambassador, then promo,
  then coupon. **The money is identical either way**; only the displayed label
  differs. That ordering is what surfaces K-22, but it is not itself a defect.

---

---

## Dead-code sweep, part 2 — API routes, and why the two money-spending orphans are NOT a finding

**Grade:** `SOURCE-INSPECTED` · **Severity:** none · **Status:** NOT A DEFECT
**Area:** dead/legacy/dormant code

Recorded because it looked like a serious finding for three steps and is not, and
because the next session will otherwise re-derive the same false start.

### Method

All 141 route files under `src/app/api` enumerated, then matched against every
textual reference in `src/`. Twelve had no literal match; each was re-checked by
hand, because most are called through template literals
(`` fetch(`/api/admin/orders/${orderId}/…`) ``) that a literal match cannot see.
Ten resolved to real callers. Two did not:

```
/api/admin/orders/[orderId]/shipping/rates    no UI caller
/api/admin/orders/[orderId]/shipping/label    no UI caller  (POST buys postage, DELETE voids it)
```

### Why they look alarming

`src/lib/shippo/push-trigger.test.ts:90-100` documents their removal from the UI:

> Each of these was a control that duplicated Shippo. **Hiding them would leave
> the endpoints reachable and the page heavy; they are gone.**

The *controls* are gone; the *endpoints* are still there. The stated reason for
removing rather than hiding was endpoint reachability, and the endpoints remain
reachable. The route's own docblock adds that these are "**the only two endpoints
in this codebase that spend money at a carrier**" and that "there is no role gate
beyond 'is an admin'".

### Why it is nonetheless not a defect

The money is gated off, one level below the route, where every caller inherits it:

```ts
// src/lib/shippo/service.ts:1074-1076
export function labelPurchasingEnabled(): boolean {
  return String(process.env.SHIPPO_ALLOW_LABEL_PURCHASE ?? "").trim().toLowerCase() === "true";
}
// …and inside purchaseLabelForOrder, at "1b. POLICY GATE — placed exactly here,
//    and the position is the point."
```

Default **off**. And the refusal is operator-friendly rather than a bare error
(`:1071-1072`):

> "Vanta does not buy postage. Purchase this label in Shippo — it will sync back
> here automatically with its tracking number and real carrier cost."

Label purchasing also is not dead overall: `src/lib/fulfillment-labels.ts:285`
drives it from the batch workstation via `/api/admin/fulfillment/labels`. So these
two per-order routes are **superseded duplicates**, not an orphaned feature — and
the gate they would have to pass is the same one the live path passes.

### What is still worth doing, and for whom

- Delete the two route files. They are duplicates of a live path, they carry the
  only DELETE that voids a label, and the test that documents the cleanup names
  endpoint reachability as the reason it was done. Finishing the cleanup matches
  its own stated intent.
- **CROSS-BLOCK: Block I.** "Capability gates on money-spending admin routes" is
  explicitly their scope. The route states plainly that any admin — including
  staff — can buy or void postage, with the rationale that "making staff wait for
  a manager to void a mis-bought label would leave a wrong label live". That is a
  defensible argument, and it is theirs to accept or reject; it is recorded here
  rather than judged. Note the same reasoning is not applied elsewhere:
  `canManageCoupons` gates even *reading* the coupon list.

### The other ten, resolved

`coa/[coaId]/file`, `admin/coa/[coaId]/file`, `coupons/[couponId]/announce`,
`email/campaigns/[campaignId]/send` and `/stop`, `orders/[orderId]/communications`,
`orders/[orderId]/packing-slip`, `shipping/label/print`, `shipping/sync`,
`products/[productId]/duplicate` — all called from components via template
literals. No action.

---

# Block K — coverage and handoff

## Coverage against the seven assigned areas

The audit standard requires every item to be ✅ or explicitly `NOT VERIFIED` with
a reason. Nothing below is graded higher than its evidence.

| area | status | what was done | what is still owed |
|---|---|---|---|
| **Time / date / timezone** | ✅ | 8 findings (K-01, K-03, K-05, K-07, K-08, K-09, K-10, K-12). Every customer-facing date formatter swept; coupon `starts_at`/`ends_at`, membership grace/renewal/skip, store-credit month, birthday, offers-bar urgency all exercised. Five probes run. | Nothing material. DST-specific behaviour is inherently covered by the instant-comparison style used throughout, and the one `+365d` annual term drifts a day per leap year — noted, too small to number. |
| **Money / numeric precision** | 🟨 | K-11 (points round-trip, exhaustive probe over 100k values) and K-22 (a losing coupon is still redeemed). Disproved the Phase 1 Buy-3-Get-1 P1 lead in writing, and closed the `resolveCartDiscount` float-compare question as a negative result. Verified `bundle-pricing.ts` and `calculateCardProcessingFee` are correct. Ruled out `numeric(12,2)` overflow. | **`NOT VERIFIED`: sales-tax rounding** (per-line vs on-total, and whether `admin-tax-report` re-derives it the same way) — belongs with Block F, who own `admin-tax-report.ts`. **`NOT VERIFIED`: percent round-trip through `numeric(5,2)`** — needs a database. |
| **Dead / legacy / dormant code** | 🟨 | K-20, from a full 61-table read/write classification (confirmed the `product_subscriptions` lead, corrected the map on `referrals`, cleared `partner_program_stats`), plus a full 141-route sweep — 2 orphans found, investigated and cleared as not-a-defect. | **`NOT VERIFIED`: unreferenced exports, unimported components, SQL columns no TS reads.** The table and route sweeps were run; these three were not. |
| **Environment / config drift** | ✅ | K-06 (the `admin_control` reader table, all ten) and K-16 (pixel-ID defaults, plus four negative controls on the payment kill switches). Full `process.env` enumeration done. | The Vercel-side question — whether `TIKTOK_EVENTS_API_ACCESS_TOKEN` and `REDDIT_CONVERSIONS_ACCESS_TOKEN` are scoped per-environment — **cannot be answered from source**. It needs the dashboard, and it decides how bad K-16 is in practice. |
| **Legal / policy** | ✅ | K-04, K-17, K-18, K-21. Every policy DEFAULT read and checked against behaviour; age gate, compliance attestations, trust claims, consent, cancellation promise. | **`NOT VERIFIED`: the shipping and terms policies** were read but not line-by-line reconciled against `getShippingConfig`/`calculateShipping`. Lower value than the four found, but not done. |
| **Third-party degraded mode** | ✅ | K-13, K-15, K-19. Every dependency classified fail-open/fail-closed; all 11 outbound `fetch` sites tabulated for timeouts. | **`NOT VERIFIED`: retry semantics on non-idempotent operations.** Timeouts were swept; retry-of-a-charge was not traced end to end. |
| **Background jobs / cron** | 🟨 | K-13, K-14, and K-03's missing claim. Cadence-vs-semantics, failure visibility, maintenance blast radius, the heartbeat gap. | **`NOT VERIFIED`: the per-job bounds/claims table for all 13.** Partially covered via the Phase 1 map, but not independently re-derived here. Specifically not re-verified: `retryPendingEmails`' missing claim (duplicate real transactional mail), the Shippo sweeps' head-of-line blocking, and `runAutomationSweep` paging the whole orders table. **These are real and already documented in `PHASE1-SYSTEM-MAP.md`; they are unconfirmed only in the sense that this block did not independently reproduce them.** |

**Honest summary:** 21 findings, 6 with runnable probes (`BEHAVIORAL-TEST-PROVEN`),
15 `SOURCE-INSPECTED`. **Zero `DATABASE-PROVEN` or `BROWSER-PROVEN`** — this block
had no network and no database, which is the stated ceiling on its evidence, not
an omission. Nine findings are P1.

One Phase 1 lead was **disproved** in writing (the Buy-3-Get-1 client/server
rounding divergence, K-11) and one was **corrected** (the map's prediction that a
NaN `couponExpirationHours` would fail silently — it throws loudly, K-06; and the
map's claim that `referrals` is read by other surfaces — it is not, K-20).

## CROSS-BLOCK index

Every note, gathered for block M. Ordered by which block must act.

| block | file | what they need to do | from |
|---|---|---|---|
| **A+B** | `src/app/r/[code]/route.ts:49` | **Delete the `referrals` insert.** This single edit resolves three separate findings: their own non-transactional `Promise.all`, K-04's pre-consent PII, and K-20's write-only table. Tell them as one change. | K-04, K-20 |
| **A+B** | `src/lib/payment-webhook.ts:463, 1066, 1543` | Pass `order.created_at` into `redeemStoreCredit`, and add `created_at` to the `.select(...)` at `:463`. | K-12 |
| **A+B** | `src/lib/partner-portal.ts` (2 date sites, `:1717`) | Unpinned-zone date formatting; the `referrals` delete becomes dead. | K-01, K-20 |
| **C** | `src/lib/email/templates.ts:1111-1145` | Thread `discountPercent` through both cart-recovery templates; add an " ET" zone label to the four "expires …" strings. | K-01, K-02, K-05 |
| **C** | `src/lib/email/providers/resend.ts:25`, `sendgrid.ts:29` | Add `signal: AbortSignal.timeout(10_000)`. Two lines. | K-19 |
| **D** | `src/lib/inventory-reservation.ts:185-196` | Stop swallowing the RPC error — `throw` so the sweep alerts. A visibility fix, not an inventory-logic change. | K-13 |
| **D** | `src/lib/sql/inventory-reservations.sql` | Have `reserve_inventory` discount holds past `expires_at`, so the TTL stops depending on the sweep cadence. Also answer whether `restockInventoryForOrder` resets `stock_status`. | K-13, K-17 |
| **E** | four e2e suites | `process.env.ALLOW_MOCK_PAYMENTS = "true"` at module scope is now a no-op; a reader would misjudge those tests' preconditions. | K-16 |
| **F** | `admin-tax-report.ts` and the reporting surfaces | **Do not chase `points_redeemed` vs `discount_amount` mismatches as a reporting defect.** They are upstream in `dollarsToPoints` (K-11). Also, sales-tax rounding is left `NOT VERIFIED` here and is yours. | K-11 |
| **G+H** | browser | Screenshot the three trust strips (`/`, `/checkout`, a PDP) side by side **before** anything changes. Try **Skip twice** on a membership whose renewal is ≤3 days out. Confirm the pre-ticked compliance boxes and the four age-gate statements render as described. | K-21, K-07, K-18 |
| **I** | `middleware.ts:65-82` | Add `/api/cron`, `/api/unsubscribe`, `/api/coa`, `/api/health` (and `/api/veyra`) to `pathBypassesMaintenance`. **One pass over both this list and `CSRF_PROTECTED_PREFIXES:292`** — better than two sessions touching this file. | K-14 |
| **I** | `src/app/api/admin/cart-recovery/settings/route.ts:21-39` | Write-side validation: reject non-finite / negative / non-integer, mirroring `admin-coupons.ts:95-104`. | K-06 |
| **I** | `src/app/api/admin/orders/[orderId]/route.ts:607` | Restock on cancel behind `claimInventoryRestock`. | K-17 |
| **I** | the three IP resolvers | Composes with K-15: a bypassable key on a non-atomic, fail-open counter. **Neither fix is sufficient alone** — land them together. | K-15 |
| **M** | `src/lib/admin-control.ts` | Hoist the four hand-copied `num()` guards into one `controlNumber()`. Touches ten call sites in one shared file — **best done once, last**, not by whoever reaches it first. | K-06 |
| **M** | `src/lib/quote-order.ts` `buildOrderRow` | Persist the card lane's compliance acknowledgement (needs three new `orders` columns → **owner approval under Rule 4**). | K-18 |
| **M** | **Phase 20 — preview verification** | ⚠️ **Do not place a paid test order on a Vercel preview until K-16's environment gate lands.** The pixel IDs default to production and the server legs send real conversions. This is the most time-sensitive line in this file. | K-16 |
| **M** | ledger `F-006` | Update with the two exact render sites for the ungated COA claim (`site-footer.tsx:67`, `age-gate.tsx:483`) rather than leaving it general. | K-21 |

## Open questions for the owner

1. **Store credit: calendar month or billing anniversary?** The sweep implements
   calendar month with no anniversary check, so a member joining on the 30th gets
   a full month's credit for one day. That is a product decision and it changes
   what K-09's fix should be.
2. **Should affiliate-click attribution be unconditional?** K-04's fix depends on
   the answer. If yes, that is legitimate — but the Cookie Policy must then name
   `vl_referral_code` as essential and the Privacy Policy must stop conditioning
   campaign-parameter capture on acceptance. Silence is the only option not
   available.
3. **Are the ad API tokens scoped per Vercel environment?** Decides whether K-16
   is already live in production ad accounts or only latent.
4. **Is "Based in the USA" substantiable?** It appears on the homepage with no
   provenance recorded anywhere, unlike every other claim in `trust-claims.ts`.

## Method note, for whoever reads this next

Findings graded `BEHAVIORAL-TEST-PROVEN` were produced by probes that either
import the real exported function or transcribe the operative lines verbatim with
the source line cited inline; all output is pasted unedited and the sources are in
Appendix A. Findings graded `SOURCE-INSPECTED` quote every line they rest on.

Where a parallel investigation surfaced a lead, it was **re-verified against the
source in this session before being written up** — twice that produced a sharper
result than the lead (K-05's zero-hour margin, K-07's boundary identity with the
reminder window), and the sharper version is what is recorded.

`website/scratchpad/*.test.ts` is gitignored so audit probes never join the
203-file suite. If you add probes, keep them there.

---

# Appendix A — probe sources

The probes below produced the verbatim output quoted in the findings above. They
are **not** committed as test files: `website/scratchpad/*.test.ts` is gitignored
so agent working files never join the 203-file suite that block M runs.

To re-run one, write it to `website/scratchpad/<name>.test.ts` and run
`TZ=UTC npx vitest run scratchpad/<name>.test.ts --disable-console-intercept`
**from `website/`**. Each probe either imports the real exported function or
transcribes the operative lines verbatim, with the source line cited inline.

## `scratchpad/k-skip.test.ts` — K-07 — skipNextBilling cap (transcribes membership-billing.ts:1027, :1046-1053)

```ts
import { describe, it, expect } from "vitest";

// membership-billing.ts:1027 guard + :1046-1053 advance, transcribed verbatim.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function skip(nowMs: number, nextBillingAt: number | null): number {
  if (nextBillingAt !== null && nextBillingAt > nowMs + 33 * ONE_DAY_MS) {
    throw new Error("You've already skipped a charge this cycle — your next billing is already deferred.");
  }
  const base = nextBillingAt !== null ? nextBillingAt : nowMs;      // :1046
  const from = base <= nowMs ? nowMs : base;                        // :1047
  return from + 30 * ONE_DAY_MS;                                    // :1053
}

function howManySkips(nowMs: number, start: number | null): number {
  let n = 0, cur = start;
  for (;;) {
    try { cur = skip(nowMs, cur); n += 1; } catch { return n; }
    if (n > 10) return n;
  }
}

describe("skipNextBilling cap (membership-billing.ts:1023-1027 says ONE skip per paid period)", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  const d = (n: number) => new Date(now + n * ONE_DAY_MS).toISOString();

  it("allows TWO skips when the renewal is inside the 3-day reminder window", () => {
    for (const days of [0, 1, 2, 3]) {
      const n = howManySkips(now, now + days * ONE_DAY_MS);
      console.log(`  next_billing_at = now + ${String(days).padStart(2)}d (${d(days)}) -> ${n} skips accepted`);
      expect(n).toBe(2);
    }
  });

  it("allows only ONE skip once the renewal is 4+ days out — the cap working as designed", () => {
    for (const days of [4, 7, 10, 29]) {
      const n = howManySkips(now, now + days * ONE_DAY_MS);
      console.log(`  next_billing_at = now + ${String(days).padStart(2)}d -> ${n} skip accepted`);
      expect(n).toBe(1);
    }
  });

  it("the exploitable window is exactly the window the reminder email targets", () => {
    // runMembershipBillingSweep:1243  const in3Days = new Date(now.getTime() + 3 * ONE_DAY_MS);
    const reminderWindowEnd = now + 3 * ONE_DAY_MS;
    const largestDoubleSkip = now + 3 * ONE_DAY_MS;   // base + 30d <= now + 33d  =>  base <= now + 3d
    console.log(`  Step 4 emails 'renewal in 3 days' for next_billing_at <= ${new Date(reminderWindowEnd).toISOString()}`);
    console.log(`  double-skip is possible for       next_billing_at <= ${new Date(largestDoubleSkip).toISOString()}`);
    expect(largestDoubleSkip).toBe(reminderWindowEnd);
  });

  it("shows the resulting free period", () => {
    const start = now + 3 * ONE_DAY_MS;
    const a = skip(now, start), b = skip(now, a);
    console.log(`  paid period ended        ${new Date(start).toISOString()}`);
    console.log(`  after skip #1            ${new Date(a).toISOString()}  (+${(a - now) / ONE_DAY_MS}d from now)`);
    console.log(`  after skip #2            ${new Date(b).toISOString()}  (+${(b - now) / ONE_DAY_MS}d from now)`);
    console.log(`  perks retained for       ${(b - start) / ONE_DAY_MS} days beyond the paid period, on one charge`);
    expect((b - start) / ONE_DAY_MS).toBe(60);
  });
});
```

## `scratchpad/k-bday.test.ts` — K-08 — birthday day comparison (transcribes membership.ts:606-608)

```ts
import { describe, it, expect } from "vitest";

// membership.ts:606-608, transcribed verbatim.
function isBirthdayToday(nowIso: string, birthday: string): boolean {
  const today = new Date(nowIso);
  const birthdayDate = new Date(birthday);
  return today.getUTCMonth() === birthdayDate.getUTCMonth()
      && today.getUTCDate() === birthdayDate.getUTCDate();
}
const inZone = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

describe("birthday bonus day comparison (membership.ts:606-608)", () => {
  const birthday = "1990-05-14";
  it("is false for most of the member's actual birthday evening in the US", () => {
    const rows = [
      "2026-05-14T16:00:00Z",  // noon ET  — still their birthday
      "2026-05-15T00:30:00Z",  // 8:30 PM ET — still their birthday
      "2026-05-15T02:00:00Z",  // 10 PM ET / 7 PM PT — still their birthday in both zones
      "2026-05-15T06:30:00Z",  // 11:30 PM PT — still their birthday on the west coast
    ];
    for (const iso of rows) {
      const got = isBirthdayToday(iso, birthday);
      console.log(`  ${iso}  ET ${inZone(iso,"America/New_York").padEnd(24)} PT ${inZone(iso,"America/Los_Angeles").padEnd(24)} -> ${got}`);
    }
    expect(isBirthdayToday("2026-05-14T16:00:00Z", birthday)).toBe(true);
    expect(isBirthdayToday("2026-05-15T00:30:00Z", birthday)).toBe(false);   // 8:30 PM ET on their birthday
    expect(isBirthdayToday("2026-05-15T06:30:00Z", birthday)).toBe(false);   // 11:30 PM PT on their birthday
  });

  it("is TRUE the evening BEFORE, which then burns the once-a-year guard", () => {
    const early = "2026-05-14T02:00:00Z";   // 10 PM ET on May 13
    console.log(`  ${early}  ET ${inZone(early,"America/New_York")} -> ${isBirthdayToday(early, birthday)}`);
    expect(isBirthdayToday(early, birthday)).toBe(true);
    // membership.ts:613 currentYear = today.getUTCFullYear(); :620 returns false if already awarded this year
  });

  it("the eligible window in the member's own zone", () => {
    const startUtc = Date.parse("2026-05-14T00:00:00Z"), endUtc = Date.parse("2026-05-15T00:00:00Z");
    for (const [label, tz] of [["Eastern","America/New_York"],["Pacific","America/Los_Angeles"]] as const) {
      console.log(`  ${label.padEnd(8)} eligible from ${inZone(new Date(startUtc).toISOString(),tz)} to ${inZone(new Date(endUtc-1000).toISOString(),tz)}`);
    }
    expect(true).toBe(true);
  });
});
```

## `scratchpad/k-config.test.ts` — K-06 — admin-control.ts numeric readers (transcribes all ten idioms)

```ts
import { describe, it, expect } from "vitest";

describe("admin-control.ts numeric readers, fed the same blank value", () => {
  it("three different idioms in one file give three different answers", () => {
    const blank = "";   // what clearing an admin form field produces
    const rows: Array<[string, unknown]> = [
      ["getCartRecoveryControlConfig:261-262   Number(x ?? 48)          ", Number(blank ?? 48)],
      ["getCardProcessingFeeConfig:332         Number(x) || 0           ", Number(blank) || 0],
      ["getSubscribeSaveConfig:408             Number(x ?? 10) || 10    ", Number(blank ?? 10) || 10],
      ["getWelcomeOffer:443                    Number(x ?? 10) || 10    ", Number(blank ?? 10) || 10],
      ["getBulkSavings / getProfitSettings /                            ", null],
      ["  getShippingConfig  (local num())     blank -> fallback        ", (blank === "" || blank == null) ? 48 : Number(blank)],
      ["clampPercent:552 (referral/ambassador) blank -> fallback        ", (blank === "" || blank == null) ? 10 : Number(blank)],
    ];
    for (const [k, v] of rows) if (v !== null) console.log(`  ${k} -> ${v}`);
    expect(Number(blank ?? 48)).toBe(0);                       // unguarded: blank becomes zero
    expect((blank === "" ? 48 : Number(blank))).toBe(48);      // guarded: blank keeps the default
  });

  it("the unguarded reader also passes NaN and negatives straight through", () => {
    for (const v of ["", "abc", "-12", "3.5", null, undefined] as const) {
      const n = Number(v as never);
      const unguarded = Number((v as never) ?? 48);
      const guarded = (v === "" || v == null) ? 48 : (Number.isFinite(n) && n >= 0 ? n : 48);
      console.log(`  stored ${String(JSON.stringify(v)).padEnd(11)} unguarded=${String(unguarded).padEnd(6)} guarded=${guarded}`);
    }
    expect(Number("abc")).toBeNaN();
    expect(Number("-12")).toBe(-12);
  });

  it("what each of those values does downstream in mintCartRecoveryCoupon (cart-recovery.ts:128)", () => {
    const HOUR_MS = 3600_000;
    const mint = Date.parse("2026-08-26T10:00:00Z");
    const outcome = (hours: number) => {
      let endsAt: string;
      try {
        endsAt = new Date(mint + hours * HOUR_MS).toISOString();   // cart-recovery.ts:128
      } catch (e) {
        return `THROWS ${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
      // coupons.ts:157  if (ends_at && new Date(ends_at).getTime() < now) -> "This coupon has expired"
      return Date.parse(endsAt) < mint ? `ends_at=${endsAt}  -> REFUSED at checkout`
           : Date.parse(endsAt) === mint ? `ends_at=${endsAt}  -> dead on creation`
           : `ends_at=${endsAt}  -> valid`;
    };
    for (const h of [48, 0, -12, NaN]) console.log(`  couponExpirationHours=${String(h).padEnd(5)} ${outcome(h)}`);

    expect(outcome(0)).toContain("dead on creation");
    expect(outcome(-12)).toContain("REFUSED at checkout");
    expect(outcome(NaN)).toContain("THROWS RangeError");
  });
});
```

## `scratchpad/k-ends.test.ts` — K-10 — endsLabel (imports the REAL src/lib/storefront-offer-format.ts)

```ts
import { describe, it, expect } from "vitest";
import { endsLabel } from "@/lib/storefront-offer-format";

describe("endsLabel truthfulness", () => {
  it("says 'Ends tonight' for a coupon that dies at 9am", () => {
    const now = new Date("2026-08-31T12:00:00Z");        // 8:00 AM ET
    const ends = "2026-08-31T13:00:00.000Z";             // 9:00 AM ET, one hour away
    console.log("  now 8:00 AM ET, coupon dies 9:00 AM ET ->", endsLabel(ends, now));
    expect(endsLabel(ends, now)).toBe("Ends tonight");
  });

  it("says 'Ends tonight' for a coupon a FULL YEAR away", () => {
    const now = new Date("2026-09-03T15:00:00Z");
    const ends = "2027-09-03T20:00:00.000Z";             // same month+day, next year
    console.log("  now Sep 3 2026, coupon dies Sep 3 2027 ->", endsLabel(ends, now));
    expect(endsLabel(ends, now)).toBe("Ends tonight");
  });

  it("prints a year-less date for a far-future coupon", () => {
    const now = new Date("2026-09-03T15:00:00Z");
    console.log("  now Sep 3 2026, coupon dies Dec 1 2028 ->", endsLabel("2028-12-01T20:00:00.000Z", now));
    expect(endsLabel("2028-12-01T20:00:00.000Z", now)).toBe("Ends Dec 1");
  });
});
```

## Plain-node probes

### K-01 — cart-recovery expiry rendering

```js
// A coupon that expires at 6:00 PM Eastern on Aug 27 2026 (EDT = UTC-4)
const expiresAt = "2026-08-27T22:00:00.000Z";
console.log("process.env.TZ =", JSON.stringify(process.env.TZ));
console.log("resolved zone  =", Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log("cart-recovery.ts renders:", new Date(expiresAt).toLocaleString("en-US"));
console.log("truth in America/New_York:", new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",dateStyle:"short",timeStyle:"medium"}).format(new Date(expiresAt)));
console.log("truth in America/Los_Angeles:", new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",dateStyle:"short",timeStyle:"medium"}).format(new Date(expiresAt)));
```

### K-03 — renewal idempotency key

```js
const userId = "u-123", tierId = "t-pro";
// One membership whose paid period ends at 2026-08-27T23:40:00Z.
const nextBillingAt = "2026-08-27T23:40:00.000Z";

// The sweep runs every 30 min. Two consecutive ticks that both see this row due:
const tick1 = new Date("2026-08-27T23:45:00.000Z");   // charges
const tick2 = new Date("2026-08-28T00:15:00.000Z");   // row still due -> charges again

const key = (now) => `renewal-${userId}-${tierId}-${now.toISOString().slice(0, 10)}`;

console.log("membership-billing.ts:1497 renewal key");
console.log("  tick1 23:45Z ->", key(tick1));
console.log("  tick2 00:15Z ->", key(tick2));
console.log("  same key?      ", key(tick1) === key(tick2));
console.log();
console.log("the period-scoped key the fix would use");
const fixed = `renewal-${userId}-${tierId}-${nextBillingAt}`;
console.log("  tick1 ->", fixed);
console.log("  tick2 ->", fixed, "(identical: derived from the row, not the clock)");
console.log();
console.log("for contrast, step 2's remainder key (membership-billing.ts:1334) carries no date:");
console.log("  ->", `remainder-${userId}-${tierId}`, "- stable across any number of ticks");
```

### K-05 — t72h expiry identity

```js
const HOUR = 3600_000;
const couponExpirationHours = 48;      // admin-control.ts:249 DEFAULT
const firstSeen = Date.parse("2026-08-20T09:07:00Z");   // cart abandoned

// vercel.json: "*/30 * * * *" -> ticks on :00 and :30
const tickAtOrAfter = (t) => Math.ceil(t / (30 * 60_000)) * (30 * 60_000);

const t24Tick = tickAtOrAfter(firstSeen + 24 * HOUR);   // cart-recovery.ts:286
const t72Tick = tickAtOrAfter(firstSeen + 72 * HOUR);   // cart-recovery.ts:316

// cart-recovery.ts:128 - ends_at is stamped from Date.now() at mint
const realEndsAt = t24Tick + couponExpirationHours * HOUR;
// cart-recovery.ts:321 - the t72h email fabricates one from the sweep's `now`
const emailClaims = t72Tick + couponExpirationHours * HOUR;

const iso = (t) => new Date(t).toISOString();
console.log("cart first_seen_at        ", iso(firstSeen));
console.log("t24h mail + coupon minted ", iso(t24Tick));
console.log("  real coupons.ends_at    ", iso(realEndsAt));
console.log("t72h 'last chance' mail   ", iso(t72Tick));
console.log("  email says expires      ", iso(emailClaims));
console.log("  email says code is      ", '"SEE PREVIOUS EMAIL"');
console.log();
console.log("real coupon still alive when the last-chance mail is sent?",
            realEndsAt > t72Tick, `(margin: ${(realEndsAt - t72Tick) / HOUR}h)`);
console.log("overstatement in the email:", (emailClaims - realEndsAt) / HOUR, "hours");
console.log();
console.log("why the margin is exactly zero: the t24h->t72h gap is 48h and");
console.log("couponExpirationHours defaults to 48, so mint+48h lands on the");
console.log("same cron tick that sends the final email.");
```

---

### K-11 — points/dollars precision

```js
const POINTS_PER_DOLLAR_REDEMPTION = 100;
const roundPoints = (v) => Math.max(0, Math.floor(v));
const pointsToDollars = (p) => Math.round((p / POINTS_PER_DOLLAR_REDEMPTION) * 100) / 100;
const dollarsToPoints = (d) => roundPoints(d * POINTS_PER_DOLLAR_REDEMPTION);
const roundMoney = (v) => Math.round(v * 100) / 100;

// (1) dollarsToPoints on an ordinary 2dp money value
let lost = [];
for (let c = 1; c <= 100000; c++) {
  const dollars = roundMoney(c / 100);          // a real money amount, e.g. 0.29
  if (dollarsToPoints(dollars) !== c) lost.push([dollars, c, dollarsToPoints(dollars)]);
}
console.log(`(1) dollarsToPoints(x) !== cents(x) for ${lost.length} of the first 100000 cent amounts`);
console.log("    first 12:", lost.slice(0, 12).map(([d, want, got]) => `$${d}: want ${want} got ${got}`).join("  "));

// (2) the round trip quote-order.ts:768-770 actually performs
let rt = [];
for (let p = 1; p <= 100000; p++) {
  const requestedDollars = pointsToDollars(p);
  const amount = roundMoney(Math.min(requestedDollars, 9999));   // total not binding
  if (dollarsToPoints(amount) !== p) rt.push([p, dollarsToPoints(amount)]);
}
console.log(`(2) points -> dollars -> points loses a point for ${rt.length} of the first 100000 balances`);
console.log("    first 12:", rt.slice(0, 12).map(([p, g]) => `${p}->${g}`).join("  "));

// (3) the clamped case: the order total, not the balance, decides
console.log("(3) worked example - customer redeems points on a small order");
for (const total of [0.29, 1.13, 4.58, 8.23, 12.29]) {
  const requestedPoints = 100000;
  const requestedDollars = pointsToDollars(requestedPoints);
  const pointsDiscountAmount = roundMoney(Math.min(requestedDollars, total));
  const pointsRedeemed = dollarsToPoints(pointsDiscountAmount);
  const fair = Math.round(pointsDiscountAmount * 100);
  console.log(`    total $${String(total).padEnd(6)} discount $${String(pointsDiscountAmount).padEnd(6)} debited ${String(pointsRedeemed).padEnd(6)} fair ${String(fair).padEnd(6)} ${pointsRedeemed !== fair ? "<-- MISMATCH, store eats " + ((fair - pointsRedeemed) / 100).toFixed(2) : ""}`);
}
```

### K-22 / discount resolution

```ts
import { describe, it, expect } from "vitest";
import { resolveCartDiscount, resolveBestDiscount } from "@/lib/discount-resolution";

const base = { subtotal: 500, quantityBundleSavings: 0, bulkSavingsAmount: 0,
  memberPricingAmount: 0, ambassadorPersonalAmount: 0, couponDiscountAmount: 0, promo: null };

describe("resolveCartDiscount float behaviour", () => {
  it("sub-cent differences cannot decide the winner: compete() rounds first", () => {
    // Two candidates 0.004 apart - below a cent.
    const r = resolveCartDiscount({ ...base, bulkSavingsAmount: 50.004, memberPricingAmount: 50.0 });
    console.log("  bulk 50.004 vs member 50.000 ->", r.best?.type, r.amount);
    expect(r.amount).toBe(50);           // both round to 50.00
  });

  it("a real cent decides it correctly", () => {
    const r = resolveCartDiscount({ ...base, bulkSavingsAmount: 50.00, memberPricingAmount: 50.01 });
    console.log("  bulk 50.00 vs member 50.01 ->", r.best?.type, r.amount);
    expect(r.best?.type).toBe("member_pricing");
  });

  it("classic float error is absorbed", () => {
    const r = resolveCartDiscount({ ...base, bulkSavingsAmount: 0.1 + 0.2, memberPricingAmount: 0.3 });
    console.log("  0.1+0.2 =", 0.1 + 0.2, "vs 0.3 ->", r.best?.type, r.amount);
    expect(r.amount).toBe(0.3);
  });

  it("ON A TIE the array order decides, and the coupon is last", () => {
    const r = resolveCartDiscount({ ...base, bulkSavingsAmount: 40, couponDiscountAmount: 40 });
    console.log("  bulk 40 vs coupon 40 ->", r.best?.type);
    expect(r.best?.type).toBe("bulk_savings");     // strict >, so first wins
    const r2 = resolveCartDiscount({ ...base, memberPricingAmount: 40, couponDiscountAmount: 40 });
    console.log("  member 40 vs coupon 40 ->", r2.best?.type);
    expect(r2.best?.type).toBe("member_pricing");
    // same MONEY either way - the difference is which label the cart shows
    expect(r.amount).toBe(r2.amount);
  });

  it("clamps to the subtotal and never goes negative", () => {
    console.log("  discount 999 on a 500 subtotal ->", resolveCartDiscount({ ...base, couponDiscountAmount: 999 }).amount);
    expect(resolveCartDiscount({ ...base, couponDiscountAmount: 999 }).amount).toBe(500);
    console.log("  negative candidate ->", resolveBestDiscount([{ type: "coupon", amount: -5 }]));
    expect(resolveBestDiscount([{ type: "coupon", amount: -5 }])).toBeNull();
  });
});
```
