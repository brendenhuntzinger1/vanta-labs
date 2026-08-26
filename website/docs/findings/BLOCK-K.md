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
