# Financial Correctness Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make COGS honest, make shipping expense recorded, make failed financial side-effects recoverable, and make the processor fee visible — without touching production data, schema or configuration.

**Architecture:** Two absence-based repair sweeps registered in the existing cron, mirroring `src/lib/commission-accrual-repair.ts`. A COGS fallback that returns `null` instead of substituting a stale parent cost. Critical alerts for the five effects that are not safe to auto-repair. All production mutations are written as SQL files and left unexecuted.

**Tech Stack:** Next.js 16.2.10 (App Router), TypeScript, Supabase (`supabaseAdmin`), Vitest.

**Spec:** `website/docs/superpowers/specs/2026-08-26-financial-correctness-remediation-design.md`

## Global Constraints

- **PHASE 1 ONLY. NO PRODUCTION MUTATION.** No migration may be applied, no production row written, updated or deleted, no configuration changed, no deploy. SQL files are authored and left unexecuted. Violating this is a plan failure, not a judgement call.
- Working directory for every command is `website/`.
- Test runner: `npx vitest run <path>` for one file; `npm test` for the full suite.
- Money is integer cents. Never a float. `Math.round`, never `toFixed`.
- Repair sweeps mirror `src/lib/commission-accrual-repair.ts`: bounded lookback + limit, oldest first, `{scanned, repaired, failed}` result, critical `recordSystemAlert` naming unrecovered orders, `throw` on read error.
- Six effects are auto-repairable; five are alert-only. Do not move an effect between buckets. An effect is repairable only when its primary write **and every downstream ledger entry, email, counter and notification** is idempotent.
- §C3 (financial-ledger unique indexes) is OUT. FIN-03 (sales tax) is OUT and owned by another audit lane.
- Commit after every task. Branch: `claude/vanta-financial-reconciliation-4mg1li`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/quote-order.ts` (modify ~819-826) | COGS resolution; fallback returns `null` |
| `src/lib/admin-profit.ts` (modify) | Shipping-cost audit dedup guard; drop dead enum values |
| `src/lib/shipping-cost-repair.ts` (**create**) | Absence sweep: label bought, no postage recorded |
| `src/lib/refund-effect-repair.ts` (**create**) | Absence sweep: refunded order, missing refund side-effects |
| `src/lib/shippo/service.ts` (modify ~1272) | Stop discarding `recordActualShippingCost` failure |
| `src/lib/payment-webhook.ts` (modify) | Critical alerts for the five alert-only effects |
| `src/app/api/cron/sweep/route.ts` (modify) | Register the two new sweeps |
| `src/components/admin-control-center-client.tsx` (modify) | Processor-fee effective-value hint |
| `src/lib/sql/phase2-financial-remediation.sql` (**create, NOT RUN**) | Every proposed production data change |

---

### Task 1: COGS fallback stops substituting the stale parent cost

**Files:**
- Modify: `src/lib/quote-order.ts:819-826`
- Test: `src/lib/cogs-fallback.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `unitCostCentsForLine(line) => number | null` — returns the dose cost when known, otherwise `null`. Never the parent product cost.

- [ ] **Step 1: Write the failing test**

Create `src/lib/cogs-fallback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveUnitCostCents } from "@/lib/quote-order";

// A dose whose cost is on file resolves to that cost. A dose whose cost is
// MISSING must resolve to null, never to the parent product's figure — the
// parent column holds inherited EvoLabs seed costs 1.4x-6.8x the true landed
// cost, and substituting it silently understated profit on four real orders.
describe("resolveUnitCostCents", () => {
  const byDose = new Map<string, number>([["dose-1", 3.83]]);
  const bySlug = new Map<string, number>([["glp-1", 24.56]]);

  it("uses the dose cost when it is on file", () => {
    expect(resolveUnitCostCents("glp-1", "dose-1", byDose, bySlug)).toBe(383);
  });

  it("returns null when the dose cost is missing, NOT the parent cost", () => {
    expect(resolveUnitCostCents("glp-1", "dose-2", byDose, bySlug)).toBeNull();
  });

  it("returns null for a line with no dose at all", () => {
    expect(resolveUnitCostCents("glp-1", undefined, byDose, bySlug)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/cogs-fallback.test.ts`
Expected: FAIL — `resolveUnitCostCents` is not exported from `@/lib/quote-order`.

- [ ] **Step 3: Extract and change the fallback**

In `src/lib/quote-order.ts`, add this exported pure function above `quoteOrder`:

```ts
/**
 * Per-line COGS in cents, or null when no cost is on record.
 *
 * DELIBERATELY NEVER FALLS BACK TO THE PARENT PRODUCT COST.
 * `products.product_cost_cents` holds costs inherited from EvoLabs, the former
 * third-party fulfilment provider, superseded by the per-vial landed costs in
 * sql/product-cogs.sql. On 36 of 38 published products the parent figure is
 * 1.4x-6.8x the true dose cost. Substituting it does not make COGS more
 * accurate; it makes a wrong number look like a known one.
 *
 * Returning null instead makes computeOrderProfit set `hasEstimatedCost`, so
 * the order reports COGS as ESTIMATED. A visible estimate beats a confident
 * wrong number.
 */
export function resolveUnitCostCents(
  slug: string,
  variantId: string | undefined,
  unitCostByDoseId: Map<string, number>,
  unitCostBySlug: Map<string, number>,
  slugsWithDoses: Set<string>,
): number | null {
  const doseCost = variantId ? unitCostByDoseId.get(variantId) : undefined;
  if (doseCost && doseCost > 0) return Math.round(doseCost * 100);
  // HAS doses but no cost on the chosen one: refuse to substitute. The parent
  // figure here is an inherited EvoLabs seed cost, 1.4x-6.8x the true landed
  // cost, and a confident wrong number is worse than a visible estimate.
  if (slugsWithDoses.has(slug)) return null;
  // NO doses at all: the parent cost is the ONLY cost this product has, and
  // product-cogs.sql sets it for exactly this case. Using it is correct.
  const slugCost = unitCostBySlug.get(slug);
  return slugCost && slugCost > 0 ? Math.round(slugCost * 100) : null;
}
```

Then replace the body of the existing `unitCostCentsForLine` closure with a delegation:

```ts
  const unitCostCentsForLine = (line: QuoteOrderLine): number | null =>
    resolveUnitCostCents(
      String(line.product.id).split("::")[0],
      line.product.variantId,
      unitCostByDoseId,
      unitCostBySlug,
    );
```

