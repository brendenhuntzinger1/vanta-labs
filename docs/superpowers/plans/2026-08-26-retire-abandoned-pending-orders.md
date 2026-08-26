# Retire Abandoned Pending Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop abandoned checkouts from sitting in `pending_payment` forever and re-alerting every 30 minutes, by retiring them automatically once the processor has confirmed no money moved.

**Architecture:** `reconcileVeyraPendingPayments()` currently has three outcomes — settle, retire-if-dead, or poll again forever. This adds a fourth: an order the processor **affirmatively reports as not captured**, older than 24h, is retired to `payment_failed`. The load-bearing change is splitting today's single `unresolved` bucket into *"the processor answered, money did not move"* (safe to retire) and *"we could not read the processor"* (never retire — this is the charged-card-reads-unpaid case the file exists to catch). The alert then only fires for the second, which makes it mean something.

**Tech Stack:** TypeScript, Next.js App Router, Supabase (`supabaseAdmin`), Vitest, Vercel Cron.

**Spec:** No separate spec doc — the Background section below is the spec, derived from live production evidence gathered 2026-08-26.

## Background — the evidence this plan is built on

Two orders have been `pending_payment` since Aug 24/25 and have fired
`express_reconcile_backlog` **43 times** (every 30 min since 2026-08-25 21:31).

| Fact | Evidence |
|---|---|
| Neither was ever charged | `paid_at`, `provider_event_id`, `paid_side_effects_at` all NULL; `payment_events` has **zero rows** for both |
| Inventory was already returned | `inventory_reservations.status = 'released'`, updated 2026-08-24 22:03 and 2026-08-25 02:30 |
| They are not Apple Pay orders | `checkout_channel` is NULL, `payment_method` = `card` — the alert's "express" wording is wrong |
| The alert's "they hold inventory" claim is false | see row 2 |
| Orders: | `VL-0716175A` ($17.08, 1× bacteriostatic-water), `VL-9D8CA974` ($18.80, 2× bacteriostatic-water) |

Root cause: `express-reconcile.ts:182-184` increments `unresolved` and loops
forever. Nothing ever retires an abandoned checkout, so the backlog only grows.

Second defect: `fetchSessionStatus` (`express-reconcile.ts:66-75`) returns `null`
on **any** failure, which becomes `status = ""`, which lands in the *same*
`unresolved` bucket as a live-but-unpaid session. An abandoned cart and a
processor outage are currently indistinguishable.

## Global Constraints

- **Never retire an order the processor did not affirmatively report on.** An unreadable session (`fetchSessionStatus` returned `null`, or a status string we do not recognise) must stay `pending_payment` regardless of age.
- **The paid branch is evaluated first, always.** A captured session reports `paid`/`succeeded` and settles; it must never reach the retire branch.
- **Every write is guarded on `payment_status = 'pending_payment'`**, matching the existing dead-session path at `express-reconcile.ts:168-171`, so a webhook that landed a moment earlier is never overwritten.
- **Retirement is reversible.** `payment-webhook.ts:1419-1431` blocks only demotion *from* `paid`, and `payment_failed` is not in `FULLY_TERMINAL_REFUND_STATES` (`payment-webhook.ts:1439`), so a genuine late `payment.succeeded` still promotes a retired order to `paid`. State this in the code comment — it is why 24h is a safe threshold.
- **`payment_failed` is the status to use.** It is already first-class in `payment-types.ts:4`, the admin filter (`admin-orders.ts:30`), the admin label map (`app/admin/orders/page.tsx:32`) and the customer order-status route (`api/checkout/order-status/[orderId]/route.ts:70`). Do not invent a new status value.
- **Do not remove existing `ReconcileResult` fields.** `checked`, `settled`, `failedOut`, `unresolved` are returned in the `/api/cron/sweep` JSON response. Add new fields alongside them.
- Test runner: `cd website && npx vitest run src/lib/express-reconcile.test.ts`
- Full suite before push: `cd website && npm test`

---

### Task 1: Split the unresolved bucket and retire abandoned orders

**Files:**
- Modify: `website/src/lib/express-reconcile.ts:27-35` (constants), `:56-64` (`ReconcileResult`), `:110-199` (the loop and return)
- Test: `website/src/lib/express-reconcile.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ReconcileResult` gains `abandoned: number` (retired this run) and `unreadable: number` (processor could not be read). `unresolved` keeps its existing meaning: still unknown after this sweep. Task 2 reads `unreadable` and a new local `staleUnreadable` count.

