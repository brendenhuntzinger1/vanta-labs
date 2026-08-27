import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state for the double-run test below. vi.mock factories are
// hoisted above imports, so anything they close over must be created with
// vi.hoisted rather than a plain module-level const.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const row = {
    order_id: "order-1",
    label_purchased_at: "2026-08-25T02:21:10Z",
    label_voided_at: null as string | null,
    shippo_transaction_id: "txn-shippo-1",
    actual_shipping_cost_cents: null as number | null,
    postage_cost_cents: null as number | null,
  };

  const recordActualShippingCost = vi.fn(
    async (input: { orderId: string; amountCents: number; source: string }) => {
      row.actual_shipping_cost_cents = input.amountCents;
      return { ok: true as const };
    },
  );

  const getTransaction = vi.fn(async () => ({
    ok: true as const,
    data: { status: "SUCCESS", rate: { amount: "7.42", currency: "USD" } },
  }));

  const settledCentsFromTransaction = vi.fn(() => 742);

  const recordSystemAlert = vi.fn(async () => {});

  return { row, recordActualShippingCost, getTransaction, settledCentsFromTransaction, recordSystemAlert };
});

vi.mock("server-only", () => ({}));

vi.mock("@/lib/admin-profit", () => ({
  recordActualShippingCost: mocks.recordActualShippingCost,
}));

vi.mock("@/lib/shippo/client", () => ({
  getTransaction: mocks.getTransaction,
  settledCentsFromTransaction: mocks.settledCentsFromTransaction,
}));

vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: mocks.recordSystemAlert,
}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "orders") throw new Error(`unexpected table in test: ${table}`);
      // The real query now pushes the absence conditions down, so the mock
      // honours them: a row whose cost is already recorded, or whose label was
      // voided, is never returned at all.
      const builder = {
        select: () => builder,
        not: () => builder,
        gte: () => builder,
        is: (column: string, value: unknown) => {
          conditions.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit: async () => {
          const row = { ...mocks.row } as Record<string, unknown>;
          const kept = conditions.every(([column, value]) => (row[column] ?? null) === value);
          return { data: kept ? [row] : [], error: null };
        },
      };
      const conditions: Array<[string, unknown]> = [];
      return builder;
    },
  },
}));

import { findOrdersMissingShippingCost, repairMissingShippingCosts } from "@/lib/shipping-cost-repair";

// ABSENCE, not a queue. An order that bought a Shippo label and has no
// actual_shipping_cost_cents never had its postage recorded — and everything
// needed to record it (the transaction id) is still on the order. Looking for
// absence makes the sweep idempotent by construction and lets it clear the
// existing backlog, not just failures after deploy.
describe("findOrdersMissingShippingCost", () => {
  const base = {
    order_id: "order-1",
    label_purchased_at: "2026-08-25T02:21:10Z",
    label_voided_at: null as string | null,
    shippo_transaction_id: "3a7fa84885e7401487990c2b43ddc105",
    actual_shipping_cost_cents: null as number | null,
    postage_cost_cents: null as number | null,
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

  // FIX ROUND 2 — the void -> sweep re-charge.
  //
  // voidLabelForOrder KEEPS label_purchased_at and shippo_transaction_id and
  // nulls actual_shipping_cost_cents, so a voided order matched every one of
  // the conditions above. Its postage was REFUNDED: there is nothing to
  // record, and recording it charges the store for a parcel that never moved.
  it("skips an order whose label was voided — the postage was refunded", () => {
    expect(
      findOrdersMissingShippingCost([{ ...base, label_voided_at: "2026-08-26T09:00:00Z" }]),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE POINT OF THIS TASK: proof a retry cannot duplicate a financial write.
//
// findOrdersMissingShippingCost proves the selector — that it correctly picks
// out an unrepaired order. It does NOT prove the sweep is safe to re-run,
// because nothing in that suite ever calls the write path twice. A cron that
// fires this sweep on a schedule WILL see the same order again on the next
// tick if the first run's fix hasn't landed for any reason (a slow deploy, an
// overlapping run). This test runs repairMissingShippingCosts() twice over
// the SAME order and asserts the second run is a genuine no-op: it must not
// call recordActualShippingCost or getTransaction again, because the first
// run already recorded a non-null actual_shipping_cost_cents and the absence
// predicate excludes it.
// ---------------------------------------------------------------------------
describe("repairMissingShippingCosts — running twice over the same order", () => {
  beforeEach(() => {
    mocks.row.actual_shipping_cost_cents = null;
    mocks.row.label_voided_at = null;
    mocks.row.postage_cost_cents = null;
    mocks.recordActualShippingCost.mockClear();
    mocks.getTransaction.mockClear();
  });

  it("repairs the order on the first run, then does nothing on the second", async () => {
    const first = await repairMissingShippingCosts();
    expect(first).toEqual({ scanned: 1, repaired: 1, failed: 0 });
    expect(mocks.recordActualShippingCost).toHaveBeenCalledTimes(1);
    expect(mocks.getTransaction).toHaveBeenCalledTimes(1);
    // The mock write actually landed on the row the second run will read.
    expect(mocks.row.actual_shipping_cost_cents).toBe(742);

    // The repaired order no longer satisfies the pushed-down absence
    // condition, so the second run does not even scan it — `limit` now bounds
    // CANDIDATES rather than rows read, which is what stops the sweep
    // re-reading the same oldest N forever and never advancing.
    const second = await repairMissingShippingCosts();
    expect(second).toEqual({ scanned: 0, repaired: 0, failed: 0 });
    // Still 1 — the second run made no new call to either.
    expect(mocks.recordActualShippingCost).toHaveBeenCalledTimes(1);
    expect(mocks.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not scan, look up or re-record a voided label", async () => {
    mocks.row.label_voided_at = "2026-08-26T09:00:00Z";

    const result = await repairMissingShippingCosts();

    expect(result).toEqual({ scanned: 0, repaired: 0, failed: 0 });
    expect(mocks.getTransaction).not.toHaveBeenCalled();
    expect(mocks.recordActualShippingCost).not.toHaveBeenCalled();
    expect(mocks.row.actual_shipping_cost_cents).toBeNull();
  });
});