Leave `guardProductCost` untouched — it must keep falling back to `profitSettings.worstCaseUnitCost` so an unpriced SKU still cannot be sold below break-even.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/cogs-fallback.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Negative control — prove the guard still uses worst-case**

Run: `npx vitest run src/lib/quote-order-profit-guard.test.ts src/lib/e2e/publish-price-guard.test.ts`
Expected: PASS. If either fails, `guardProductCost` was changed by mistake — revert that part.

- [ ] **Step 6: Related regression suite**

Run: `npx vitest run src/lib/order-profit.test.ts src/lib/profit-engine.test.ts src/lib/admin-profit-at-scale.test.ts src/lib/historical-profit-immutability.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/quote-order.ts src/lib/cogs-fallback.test.ts
git commit -m "Stop substituting the inherited EvoLabs parent cost for a missing dose cost"
```

---

### Task 2: Shipping-cost audit rows stop duplicating under repair

**Files:**
- Modify: `src/lib/admin-profit.ts` (`recordActualShippingCost`, ~line 670-727)
- Test: `src/lib/shipping-cost-audit-dedup.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `recordActualShippingCost(input) => Promise<{ok: boolean; error?: string}>` — unchanged signature; now writes at most one `order_shipping_cost_audit` row per `(order_id, exact_cost_cents)`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/shipping-cost-audit-dedup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldWriteShippingAudit } from "@/lib/admin-profit";

// The repair sweep may re-record the same settled postage for an order (a
// re-run, an overlapping sweep). The orders UPDATE is idempotent — same values,
// same result — but the audit INSERT was unconditional, so every repeat wrote
// another audit row and the trail stopped being a record of what changed.
describe("shouldWriteShippingAudit", () => {
  it("writes when no audit row exists for this order", () => {
    expect(shouldWriteShippingAudit([], 742)).toBe(true);
  });

  it("writes when the recorded cost differs from every existing row", () => {
    expect(shouldWriteShippingAudit([{ exactCostCents: 500 }], 742)).toBe(true);
  });

  it("does NOT write when the same cost is already recorded", () => {
    expect(shouldWriteShippingAudit([{ exactCostCents: 742 }], 742)).toBe(false);
  });

  it("does NOT write when the same cost appears among several rows", () => {
    expect(
      shouldWriteShippingAudit([{ exactCostCents: 500 }, { exactCostCents: 742 }], 742),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/shipping-cost-audit-dedup.test.ts`
Expected: FAIL — `shouldWriteShippingAudit` is not exported.

- [ ] **Step 3: Add the guard**

In `src/lib/admin-profit.ts`, add above `recordActualShippingCost`:

```ts
/**
 * Whether a new order_shipping_cost_audit row should be written.
 *
 * Re-recording the SAME settled cost for an order is a no-op, not an event.
 * The repair sweep can legitimately re-run against an order whose cost is
 * already recorded; without this the audit trail fills with identical rows and
 * stops being usable as a record of what actually changed.
 */
export function shouldWriteShippingAudit(
  existing: Array<{ exactCostCents: number | null }>,
  amountCents: number,
): boolean {
  return !existing.some((row) => row.exactCostCents === amountCents);
}
```

Inside `recordActualShippingCost`, immediately before the `order_shipping_cost_audit` insert, read the existing rows and gate the insert:

```ts
  const priorAudit = await getShippingCostAudit(input.orderId);
  if (shouldWriteShippingAudit(priorAudit, amountCents)) {
    await supabaseAdmin
      .from("order_shipping_cost_audit")
      .insert({
        // ... existing payload unchanged ...
      })
      .then(() => undefined, () => undefined);
  }
```

Keep the existing `.then(noop, noop)` — the audit stays best-effort and must never fail the reconciliation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/shipping-cost-audit-dedup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Related regression suite**

Run: `npx vitest run src/lib/shippo/label-cost-writeback.test.ts src/lib/order-profit-shipping-reconciliation.test.ts src/lib/admin-financial-surfaces.test.ts`
Expected: PASS. (Skip any file in that list that does not exist.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin-profit.ts src/lib/shipping-cost-audit-dedup.test.ts
git commit -m "Write one shipping-cost audit row per distinct settled cost"
```

---

### Task 3: Shipping-cost repair sweep

**Files:**
- Create: `src/lib/shipping-cost-repair.ts`
- Create: `src/lib/shipping-cost-repair.test.ts`
- Modify: `src/lib/shippo/service.ts` (~1272)

**Interfaces:**
- Consumes: `shouldWriteShippingAudit` (Task 2), `recordActualShippingCost` from `@/lib/admin-profit`, `getTransaction` and `settledCentsFromTransaction` from `@/lib/shippo/client`.
- Produces: `repairMissingShippingCosts(options?: {lookbackDays?: number; limit?: number; now?: Date}) => Promise<{scanned: number; repaired: number; failed: number}>`
- Produces: `findOrdersMissingShippingCost(rows) => rows[]` — the pure absence predicate, exported for test.

- [ ] **Step 1: Write the failing test**

Create `src/lib/shipping-cost-repair.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findOrdersMissingShippingCost } from "@/lib/shipping-cost-repair";