- [ ] **Step 1: Write the failing tests**

Add to `website/src/lib/express-reconcile.test.ts`. Put `ANCIENT` next to the
existing `OLD` constant near the top:

```typescript
// Older than RECONCILE_ABANDON_MS (24h), so eligible for retirement.
const ANCIENT = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
```

Then append this describe block:

```typescript
describe("an abandoned checkout is retired instead of polled forever", () => {
  // The processor affirmatively reporting a live-but-uncaptured session is the
  // ONLY evidence that justifies retiring an order without a webhook. These are
  // the statuses that carry it.
  for (const status of ["open", "requires_action", "processing"]) {
    it(`retires a "${status}" session once it is older than 24h`, async () => {
      pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
      providerSays(status);

      const result = await reconcileVeyraPendingPayments();

      expect(result.abandoned).toBe(1);
      expect(result.unresolved).toBe(0);
      expect(releaseInventoryForOrder).toHaveBeenCalledWith("order-1");
      const captured = orderUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(captured.payload).toMatchObject({ payment_status: "payment_failed" });
      // Guarded exactly like the dead-session path: a webhook that marked this
      // paid a moment ago must never be overwritten.
      expect(captured.eq_payment_status).toBe("pending_payment");
      expect(captured.eq_order_id).toBe("order-1");
    });
  }

  it("leaves a young pending session completely alone", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: OLD }];
    providerSays("open");

    const result = await reconcileVeyraPendingPayments();

    expect(result.abandoned).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("NEVER retires a session it could not read, however old", async () => {
    // This is the charged-card-reads-unpaid case. Age is not evidence; only a
    // processor answer is.
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays(null);

    const result = await reconcileVeyraPendingPayments();

    expect(result.abandoned).toBe(0);
    expect(result.unreadable).toBe(1);
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(releaseInventoryForOrder).not.toHaveBeenCalled();
  });

  it("NEVER retires on a status it does not recognise, however old", async () => {
    // If Veyra adds a status that means "captured", retiring on it would void a
    // paid order. Unknown is treated as unreadable, not as abandoned.
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays("some_status_added_in_2027");

    const result = await reconcileVeyraPendingPayments();

    expect(result.abandoned).toBe(0);
    expect(result.unreadable).toBe(1);
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it("settles a paid session even when it is ancient", async () => {
    // The paid branch must win over the retire branch, always.
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays("paid");

    const result = await reconcileVeyraPendingPayments();

    expect(result.settled).toBe(1);
    expect(result.abandoned).toBe(0);
    expect(processPaymentWebhook).toHaveBeenCalledTimes(1);
    expect(orderUpdate).not.toHaveBeenCalled();
  });
});
```

Also update the existing empty-sweep assertion (currently at
`express-reconcile.test.ts:204`) for the two new fields:

```typescript
    expect(result).toEqual({ checked: 0, settled: 0, failedOut: 0, unresolved: 0, abandoned: 0, unreadable: 0 });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run src/lib/express-reconcile.test.ts`

Expected: FAIL. The new tests fail on `expect(result.abandoned).toBe(1)` —
`abandoned` is `undefined`. The empty-sweep test fails on the object shape.

- [ ] **Step 3: Add the constant and the status allowlist**

In `website/src/lib/express-reconcile.ts`, beside the existing constants at
lines 27-35:

```typescript
/**
 * How long an order may sit with the processor reporting it live-but-uncaptured
 * before we stop waiting and retire it.
 *
 * Safe at 24h for two reasons. The paid branch is evaluated FIRST, so a session
 * that actually captured reports "paid" and settles rather than reaching this.
 * And retirement is reversible: payment-webhook.ts blocks demotion *from* paid
 * but nothing blocks promotion *to* it, and payment_failed is not in
 * FULLY_TERMINAL_REFUND_STATES — so a genuine late payment.succeeded still
 * promotes a retired order and runs every paid side-effect exactly once.
 */
const RECONCILE_ABANDON_MS = 24 * 60 * 60 * 1000;

/**
 * Statuses that mean "the processor looked, and no money has moved".
 *
 * ALLOWLIST, deliberately — not "anything that isn't paid or dead". An
 * unrecognised status (one Veyra adds later that means captured) must never
 * retire an order, so it falls through to `unreadable` and alerts instead.
 */
const UNCAPTURED_SESSION_STATUSES = new Set(["open", "processing", "requires_action"]);
```

