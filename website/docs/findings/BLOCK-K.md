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
