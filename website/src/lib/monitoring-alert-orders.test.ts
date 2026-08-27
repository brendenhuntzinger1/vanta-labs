import { describe, expect, it } from "vitest";

import { extractAlertOrderIds } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// AN ALERT THAT NAMES A COUNT BUT NOT THE ORDERS IS NOT ACTIONABLE.
//
// shipping_cost_manual_entry_required renders on /admin/status as "2 order(s)
// have a label whose postage cannot be read back from Shippo. Enter the cost by
// hand in Admin -> Orders". The two order ids it is about are sitting in
// `context`, which the page never read -- so the operator was told to go and
// fix two orders without being told WHICH two, and the sweep is by definition
// the only thing that knows.
//
// This is the reader for that. Deliberately shape-tolerant: the sweeps do not
// agree on how they carry ids (`orderIds`, an `orders[]` of objects, or a
// single `orderId`), and a reader that understands only one of them silently
// renders no links for the others.
// ---------------------------------------------------------------------------

describe("extractAlertOrderIds", () => {
  it("reads the flat orderIds array the shipping sweeps write", () => {
    expect(
      extractAlertOrderIds({ total: 2, orderIds: ["order-aaa", "order-bbb"] }),
    ).toEqual(["order-aaa", "order-bbb"]);
  });

  it("reads ids out of an orders[] of objects", () => {
    // The same alert carries both shapes; a reader that only knew `orderIds`
    // would go blank the day a sweep drops the flat copy.
    expect(
      extractAlertOrderIds({
        orders: [
          { orderId: "order-aaa", error: "no usable postage amount" },
          { orderId: "order-bbb", error: "no usable postage amount" },
        ],
      }),
    ).toEqual(["order-aaa", "order-bbb"]);
  });

  it("reads a single orderId", () => {
    expect(extractAlertOrderIds({ orderId: "order-solo" })).toEqual(["order-solo"]);
  });

  it("does not repeat an id carried in two shapes at once", () => {
    // The live shipping alert carries BOTH orderIds and orders[]. Rendering
    // each order twice makes a 2-order backlog look like a 4-order one.
    expect(
      extractAlertOrderIds({
        orderIds: ["order-aaa", "order-bbb"],
        orders: [{ orderId: "order-aaa" }, { orderId: "order-bbb" }],
      }),
    ).toEqual(["order-aaa", "order-bbb"]);
  });

  it("returns nothing for an alert that names no order", () => {
    // inventory_rpc_failed stores an explicit null. A reader that turned that
    // into a link would render an href to /admin/orders/null.
    expect(extractAlertOrderIds({ rpc: "expire_stale_reservations", orderId: null })).toEqual([]);
    expect(extractAlertOrderIds({})).toEqual([]);
    expect(extractAlertOrderIds(null)).toEqual([]);
  });

  it("ignores blank and non-string entries rather than linking them", () => {
    expect(
      extractAlertOrderIds({ orderIds: ["order-aaa", "", "   ", 42, null, "order-bbb"] }),
    ).toEqual(["order-aaa", "order-bbb"]);
  });

  it("is bounded, so one enormous backlog cannot flood the status page", () => {
    const many = Array.from({ length: 200 }, (_, i) => `order-${i}`);
    const shown = extractAlertOrderIds({ orderIds: many });
    expect(shown.length).toBeLessThanOrEqual(50);
    expect(shown[0]).toBe("order-0");
  });
});