- [ ] **Step 4: Widen `ReconcileResult`**

Replace the `unresolved` field's block in the `ReconcileResult` interface
(`express-reconcile.ts:56-64`) with:

```typescript
  /** Still genuinely unknown at the processor after this sweep. */
  unresolved: number;
  /** Retired because the processor confirmed no money ever moved. */
  abandoned: number;
  /** The processor could not be read, or answered with a status we don't know. */
  unreadable: number;
```

- [ ] **Step 5: Replace the fall-through branch**

Replace the tail of the loop (`express-reconcile.ts:180-184`, the comment plus
`unresolved += 1;` and the `stale` increment) with:

```typescript
    // Everything below here is NOT paid and NOT definitively dead. Which of the
    // two remaining cases it is decides whether we may touch it at all.
    const answeredUncaptured = UNCAPTURED_SESSION_STATUSES.has(status);
    const ageMs = Date.now() - Date.parse(order.created_at);

    if (!answeredUncaptured) {
      // We did not get an answer we understand. Age proves nothing here: this is
      // exactly the shape of a charged card whose webhook was lost, so it is
      // never retired, only reported.
      unreadable += 1;
      unresolved += 1;
      if (ageMs > RECONCILE_STALE_MS) staleUnreadable += 1;
      continue;
    }

    if (ageMs <= RECONCILE_ABANDON_MS) {
      // Live at the processor and still young enough to complete. Leave it.
      unresolved += 1;
      continue;
    }

    // The processor has been saying "no money moved" for over a day. The cart is
    // long gone and the 15-minute stock hold lapsed within the first hour. Retire
    // it so it stops being polled — guarded, so a webhook that landed between the
    // read above and this write wins.
    const { error: abandonError } = await supabaseAdmin
      .from("orders")
      .update({ payment_status: "payment_failed", updated_at: new Date().toISOString() })
      .eq("order_id", order.order_id)
      .eq("payment_status", "pending_payment");
    if (abandonError) {
      unresolved += 1;
      continue;
    }
    // No-op when the hold already expired, which after 24h it always has. Called
    // anyway so the one path that reaches here early is still correct.
    await releaseInventoryForOrder(order.order_id);
    abandoned += 1;
```

- [ ] **Step 6: Declare the new counters and return them**

At the counter declarations (`express-reconcile.ts:114-118`), replace
`let stale = 0;` with:

```typescript
  let abandoned = 0;
  let unreadable = 0;
  let staleUnreadable = 0;
```

Update the early return for an empty sweep (`express-reconcile.ts:105-107`):

```typescript
  if (orders.length === 0) {
    return { checked: 0, settled: 0, failedOut: 0, unresolved: 0, abandoned: 0, unreadable: 0 };
  }
```

And the final return (`express-reconcile.ts:198`):

```typescript
  return { checked: orders.length, settled, failedOut, unresolved, abandoned, unreadable };
```

Leave the existing `if (stale > 0)` alert block alone for now — Task 2 rewrites
it. To keep this task compiling, change its condition to `if (staleUnreadable > 0)`
and its interpolation to `${staleUnreadable}`. The wording is fixed in Task 2.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd website && npx vitest run src/lib/express-reconcile.test.ts`

Expected: PASS, all tests including the pre-existing ones. Confirm the original
`leaves a "open" session completely alone` tests still pass — they use `OLD`
(1 hour), which is below the 24h threshold, so behaviour is unchanged for them.

- [ ] **Step 8: Commit**

```bash
git add website/src/lib/express-reconcile.ts website/src/lib/express-reconcile.test.ts
git commit -m "Retire checkouts the processor confirms were never paid

An abandoned checkout had no terminal state: the reconcile loop settled a
paid session, retired a dead one, and polled everything else forever. So
every abandoned cart accumulated as a pending_payment row that was polled
every 30 minutes and, past 24h, warned about on every sweep.

Splits the fall-through bucket in two. The processor affirmatively
reporting open/processing/requires_action is evidence no money moved, and
after 24h that order is retired to payment_failed. An unreadable session,
or one carrying a status we do not recognise, is never retired at any age
- that is the shape of a charged card whose webhook was lost, and it is
the case this file exists to catch.