// ABSENCE, not a queue. An order that bought a Shippo label and has no
// actual_shipping_cost_cents never had its postage recorded — and everything
// needed to record it (the transaction id) is still on the order. Looking for
// absence makes the sweep idempotent by construction and lets it clear the
// existing backlog, not just failures after deploy.
describe("findOrdersMissingShippingCost", () => {
  const base = {
    order_id: "order-1",
    label_purchased_at: "2026-08-25T02:21:10Z",
    shippo_transaction_id: "3a7fa84885e7401487990c2b43ddc105",
    actual_shipping_cost_cents: null as number | null,
  };

  it("selects a label-bought order with no recorded cost", () => {
    expect(findOrdersMissingShippingCost([base])).toHaveLength(1);
  });

  it("skips an order whose cost is already recorded", () => {
    expect(
      findOrdersMissingShippingCost([{ ...base, actual_shipping_cost_cents: 742 }]),
    ).toHaveLength(0);
  });

  it("skips an order with a recorded cost of zero — zero is a real answer", () => {
    expect(
      findOrdersMissingShippingCost([{ ...base, actual_shipping_cost_cents: 0 }]),
    ).toHaveLength(0);
  });

  it("skips an order with no Shippo transaction — nothing to look the cost up with", () => {
    expect(
      findOrdersMissingShippingCost([{ ...base, shippo_transaction_id: null }]),
    ).toHaveLength(0);
  });

  it("skips an order that never bought a label", () => {
    expect(
      findOrdersMissingShippingCost([{ ...base, label_purchased_at: null }]),
    ).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/shipping-cost-repair.test.ts`
Expected: FAIL — cannot resolve `@/lib/shipping-cost-repair`.

- [ ] **Step 3: Write the sweep**

Create `src/lib/shipping-cost-repair.ts`:

```ts
import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getTransaction, settledCentsFromTransaction } from "@/lib/shippo/client";
import { recordActualShippingCost } from "@/lib/admin-profit";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * RECORD THE POSTAGE THE STORE ACTUALLY PAID.
 *
 * purchaseLabel writes postage_cost_cents and calls recordActualShippingCost,
 * but that landed after labels had already been bought, and its failure return
 * was discarded. The result on production: two real Shippo labels, zero
 * recorded postage, and a profit report charging a flat $6.00 model instead.
 *
 * IDEMPOTENT BY CONSTRUCTION. The sweep looks for ABSENCE — a label with no
 * recorded cost — so a second run finds nothing to do. getTransaction is a GET
 * on /transactions/<id>; it reads an existing label and cannot buy one.
 *
 * THIS ALSO REPAIRS THE PAST: it clears the existing backlog, not only orders
 * shipped from here on.
 */

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_LIMIT = 50;

export interface ShippingCostRepairResult {
  scanned: number;
  repaired: number;
  failed: number;
}

export interface ShippingCostCandidate {
  order_id: string;
  label_purchased_at: string | null;
  shippo_transaction_id: string | null;
  actual_shipping_cost_cents: number | null;
}

/**
 * Orders that bought a label and have no cost recorded.
 *
 * A recorded cost of 0 is NOT absence — zero postage is a real answer (a voided
 * label, a free carrier account) and re-deriving it every sweep would be a
 * pointless call to Shippo forever.
 */
export function findOrdersMissingShippingCost<T extends ShippingCostCandidate>(rows: T[]): T[] {
  return rows.filter(
    (row) =>
      Boolean(row.label_purchased_at)
      && Boolean(row.shippo_transaction_id)
      && row.actual_shipping_cost_cents == null,
  );
}

export async function repairMissingShippingCosts(options?: {
  lookbackDays?: number;
  limit?: number;
  now?: Date;
}): Promise<ShippingCostRepairResult> {
  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const result: ShippingCostRepairResult = { scanned: 0, repaired: 0, failed: 0 };

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, label_purchased_at, shippo_transaction_id, actual_shipping_cost_cents")
    .not("label_purchased_at", "is", null)
    .gte("label_purchased_at", since)
    .order("label_purchased_at", { ascending: true })
    .limit(limit);

  // A sweep that cannot read is not a sweep that found nothing.
  if (error) throw error;

  const candidates = findOrdersMissingShippingCost((data ?? []) as ShippingCostCandidate[]);
  result.scanned = (data ?? []).length;
  if (candidates.length === 0) return result;

  const failures: Array<{ orderId: string; error: string }> = [];

  for (const order of candidates) {
    try {
      const transaction = await getTransaction(String(order.shippo_transaction_id));
      if (!transaction.ok) {
        throw new Error(transaction.message ?? "Shippo transaction lookup failed");
      }
      // getTransaction returns the RAW Shippo transaction, whose postage lives
      // on `rate`. It is NOT the parsed label object purchaseLabel builds, so
      // there is no `postageCostCents` on it — settledCentsFromTransaction is
      // the one place that parses it, and returns null when `rate` came back as
      // a bare id reference rather than an expanded object.
      const amountCents = settledCentsFromTransaction(transaction.data.rate);
      if (amountCents == null) {
        throw new Error("Shippo returned no usable postage amount on the transaction rate");
      }
      const recorded = await recordActualShippingCost({
        orderId: order.order_id,
        amountCents,
        source: "shippo",
      });
      if (!recorded.ok) throw new Error(recorded.error ?? "recordActualShippingCost failed");
      result.repaired += 1;
    } catch (repairError) {
      result.failed += 1;
      failures.push({
        orderId: order.order_id,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      });
    }
  }

  if (failures.length > 0) {
    await recordSystemAlert({
      type: "shipping_cost_unrecorded",
      severity: "critical",
      message:
        `${failures.length} order(s) bought a shipping label but still have no recorded postage. `
        + "Profit for these orders is charging the flat shipping estimate instead of the real label cost.",
      context: { failures: failures.slice(0, 25), totalFailed: failures.length },
    }).catch((alertError) => {
      console.error("Unable to record a shipping-cost repair alert", alertError);
    });
  }

  return result;
}
```

- [ ] **Step 4: Export the postage parser the sweep depends on**

`settledCentsFromTransaction` is module-private in `src/lib/shippo/client.ts:462`. Change its declaration
from `function` to `export function`. Do not reimplement it in the sweep — parsing a Shippo amount in two
places is how the two drift.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/shipping-cost-repair.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Stop discarding the write failure at the label-purchase site**

In `src/lib/shippo/service.ts` (~1272), replace:

```ts
  await recordActualShippingCost({
    orderId: order.order_id,
    amountCents: label.postageCostCents,
    source: "shippo",
  });
```

with:

```ts
  // The return value used to be discarded, so a failed cost write left the
  // order silently on the flat estimate. Log it here; the repair sweep
  // (shipping-cost-repair.ts) is what actually recovers it, because it looks
  // for the absence this failure creates.
  const costRecorded = await recordActualShippingCost({
    orderId: order.order_id,
    amountCents: label.postageCostCents,
    source: "shippo",
  });
  if (!costRecorded.ok) {
    console.error(
      "Unable to record actual shipping cost for order",
      order.order_id,
      costRecorded.error,
    );
  }
```

- [ ] **Step 7: Verify the label-purchase path still passes**

Run: `npx vitest run src/lib/shippo/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/shipping-cost-repair.ts src/lib/shipping-cost-repair.test.ts src/lib/shippo/service.ts src/lib/shippo/client.ts
git commit -m "Add an absence sweep that records postage for labels missing a cost"
```

---

### Task 4: Refund-effect repair sweep

**Files:**
- Create: `src/lib/refund-effect-repair.ts`
- Create: `src/lib/refund-effect-repair.test.ts`

**Interfaces:**
- Consumes: `reverseOrderPoints`, `restoreRedeemedPoints` from `@/lib/membership`; `refundStoreCreditForOrder` from `@/lib/store-credit`.
- Produces: `repairIncompleteRefunds(options?: {lookbackDays?: number; limit?: number; now?: Date}) => Promise<{scanned: number; repaired: number; failed: number}>`
- Produces: `planRefundRepairs(order, ledgerReasons, creditReasons) => string[]` — the pure absence predicate, exported for test. Returns the effect keys still missing for one order.

- [ ] **Step 1: Write the failing test**

Create `src/lib/refund-effect-repair.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planRefundRepairs } from "@/lib/refund-effect-repair";

// Four refund side-effects share ONE scan over refunded orders. Each is
// selected by its own absence, so an order missing only one of them gets only
// that one repaired. All four are individually idempotent (each has an
// existing-row guard), which is why they are safe to re-run at all.
describe("planRefundRepairs", () => {
  const refunded = {
    order_id: "order-1",
    payment_status: "refunded",
    refund_amount: 0,
    points_earned: 120,
    points_redeemed: 50,
    store_credit_redeemed_cents: 500,
  };

  it("plans every effect when none has run", () => {
    expect(planRefundRepairs(refunded, new Set(), new Set()).sort()).toEqual(
      ["points_restore", "points_reversal", "refund_amount", "store_credit_refund"],
    );
  });

  it("skips refund_amount once it is recorded", () => {
    const plan = planRefundRepairs({ ...refunded, refund_amount: 42.5 }, new Set(), new Set());
    expect(plan).not.toContain("refund_amount");
  });

  it("skips points reversal once its ledger row exists", () => {
    const plan = planRefundRepairs(refunded, new Set(["order_refund_reversal"]), new Set());
    expect(plan).not.toContain("points_reversal");
  });

  it("skips points restore once its ledger row exists", () => {
    const plan = planRefundRepairs(refunded, new Set(["order_refund_points_restore"]), new Set());
    expect(plan).not.toContain("points_restore");
  });

  it("skips store credit refund once its ledger row exists", () => {
    const plan = planRefundRepairs(refunded, new Set(), new Set(["membership_redemption_refund"]));
    expect(plan).not.toContain("store_credit_refund");
  });

  it("plans nothing for an order that earned, redeemed and owed nothing", () => {
    expect(
      planRefundRepairs(
        { ...refunded, refund_amount: 10, points_earned: 0, points_redeemed: 0, store_credit_redeemed_cents: 0 },
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
  });

  it("plans nothing for an order that is not refunded", () => {
    expect(
      planRefundRepairs({ ...refunded, payment_status: "paid" }, new Set(), new Set()),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/refund-effect-repair.test.ts`
Expected: FAIL — cannot resolve `@/lib/refund-effect-repair`.

- [ ] **Step 3: Write the sweep**

Create `src/lib/refund-effect-repair.ts`:

```ts
import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { reverseOrderPoints, restoreRedeemedPoints } from "@/lib/membership";
import { refundStoreCreditForOrder } from "@/lib/store-credit";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * COMPLETE THE SIDE-EFFECTS OF A REFUND THAT DID NOT FINISH.
 *
 * processPaymentWebhook runs four refund side-effects, each in its own
 * try/catch that logs to a serverless console and continues. The refund claim
 * is already spent by then, so a failure was permanent: revenue never reduced,
 * points never clawed back, store credit never returned.
 *
 * IDEMPOTENT BY CONSTRUCTION, TWICE OVER. The sweep selects on ABSENCE, and
 * each underlying function ALSO carries its own existing-row guard
 * (reverseOrderPoints and restoreRedeemedPoints on (order_id, reason);
 * refundStoreCreditForOrder on an already-refunded check). Two overlapping
 * sweeps therefore converge rather than double-crediting — which is exactly
 * why these four qualify for automatic repair and the other five do not.
 *
 * ONE SCAN, FOUR EFFECTS. All four are triggered by the same condition (this
 * order was refunded), so they share a single pass over refunded orders.
 */

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_LIMIT = 50;

export type RefundRepairEffect =
  | "refund_amount"
  | "points_reversal"
  | "points_restore"
  | "store_credit_refund";

export interface RefundRepairResult {
  scanned: number;
  repaired: number;
  failed: number;
}

export interface RefundCandidate {
  order_id: string;
  payment_status: string | null;
  refund_amount: number | null;
  points_earned: number | null;
  points_redeemed: number | null;
  store_credit_redeemed_cents: number | null;
}

/**
 * Which refund effects are still missing for one order.
 *
 * An effect is only planned when the order actually incurred it: an order that
 * earned no points needs no reversal, and planning one would call a function
 * that correctly does nothing, every sweep, forever.
 */
export function planRefundRepairs(
  order: RefundCandidate,
  pointsLedgerReasons: Set<string>,
  storeCreditReasons: Set<string>,
): RefundRepairEffect[] {
  if (String(order.payment_status ?? "").toLowerCase() !== "refunded") return [];

  const planned: RefundRepairEffect[] = [];
  if (Number(order.refund_amount ?? 0) <= 0) planned.push("refund_amount");
  if (Number(order.points_earned ?? 0) > 0 && !pointsLedgerReasons.has("order_refund_reversal")) {
    planned.push("points_reversal");
  }
  if (Number(order.points_redeemed ?? 0) > 0 && !pointsLedgerReasons.has("order_refund_points_restore")) {
    planned.push("points_restore");
  }
  if (
    Number(order.store_credit_redeemed_cents ?? 0) > 0
    && !storeCreditReasons.has("membership_redemption_refund")
  ) {
    planned.push("store_credit_refund");
  }
  return planned;
}

export async function repairIncompleteRefunds(options?: {
  lookbackDays?: number;
  limit?: number;
  now?: Date;
}): Promise<RefundRepairResult> {
  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const result: RefundRepairResult = { scanned: 0, repaired: 0, failed: 0 };

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "order_id, payment_status, refund_amount, points_earned, points_redeemed, store_credit_redeemed_cents, amount_paid",
    )
    .eq("payment_status", "refunded")
    .gte("refunded_at", since)
    .order("refunded_at", { ascending: true })
    .limit(limit);

  if (error) throw error;

  const candidates = (data ?? []) as Array<RefundCandidate & { amount_paid: number | null }>;
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  const orderIds = candidates.map((order) => order.order_id);

  const [{ data: pointsRows, error: pointsError }, { data: creditRows, error: creditError }] =
    await Promise.all([
      supabaseAdmin.from("points_ledger").select("order_id, reason").in("order_id", orderIds),
      supabaseAdmin.from("store_credit_ledger").select("order_id, reason").in("order_id", orderIds),
    ]);
  if (pointsError) throw pointsError;
  if (creditError) throw creditError;

  const reasonsByOrder = (rows: Array<{ order_id: unknown; reason: unknown }> | null) => {
    const map = new Map<string, Set<string>>();
    for (const row of rows ?? []) {
      const key = String(row.order_id);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(String(row.reason));
    }
    return map;
  };
  const pointsByOrder = reasonsByOrder(pointsRows as Array<{ order_id: unknown; reason: unknown }>);
  const creditByOrder = reasonsByOrder(creditRows as Array<{ order_id: unknown; reason: unknown }>);

  const failures: Array<{ orderId: string; effect: string; error: string }> = [];

  for (const order of candidates) {
    const planned = planRefundRepairs(
      order,
      pointsByOrder.get(order.order_id) ?? new Set(),
      creditByOrder.get(order.order_id) ?? new Set(),
    );

    for (const effect of planned) {
      try {
        if (effect === "refund_amount") {
          // A refunded order with refund_amount 0 never had the reversal
          // recorded, so revenue was never reduced. The refunded amount is what
          // the customer paid — a processor-initiated full refund is the only
          // way this status is reached without an amount already written.
          const { error: updateError } = await supabaseAdmin
            .from("orders")
            .update({
              refund_amount: Number(order.amount_paid ?? 0),
              refunded_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("order_id", order.order_id)
            .eq("refund_amount", 0);
          if (updateError) throw updateError;
        } else if (effect === "points_reversal") {
          await reverseOrderPoints(order.order_id);
        } else if (effect === "points_restore") {
          await restoreRedeemedPoints(order.order_id);
        } else {
          await refundStoreCreditForOrder(order.order_id);
        }
        result.repaired += 1;
      } catch (repairError) {
        result.failed += 1;
        failures.push({
          orderId: order.order_id,
          effect,
          error: repairError instanceof Error ? repairError.message : String(repairError),
        });
      }
    }
  }

  if (failures.length > 0) {
    await recordSystemAlert({
      type: "refund_effects_unrecovered",
      severity: "critical",
      message:
        `${failures.length} refund side-effect(s) could not be completed. `
        + "Revenue, loyalty points or store credit may not reflect these refunds.",
      context: { failures: failures.slice(0, 25), totalFailed: failures.length },
    }).catch((alertError) => {
      console.error("Unable to record a refund-effect repair alert", alertError);
    });
  }

  return result;
}
```

Note the `.eq("refund_amount", 0)` on the update — a conditional write, so two overlapping sweeps cannot both apply it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/refund-effect-repair.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Related regression suite**

Run: `npx vitest run src/lib/refund-truthfulness.test.ts src/lib/order-profit-refund-tax.test.ts src/lib/points-math.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/refund-effect-repair.ts src/lib/refund-effect-repair.test.ts
git commit -m "Add an absence sweep that completes unfinished refund side-effects"
```

---

### Task 5: Register both sweeps in the cron

**Files:**
- Modify: `src/app/api/cron/sweep/route.ts`
- Test: `src/app/api/cron/sweep/route.test.ts`

**Interfaces:**
- Consumes: `repairMissingShippingCosts` (Task 3), `repairIncompleteRefunds` (Task 4).
- Produces: two new keys on the sweep's JSON response — `shippingCostRepair`, `refundEffectRepair`.

- [ ] **Step 1: Write the failing test**

Append to `src/app/api/cron/sweep/route.test.ts`:

```ts
it("registers the financial repair sweeps", async () => {
  const module = await import("@/app/api/cron/sweep/route");
  // The JOBS registry is keyed, not positional; asserting on the key is
  // asserting on the response contract an operator reads.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync("src/app/api/cron/sweep/route.ts", "utf8"),
  );
  expect(source).toContain("shippingCostRepair");
  expect(source).toContain("refundEffectRepair");
  expect(module.GET).toBeTypeOf("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/cron/sweep/route.test.ts`
Expected: FAIL — source does not contain `shippingCostRepair`.

- [ ] **Step 3: Register the jobs**

In `src/app/api/cron/sweep/route.ts`, add the imports:

```ts
import { repairMissingShippingCosts } from "@/lib/shipping-cost-repair";
import { repairIncompleteRefunds } from "@/lib/refund-effect-repair";
```

and add two entries to the `JOBS` object, after `commissionAccrualRepair`:

```ts
  // Record the postage actually paid for any label whose cost never landed.
  // Same absence-based shape as commissionAccrualRepair: idempotent, and it
  // clears the existing backlog rather than only protecting future orders.
  shippingCostRepair: { label: "shipping_cost_repair", run: repairMissingShippingCosts },
  // Finish the refund side-effects that the webhook's swallow-and-continue
  // error handling left half-applied: revenue reversal, points, store credit.
  refundEffectRepair: { label: "refund_effect_repair", run: repairIncompleteRefunds },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/cron/sweep/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/sweep/route.ts src/app/api/cron/sweep/route.test.ts
git commit -m "Register the shipping-cost and refund-effect repair sweeps"
```

---

### Task 6: Alert on the five effects that cannot be auto-repaired

**Files:**
- Modify: `src/lib/payment-webhook.ts` (catch blocks at ~1132, ~1168, ~1223, ~1648, ~1697, ~1770, ~1795)
- Test: `src/lib/unsafe-effect-alerting.test.ts` (create)

**Interfaces:**
- Consumes: `recordSystemAlert` from `@/lib/monitoring`.
- Produces: `unsafeEffectAlert(effect: string, orderId: string, error: unknown) => {type: string; severity: "critical"; message: string; context: Record<string, unknown>}` — exported from `src/lib/payment-webhook.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/unsafe-effect-alerting.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unsafeEffectAlert } from "@/lib/payment-webhook";

// THESE FIVE ARE NOT AUTO-REPAIRED, AND THAT IS DELIBERATE.
//
//   inventory decrement        legacy fallback has no order-scoped claim
//   points earn                bare INSERT, no (order_id, reason) guard
//   store credit redemption    bare insert, no guard
//   coupon redemption          unconditional increment, no order linkage
//   membership activation      duplicates a 'renewal' billing event
//
// Retrying any of them would double-write. So the failure is escalated to a
// durable, operator-visible alert instead of a console line nobody reads.
describe("unsafeEffectAlert", () => {
  it("is always critical — this is money that silently did not happen", () => {
    const alert = unsafeEffectAlert("points_earn", "order-1", new Error("boom"));
    expect(alert.severity).toBe("critical");
  });

  it("names the order so the backlog is recoverable by hand", () => {
    const alert = unsafeEffectAlert("coupon_redemption", "order-42", new Error("boom"));
    expect(alert.context.orderId).toBe("order-42");
    expect(alert.message).toContain("order-42");
  });

  it("carries the effect in the alert type so alerts group per effect", () => {
    expect(unsafeEffectAlert("inventory_decrement", "order-1", new Error("x")).type)
      .toBe("unsafe_effect_failed_inventory_decrement");
  });

  it("stringifies a non-Error rejection rather than dropping it", () => {
    expect(unsafeEffectAlert("points_earn", "order-1", "plain string").context.error)
      .toBe("plain string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/unsafe-effect-alerting.test.ts`
Expected: FAIL — `unsafeEffectAlert` is not exported.

- [ ] **Step 3: Add the helper and wire the five catch blocks**

In `src/lib/payment-webhook.ts`, add near the top-level helpers:

```ts
/**
 * A durable alert for a financial effect that FAILED and CANNOT be auto-repaired.
 *
 * The repair sweeps cover the six effects whose every downstream write is
 * idempotent. These five are not: retrying them would double-write a ledger
 * row, a counter, or a billing event. Until they carry uniqueness guarantees
 * they get a human, not a retry.
 */
export function unsafeEffectAlert(effect: string, orderId: string, error: unknown) {
  return {
    type: `unsafe_effect_failed_${effect}`,
    severity: "critical" as const,
    message:
      `A financial side-effect (${effect}) failed for order ${orderId} and cannot be retried automatically `
      + "because it is not idempotent. It must be applied by hand after checking whether it partially ran.",
    context: {
      orderId,
      effect,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}
```

Then, in each of these catch blocks, keep the existing `console.error` and add the alert immediately after it:

| line (approx) | existing log | `effect` argument |
|---|---|---|
| 1132 / 1648 | "Unable to redeem coupon…" | `"coupon_redemption"` |
| 1168 / 1697 | "Unable to process membership points…" | `"points_earn"` |
| 1223 / 1770 | "Unable to activate membership…" | `"membership_activation"` |
| 1795 | "Unable to decrement inventory…" | `"inventory_decrement"` |

The pattern for each:

```ts
        } catch (couponError) {
          console.error("Unable to redeem coupon for order", orderId, couponError);
          await recordSystemAlert(unsafeEffectAlert("coupon_redemption", orderId, couponError))
            .catch(() => {});
        }
```

Store-credit redemption (`redeemStoreCredit`, inside the points block at ~1678) is covered by the
`"points_earn"` alert on that same block — it shares the try.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/unsafe-effect-alerting.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Negative control — the alert must never break order processing**

Run: `npx vitest run src/lib/payment-webhook.test.ts src/lib/payment-webhook-dedupe.test.ts src/lib/order-pipeline.test.ts`
Expected: PASS. Every alert call is `.catch(() => {})`; a failing alert must not fail a paid order.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payment-webhook.ts src/lib/unsafe-effect-alerting.test.ts
git commit -m "Escalate the five non-idempotent effect failures to critical alerts"
```

---

### Task 7: Make the effective processor fee visible

**Files:**
- Modify: `src/components/admin-control-center-client.tsx`
- Test: `src/lib/profit-settings-defaults.test.ts` (create)

**Interfaces:**
- Consumes: `DEFAULT_PROFIT_CONFIG` from `@/lib/admin-control`.
- Produces: `describeEffectiveRate(stored: string, fallback: number) => string` exported from `@/lib/admin-control`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/profit-settings-defaults.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { describeEffectiveRate } from "@/lib/admin-control";

// A BLANK FIELD AND "8%" LOOK IDENTICAL ON SCREEN. The stored value is the
// empty string, which falls through to DEFAULT_PROFIT_CONFIG.processingFeePercent.
// The fee was always adjustable; what was missing was any way to see what was
// actually in effect.
describe("describeEffectiveRate", () => {
  it("names the default when the field is blank", () => {
    expect(describeEffectiveRate("", 8)).toBe("Using the 8% default");
  });

  it("names the default when the field is whitespace", () => {
    expect(describeEffectiveRate("   ", 8)).toBe("Using the 8% default");
  });

  it("reports an explicit value as in effect", () => {
    expect(describeEffectiveRate("2.9", 8)).toBe("2.9% in effect");
  });

  it("treats an explicit zero as a real choice, not a blank", () => {
    expect(describeEffectiveRate("0", 8)).toBe("0% in effect");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/profit-settings-defaults.test.ts`
Expected: FAIL — `describeEffectiveRate` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/admin-control.ts`, export:

```ts
/**
 * What rate is ACTUALLY in effect, for display beside an admin input.
 *
 * A blank stored value is not "0%" — it means the coded default applies. The
 * two are indistinguishable in an empty text box, which is why the effective
 * processing fee was invisible even though the field had always been editable.
 */
export function describeEffectiveRate(stored: string, fallback: number): string {
  return stored.trim() === "" ? `Using the ${fallback}% default` : `${Number(stored)}% in effect`;
}
```

In `src/components/admin-control-center-client.tsx`, import it plus `DEFAULT_PROFIT_CONFIG`, and render the hint under the processing-fee input:

```tsx
<p className="mt-1 text-xs text-neutral-500">
  {describeEffectiveRate(profitProcessingFee, DEFAULT_PROFIT_CONFIG.processingFeePercent)}
  {" · this fee is modelled, not a settled processor charge."}
</p>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/profit-settings-defaults.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Surface the same rate on the profit page (spec D3)**

In the admin profit page (`src/app/admin/profit/page.tsx`, or the component rendering the
"Payment processor fee (estimated)" expense line), render the effective rate beside that line using the
same helper:

```tsx
<span className="text-xs text-neutral-500">
  {describeEffectiveRate(String(profitSettings.processingFeePercent), DEFAULT_PROFIT_CONFIG.processingFeePercent)}
</span>
```

If that file does not exist under this path, locate it with
`grep -rln "Payment processor fee" src/app/admin` and use the file that renders the expense breakdown.

- [ ] **Step 6: Browser verification (CLAUDE.md requires it for admin UI)**

Run `npm run dev`, then drive `http://localhost:3000/admin` → Control Center → Profit. Confirm the hint reads "Using the 8% default" with the field blank, and "2.9% in effect" after typing `2.9`. **Do not save.** Check at 390x844 and desktop.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin-control.ts src/components/admin-control-center-client.tsx src/lib/profit-settings-defaults.test.ts src/app/admin/
git commit -m "Show the processor fee actually in effect beside the input"
```

---

### Task 8: Remove the EvoLabs code footprint

**Files:**
- Modify: `src/lib/admin-profit.ts` (`RecordShippingCostInput.source`, ~line 666)
- Delete: `src/lib/sql/load-evo-catalog.sql`, `src/lib/sql/load-evo-catalog-grouped.sql`, `src/lib/sql/product-costs-evo.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `RecordShippingCostInput.source` narrows to `"shippo" | "manual"`.

- [ ] **Step 1: Confirm the dead values are genuinely unused**

Run:

```bash
grep -rn '"provider"\|"fulfillment"' src/ --include=*.ts --include=*.tsx | grep -i shipping_cost_source
```

Expected: no matches other than the union declaration itself. If a caller appears, STOP and report it — the union is load-bearing and this task's premise is wrong.

- [ ] **Step 2: Narrow the union**

In `src/lib/admin-profit.ts`, change:

```ts
  source: "shippo" | "manual" | "provider" | "fulfillment";
```

to:

```ts
  /**
   * "shippo" is a label bought in Shippo; "manual" is a cost entered by hand.
   *
   * The former "provider" and "fulfillment" values belonged to the EvoLabs
   * third-party fulfilment integration, which is gone. Zero orders ever used
   * them.
   */
  source: "shippo" | "manual";
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. An error here means a caller still passes a removed value — fix that caller, do not widen the union back.

- [ ] **Step 4: Delete the EVO seed scripts**

```bash
git rm src/lib/sql/load-evo-catalog.sql src/lib/sql/load-evo-catalog-grouped.sql src/lib/sql/product-costs-evo.sql
```

These re-seed the EvoLabs catalogue and its costs. Re-running `product-costs-evo.sql` would overwrite the real landed costs — the files are a live footgun, and git history preserves them.

- [ ] **Step 5: Confirm nothing references the deleted files**

Run:

```bash
grep -rn "load-evo-catalog\|product-costs-evo" src/ docs/ 2>/dev/null
```

Expected: no matches in `src/`. Matches in `docs/` are historical prose and are fine.

- [ ] **Step 6: Commit**

```bash
git add -A src/lib/admin-profit.ts src/lib/sql/
git commit -m "Remove the EvoLabs fulfilment enum values and catalogue seed scripts"
```

---

### Task 9: Author the Phase 2 production changes — WRITE ONLY, DO NOT RUN

**Files:**
- Create: `src/lib/sql/phase2-financial-remediation.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: a reviewed, unexecuted SQL file plus exact before/after row counts for the owner's approval.

> **THIS TASK RUNS NO SQL.** It authors a file and gathers counts with read-only `SELECT`s. Executing any statement in this file is a Phase 2 action requiring separate explicit approval.

- [ ] **Step 1: Gather the exact affected-row counts (READ ONLY)**

Run each of these against production as a `SELECT` and record the number:

```sql
-- B1: published products carrying a stale parent cost
select count(*) from products p
where p.is_published and p.product_cost_cents is not null
  and exists (select 1 from product_doses d where d.product_id = p.id);

-- B3: order_items still holding an inherited EvoLabs cost
select count(*) from order_items
where (order_id, product_id, unit_cost_cents) in (
  values ('order-b8a56a42-d949-48a6-9a9a-b408d51c5006','glp-1',2456),
         ('order-6d2fbba4-0f72-412b-850e-385017d11342','mots-c::aa26520e-6267-4027-98dc-238e2ced3c97',2520),
         ('order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa','bacteriostatic-water',800),
         ('order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5','5-amino-1mq',3300));

-- B4: cerebrolysin / pinealon rows still carrying 3500
select count(*) from product_doses d join products p on p.id = d.product_id
where p.slug in ('cerebrolysin','pinealon') and d.product_cost_cents is not null;

-- B5: dead 3PL rows
select 'fulfillment_orders' t, count(*) from fulfillment_orders
union all select 'fulfillment_payouts', count(*) from fulfillment_payouts
union all select 'fulfillment_events', count(*) from fulfillment_events;
```

- [ ] **Step 2: Write the file**

Create `src/lib/sql/phase2-financial-remediation.sql` with exactly this content:

```sql
-- ============================================================================
-- PHASE 2 — NOT APPLIED. REQUIRES EXPLICIT OWNER APPROVAL BEFORE ANY EXECUTION.
--
-- Every statement below mutates production financial data. None has been run.
-- Run section by section, checking the verification SELECT after each before
-- proceeding. Sections are ordered so that nothing destructive precedes its
-- own archive.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SECTION 1 — audit table for the cost restatement (additive, non-destructive)
-- ---------------------------------------------------------------------------
create table if not exists public.order_cost_restatements (
  id              uuid primary key default gen_random_uuid(),
  order_id        text not null,
  order_item_id   uuid not null,
  old_cost_cents  integer,
  new_cost_cents  integer not null,
  reason          text not null,
  restated_by     text not null,
  restated_at     timestamptz not null default now()
);
alter table public.order_cost_restatements enable row level security;

-- ---------------------------------------------------------------------------
-- SECTION 2 — archive the dead EvoLabs 3PL tables. RUN BEFORE SECTION 3.
-- Expected: 2 / 2 / 194 rows.
-- ---------------------------------------------------------------------------
create table if not exists public.archive_fulfillment_orders  as select * from public.fulfillment_orders;
create table if not exists public.archive_fulfillment_payouts as select * from public.fulfillment_payouts;
create table if not exists public.archive_fulfillment_events  as select * from public.fulfillment_events;

-- VERIFY: each pair must match before Section 3 runs.
select 'orders'  as t, (select count(*) from public.fulfillment_orders)  as live,
                        (select count(*) from public.archive_fulfillment_orders)  as archived
union all
select 'payouts', (select count(*) from public.fulfillment_payouts), (select count(*) from public.archive_fulfillment_payouts)
union all
select 'events',  (select count(*) from public.fulfillment_events),  (select count(*) from public.archive_fulfillment_events);

-- ---------------------------------------------------------------------------
-- SECTION 3 — DESTRUCTIVE. Only after Section 2 verified equal counts.
-- ---------------------------------------------------------------------------
delete from public.fulfillment_events;
delete from public.fulfillment_payouts;
delete from public.fulfillment_orders;

-- ---------------------------------------------------------------------------
-- SECTION 4 — null the inherited EvoLabs parent costs.
-- Only for products that HAVE doses; a product with no dose rows keeps its
-- parent cost, which is the one case product-cogs.sql says it is for.
-- ---------------------------------------------------------------------------
update public.products p
   set product_cost_cents = null,
       updated_at = now()
 where p.is_published
   and p.product_cost_cents is not null
   and exists (select 1 from public.product_doses d where d.product_id = p.id);

-- VERIFY: expect 0.
select count(*) from public.products p
 where p.is_published and p.product_cost_cents is not null
   and exists (select 1 from public.product_doses d where d.product_id = p.id);

-- ---------------------------------------------------------------------------
-- SECTION 5 — cerebrolysin / pinealon: no cost on file.
-- Excluded from the landed-cost invoice; still carrying EvoLabs' 3500.
-- ---------------------------------------------------------------------------
update public.product_doses d
   set product_cost_cents = null, updated_at = now()
  from public.products p
 where p.id = d.product_id and p.slug in ('cerebrolysin', 'pinealon');

update public.products
   set product_cost_cents = null, updated_at = now()
 where slug in ('cerebrolysin', 'pinealon');

-- ---------------------------------------------------------------------------
-- SECTION 6 — restate the four order lines frozen at EvoLabs seed costs.
-- Audit row FIRST, then the update, so the old value is captured before it is
-- overwritten. Each update is guarded on the old value, so re-running is a
-- no-op rather than a second restatement.
-- ---------------------------------------------------------------------------
insert into public.order_cost_restatements
  (order_id, order_item_id, old_cost_cents, new_cost_cents, reason, restated_by)
select i.order_id, i.id, i.unit_cost_cents, v.new_cost,
       'Frozen at inherited EvoLabs seed cost; restated to the landed cost in sql/product-cogs.sql',
       'financial-reconciliation-audit'
  from public.order_items i
  join (values
    ('order-b8a56a42-d949-48a6-9a9a-b408d51c5006', 'glp-1', 2456, 383),
    ('order-6d2fbba4-0f72-412b-850e-385017d11342', 'mots-c::aa26520e-6267-4027-98dc-238e2ced3c97', 2520, 768),
    ('order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa', 'bacteriostatic-water', 800, 143),
    ('order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5', '5-amino-1mq', 3300, 1066)
  ) as v(order_id, product_id, old_cost, new_cost)
    on v.order_id = i.order_id and v.product_id = i.product_id
 where i.unit_cost_cents = v.old_cost;

update public.order_items i
   set unit_cost_cents = v.new_cost
  from (values
    ('order-b8a56a42-d949-48a6-9a9a-b408d51c5006', 'glp-1', 2456, 383),
    ('order-6d2fbba4-0f72-412b-850e-385017d11342', 'mots-c::aa26520e-6267-4027-98dc-238e2ced3c97', 2520, 768),
    ('order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa', 'bacteriostatic-water', 800, 143),
    ('order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5', '5-amino-1mq', 3300, 1066)
  ) as v(order_id, product_id, old_cost, new_cost)
 where v.order_id = i.order_id and v.product_id = i.product_id
   and i.unit_cost_cents = v.old_cost;

-- VERIFY: expect 4 restatement rows and 0 lines still at the old cost.
select (select count(*) from public.order_cost_restatements) as restated,
       (select count(*) from public.order_items
         where (order_id, unit_cost_cents) in (
           ('order-b8a56a42-d949-48a6-9a9a-b408d51c5006', 2456),
           ('order-6d2fbba4-0f72-412b-850e-385017d11342', 2520),
           ('order-49ec46c1-f5cd-4847-9e4f-ae0065e676fa', 800),
           ('order-21fb4328-f2d3-46b8-98c8-2b4514dc00a5', 3300))) as still_old;

-- ---------------------------------------------------------------------------
-- SECTION 7 — NOT SQL. Two manual actions for the owner.
--
-- A4. Order VL-E8F4D52F (order-b8a56a42-…) shipped on a hand-entered UPS
--     tracking number with no Shippo transaction, so its real postage is not
--     recoverable by any query or API call. The repair sweep cannot see it
--     (it has no label_purchased_at). The owner must enter the cost in
--     Admin -> Orders -> VL-E8F4D52F, which routes through
--     recordActualShippingCost with source 'manual'. NO SQL IS OFFERED HERE:
--     inventing a figure would be worse than the gap.
--
-- D1. Persist the processor fee explicitly. Admin -> Control Center -> Profit,
--     set "processing fee percent" to 8 and save. It is stored as an
--     admin_control_upsert audit row, not a table column, so it must be set
--     through the UI rather than by SQL.
-- ---------------------------------------------------------------------------
```

- [ ] **Step 3: Verify the file is complete WITHOUT executing it**

Read the file end to end and confirm: every `delete` in Section 3 is preceded by its `create table … as select` in Section 2; every destructive section is followed by a verification `select`; Section 6's updates are each guarded on the old value.

Run: `grep -c "^delete\|^update\|^insert" src/lib/sql/phase2-financial-remediation.sql`
Expected: 8.

Do **not** run the SQL. Do **not** open a database connection.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sql/phase2-financial-remediation.sql
git commit -m "Author the Phase 2 production remediation SQL, unexecuted"
```

---

### Task 10: Full suite and handoff report

**Files:** none modified.

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Record the exact totals: files passed/failed, tests passed/failed, duration. Do not summarise as "all green" — quote the numbers.

- [ ] **Step 2: If anything fails, fix or report**

A test failing because of a change in this plan is fixed here. A test failing for a pre-existing reason is reported verbatim as pre-existing, with its name — never silently skipped.

- [ ] **Step 3: Typecheck, lint, AND BUILD**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean.

**The build is not optional and not redundant with the other two.** Task 7 proved it: a
`"use client"` component importing a module that starts with `import "server-only"` is a hard
Next.js build error, and NEITHER `vitest` NOR `tsc --noEmit` can see it — `vitest.config.ts:24`
deliberately aliases `server-only` to an empty module so tests can import server code. A green
test suite and a clean typecheck coexisted with a build-breaking import. Only `npm run build`
catches this class of defect.

- [ ] **Step 4: Confirm zero production mutation**

State explicitly, having verified it: no migration applied, no production row written or deleted, no configuration changed, no deploy performed.

- [ ] **Step 5: Produce the handoff report**

Deliver to the owner: code changes; tests added; mutation controls; exact full-suite results; the 6 auto-repair effects each with its idempotency proof; the 5 alert-only effects each with the exact reason it is unsafe; proposed production changes with exact affected-row counts from Task 9 Step 1; the rollback plan; anything still unverified; and the zero-mutation confirmation.

- [ ] **Step 6: Push**

```bash
git push -u origin claude/vanta-financial-reconciliation-4mg1li
```
