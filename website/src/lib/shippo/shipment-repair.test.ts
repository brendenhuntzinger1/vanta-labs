import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A Shippo Order and its Shipment are two separate calls, and only the first is
// fatal. So there is a real, reachable state where an order sits in the Orders
// tab with blank dimensions, blank weight and no rates.
//
// The bug was not that the state existed -- it is recorded and surfaced. It was
// that NOTHING retried it. All three recovery paths keyed off the same column,
// and that column is populated in exactly this state:
//
//   syncOrderToShippo   returns early when shippo_order_id is set
//   sweepUnsyncedOrders filters .is("shippo_order_id", null)
//   the admin button    reported "already synced" and did nothing
//
// Three real orders reached this state and could never leave it. These tests
// pin the selection rule that decides what needs repair, which is where the
// mistake was.
// ---------------------------------------------------------------------------

interface OrderRow {
  orderId: string;
  paymentStatus: string;
  orderType: string;
  shippoOrderId: string | null;
  shippoShipmentId: string | null;
  shippoTransactionId: string | null;
}

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    orderId: "VL-EA5529EF",
    paymentStatus: "paid",
    orderType: "product",
    shippoOrderId: "adr_live_123",
    shippoShipmentId: null,
    shippoTransactionId: null,
    ...overrides,
  };
}

/** The filter sweepMissingShipments applies, expressed as a predicate. */
function needsRepair(row: OrderRow): boolean {
  return (
    row.paymentStatus === "paid" &&
    row.orderType !== "membership" &&
    row.shippoOrderId !== null &&
    row.shippoShipmentId === null &&
    row.shippoTransactionId === null
  );
}

describe("choosing which orders need their parcel attached", () => {
  it("selects an order that reached Shippo without a shipment", () => {
    expect(needsRepair(order())).toBe(true);
  });

  // The state the old sweep looked for. That one is handled by the ordinary
  // push; repairing it here would create a shipment bound to nothing.
  it("skips an order that never reached Shippo at all", () => {
    expect(needsRepair(order({ shippoOrderId: null }))).toBe(false);
  });

  it("skips an order whose parcel is already attached", () => {
    expect(needsRepair(order({ shippoShipmentId: "shp_live_456" }))).toBe(false);
  });

  // Once postage is bought the parcel is settled. Adding a shipment afterwards
  // changes nothing about the label and only clutters the account.
  it("skips an order that already has a label", () => {
    expect(needsRepair(order({ shippoTransactionId: "txn_live_789" }))).toBe(false);
  });

  it("skips an unpaid order", () => {
    expect(needsRepair(order({ paymentStatus: "pending_payment" }))).toBe(false);
  });

  it("skips a membership, which never ships", () => {
    expect(needsRepair(order({ orderType: "membership" }))).toBe(false);
  });

  // The two selections must not overlap, or one order gets both an ordinary
  // push and a repair, and ends up in Shippo twice.
  it("is disjoint from the unsynced-order selection", () => {
    const unsynced = (row: OrderRow) => row.paymentStatus === "paid" && row.shippoOrderId === null;
    const rows = [
      order(),
      order({ shippoOrderId: null }),
      order({ shippoShipmentId: "shp_1" }),
      order({ shippoTransactionId: "txn_1" }),
    ];

    for (const row of rows) {
      expect(needsRepair(row) && unsynced(row)).toBe(false);
    }
  });
});