Safe at 24h because the paid branch is evaluated first, and because
retirement is reversible: nothing blocks a late payment.succeeded from
promoting a payment_failed order back to paid."
```

---

### Task 2: Make the alert say something true

**Files:**
- Modify: `website/src/lib/express-reconcile.ts:186-196` (the alert block)
- Test: `website/src/lib/express-reconcile.test.ts`

**Interfaces:**
- Consumes: `staleUnreadable` from Task 1.
- Produces: alert type string `payment_reconcile_unreadable`, replacing `express_reconcile_backlog`.

The current message is wrong in three ways, all confirmed against production:
it says "express" (these are `checkout_channel: null`, `payment_method: card`
orders), it says "they hold inventory" (both reservations read `released`, over
a day before the alert fired), and it fires for abandoned carts, which are
normal business rather than something to act on.

- [ ] **Step 1: Write the failing tests**

Append to `website/src/lib/express-reconcile.test.ts`:

```typescript
describe("the alert fires only for what an operator can act on", () => {
  it("says nothing when old orders were merely abandoned", async () => {
    // A shopper walking away is normal business, not an incident.
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays("open");

    const result = await reconcileVeyraPendingPayments();

    expect(result.abandoned).toBe(1);
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("warns when the processor could not be read for over 24h", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays(null);

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "payment_reconcile_unreadable", severity: "warning" }),
    );
    const [{ message }] = recordSystemAlert.mock.calls[0] as unknown as [{ message: string }];
    // The old copy claimed held inventory and called these express orders. Both
    // were false and both sent an operator chasing the wrong thing.
    expect(message).not.toMatch(/inventory/i);
    expect(message).not.toMatch(/express/i);
  });

  it("does not warn about an unreadable session that is still young", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: OLD }];
    providerSays(null);

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run src/lib/express-reconcile.test.ts`

Expected: FAIL — the alert still uses type `express_reconcile_backlog`, and the
abandoned case still alerts because Task 1 left the old block in place.

- [ ] **Step 3: Rewrite the alert block**

Replace the whole `if (staleUnreadable > 0) { ... }` block
(`express-reconcile.ts:186-196`) with:

```typescript
  if (staleUnreadable > 0) {
    // Only the UNREADABLE case reaches here. An abandoned checkout is retired
    // silently by the loop above, because a shopper changing their mind is
    // normal business and an alert that fires for it is an alert operators
    // learn to ignore — which is precisely what happened to its predecessor,
    // express_reconcile_backlog, at 43 firings in 22 hours.
    //
    // What is left genuinely needs a human: we cannot see these sessions, so a
    // charge we never heard about cannot be ruled out.
    await recordSystemAlert({
      type: "payment_reconcile_unreadable",
      severity: "warning",
      message: `${staleUnreadable} order(s) have been unreadable at the payment processor for over 24h. Nothing here is known to be charged, but until the processor answers, a lost payment cannot be ruled out. Check processor connectivity and API credentials.`,
      context: { staleUnreadable, unreadable, unresolved, abandoned, checked: orders.length },
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd website && npx vitest run src/lib/express-reconcile.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add website/src/lib/express-reconcile.ts website/src/lib/express-reconcile.test.ts
git commit -m "Alert only when the processor cannot be read

The old express_reconcile_backlog warning was wrong three ways at once. It
called plain card checkouts express orders (checkout_channel is null on
both of the orders that triggered it). It said they hold inventory, when
both reservations had read released for over a day. And it fired for
abandoned carts, which need no action at all - 43 times in 22 hours for
two orders nobody could do anything about.

Abandoned checkouts now retire silently. The warning is reserved for
sessions we could not read, where a lost payment genuinely cannot be
ruled out, and its text says that instead."
```

---

### Task 3: Stop the surviving alert from repeating every 30 minutes

**Files:**
- Modify: `website/src/lib/express-reconcile.ts` (add throttle helper, call it from the alert block)
- Test: `website/src/lib/express-reconcile.test.ts`

**Interfaces:**
- Consumes: the alert block from Task 2.
- Produces: `ALERT_THROTTLE_MS` constant; a module-local `shouldAlertNow(): Promise<boolean>`.

A persistently unreadable session would otherwise reproduce the original
problem — a true warning repeating 48 times a day until it is ignored. In-memory
throttling (the `inventory-rpc-failed` approach at `inventory-reservation.ts:175`)
does not survive Vercel's serverless cold starts between cron runs, so this
reads the last alert row instead.

- [ ] **Step 1: Write the failing test**

The existing `supabaseAdmin` mock throws on any table other than `orders`, so it
needs a `system_alerts` branch. Replace the mock's `from` implementation in
`website/src/lib/express-reconcile.test.ts` with:

```typescript
let lastAlertAt: string | null = null;

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "system_alerts") {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.order = () => q;
        q.limit = () => Promise.resolve({
          data: lastAlertAt ? [{ created_at: lastAlertAt }] : [],
          error: null,
        });
        return q;
      }
      if (table !== "orders") throw new Error(`unexpected table ${table}`);
      // ... existing orders branch unchanged ...
    },
  },
}));
```

Add `lastAlertAt = null;` to the existing `beforeEach`, then append:

```typescript
describe("a persistent unreadable backlog does not re-alert every sweep", () => {
  it("stays quiet when the same warning was raised within the throttle window", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays(null);
    lastAlertAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("warns again once the throttle window has passed", async () => {
    pendingRows = [{ order_id: "order-1", payment_id: "cs_live_1", created_at: ANCIENT }];
    providerSays(null);
    lastAlertAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(); // 7h ago

    await reconcileVeyraPendingPayments();

    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd website && npx vitest run src/lib/express-reconcile.test.ts`

Expected: FAIL on the first test — the alert fires regardless of `lastAlertAt`.

- [ ] **Step 3: Add the throttle**

In `website/src/lib/express-reconcile.ts`, beside the other constants:

```typescript
/**
 * How long the unreadable-processor warning stays quiet after firing.
 *
 * Persisted rather than in-memory (the approach inventory-reservation.ts uses
 * for RPC failures): each cron run is a fresh serverless invocation, so a
 * module-level timestamp is always empty and would throttle nothing.
 */
const ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;

async function shouldAlertNow(type: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("system_alerts")
      .select("created_at")
      .eq("type", type)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return true;
    const last = Date.parse(String((data[0] as { created_at: string }).created_at));
    if (!Number.isFinite(last)) return true;
    return Date.now() - last > ALERT_THROTTLE_MS;
  } catch {
    // Never let the throttle silence a real warning. Fail open.
    return true;
  }
}
```

- [ ] **Step 4: Guard the alert with it**

Change the alert condition in `express-reconcile.ts` from:

```typescript
  if (staleUnreadable > 0) {
```

to:

```typescript
  if (staleUnreadable > 0 && (await shouldAlertNow("payment_reconcile_unreadable"))) {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd website && npx vitest run src/lib/express-reconcile.test.ts`

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add website/src/lib/express-reconcile.ts website/src/lib/express-reconcile.test.ts
git commit -m "Throttle the unreadable-processor warning to once every 6h

Without this a genuinely unreadable session reproduces the problem the
previous commit fixed: a true warning repeating 48 times a day until it
is background noise. Throttled against the last persisted alert row
rather than a module-level timestamp, because each cron run is a fresh
serverless invocation and an in-memory clock is always empty. Fails open
- a throttle must never be the reason a real warning is missed."
```

---

### Task 4: Verify against production and confirm the two live orders clear

**Files:**
- None modified. This task is verification only.

**Interfaces:**
- Consumes: the deployed behaviour from Tasks 1-3.
- Produces: a decision on whether the manual escape hatch (Task 5) is needed.

- [ ] **Step 1: Run the full suite**

Run: `cd website && npm test`

Expected: PASS. Investigate any failure before pushing — `express-reconcile.ts`
is money code and the sweep calls it every 30 minutes.

- [ ] **Step 2: Typecheck and lint**

Run: `cd website && npx tsc --noEmit && npm run lint`

Expected: clean.

- [ ] **Step 3: Push**

```bash
git push -u origin claude/clarification-needed-pmh5oa
```

- [ ] **Step 4: After deploy, confirm the two orders resolved**

Wait for one cron cycle (up to 30 minutes), then run against production via the
Supabase MCP (read-only):

```sql
select order_number, payment_status, updated_at
from public.orders
where order_id in ('order-6afd8eee-e5d5-4733-a770-3d11d03350f3',
                   'order-7a8d8cc7-7392-4b30-b541-c44e8b69d3fe');
```

Expected if the processor answers for those sessions: both read
`payment_failed`, with `updated_at` set to the sweep that retired them.

Expected if it does not: both still read `pending_payment`, and a
`payment_reconcile_unreadable` alert has appeared. **That is a real finding**,
not a failure of this plan — it means the sessions genuinely cannot be read, and
Task 5 becomes necessary.

- [ ] **Step 5: Confirm the old alert has stopped**

```sql
select type, count(*), max(created_at)
from public.system_alerts
where created_at > now() - interval '2 hours'
group by type;
```

Expected: no new `express_reconcile_backlog` rows after the deploy timestamp.

- [ ] **Step 6: Commit nothing; report the outcome**

State plainly which of the two Step 4 outcomes occurred. If the orders cleared,
the work is done and Task 5 is not needed.

---

### Task 5: Manual retirement escape hatch — ONLY IF Task 4 Step 4 showed the sessions are unreadable

**Files:**
- Modify: `website/src/app/admin/orders/[orderId]/route.ts` (add an admin-authenticated action)
- Test: alongside the route's existing tests

**Interfaces:**
- Consumes: the `payment_failed` status semantics established in Task 1.
- Produces: an admin-only way to retire a never-paid order without processor access.

Do not build this speculatively. It is needed only if the two orders are stuck
behind an unreadable session, in which case no amount of polling will clear them
and the operator has no Veyra dashboard access.

- [ ] **Step 1: Re-read the route and its existing auth + test patterns**

Run: `sed -n '1,80p' website/src/app/admin/orders/\[orderId\]/route.ts`

Before writing anything, confirm how the route authenticates (it must reuse the
existing admin auth, not a new check) and how its tests mock Supabase.

- [ ] **Step 2: Write the failing test**

The behaviour to pin, in the route's existing test file:

```typescript
it("retires a never-paid order and refuses one that was paid", async () => {
  // A never-paid order: no paid_at, no provider_event_id, no payment_events.
  // Retiring it is safe because no money moved.
  // A paid order must be refused outright - retiring it would strand a
  // charged customer, which is the exact failure express-reconcile guards.
});
```

Fill the body against the route's actual test harness once Step 1 has shown it.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd website && npx vitest run src/app/admin/orders`

- [ ] **Step 4: Implement, guarded on `payment_status = 'pending_payment'`**

The update must mirror `express-reconcile.ts`'s guarded write exactly: filter on
both `order_id` and `payment_status = 'pending_payment'`, then call
`releaseInventoryForOrder`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd website && npx vitest run src/app/admin/orders`

- [ ] **Step 6: Commit**

```bash
git add website/src/app/admin/orders
git commit -m "Let an admin retire a never-paid order without processor access

Needed when a pending order's session cannot be read at the processor:
reconciliation cannot resolve it, and the operator has no processor
dashboard. Guarded on payment_status = pending_payment so a paid order
can never be retired this way."
```

---

## Self-Review

**Spec coverage:**

| Requirement from Background | Task |
|---|---|
| Abandoned checkouts must reach a terminal state | Task 1 |
| Unreadable ≠ abandoned; never retire the former | Task 1 (allowlist + `unreadable` bucket) |
| Alert must stop claiming held inventory | Task 2 |
| Alert must stop saying "express" | Task 2 |
| Alert must not fire for normal abandonment | Task 2 |
| Alert must not repeat every 30 min | Task 3 |
| The two live orders must clear without Veyra access | Task 4 verifies; Task 5 is the fallback |

**Placeholder scan:** Task 5 Steps 2 and 4 intentionally defer their exact code
to a re-read of the route, because that task is conditional and the route was not
read while writing this plan. Every unconditional task (1-4) carries complete code.

**Type consistency:** `abandoned`, `unreadable`, `unresolved`, `staleUnreadable`,
`RECONCILE_ABANDON_MS`, `UNCAPTURED_SESSION_STATUSES`, `ALERT_THROTTLE_MS`,
`shouldAlertNow` are spelled identically in every task that references them.
`RECONCILE_STALE_MS` is the pre-existing constant, reused unchanged in Task 1.
