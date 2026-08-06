import { describe, expect, it } from "vitest";

import {
  FULFILLMENT_STATUS_LABELS,
  FULFILLMENT_STATUS_ORDER,
  FULFILLMENT_STATUS_SOURCES,
  FULFILLMENT_TRANSITIONS,
  allowedTransitions,
  applyTrackingUpdate,
  applyTransition,
  canTransition,
  fulfillmentStatusLabel,
  isFulfillmentStatus,
  isTerminal,
  mapShippoTrackingStatus,
  normalizeLegacyStatus,
  progressRank,
  type FulfillmentStatus,
  type TransitionSource,
} from "@/lib/order-pipeline";

const ALL_SOURCES: TransitionSource[] = ["admin", "shippo", "system"];

describe("status table", () => {
  it("labels every status exactly once", () => {
    expect(new Set(FULFILLMENT_STATUS_ORDER).size).toBe(FULFILLMENT_STATUS_ORDER.length);
    for (const status of FULFILLMENT_STATUS_ORDER) {
      expect(FULFILLMENT_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(FULFILLMENT_STATUS_LABELS).sort()).toEqual([...FULFILLMENT_STATUS_ORDER].sort());
  });

  it("declares transitions and permitted sources for every status", () => {
    for (const status of FULFILLMENT_STATUS_ORDER) {
      expect(FULFILLMENT_TRANSITIONS[status]).toBeDefined();
      expect(FULFILLMENT_STATUS_SOURCES[status].length).toBeGreaterThan(0);
      // A transition to a status nobody may set would be dead weight in the graph.
      for (const target of FULFILLMENT_TRANSITIONS[status]) {
        expect(isFulfillmentStatus(target)).toBe(true);
        expect(status).not.toBe(target);
      }
    }
  });

  it("ranks the shipping ladder in order and leaves exception outcomes unranked", () => {
    const ladder: FulfillmentStatus[] = [
      "awaiting_payment",
      "paid",
      "ready_to_fulfill",
      "packed",
      "label_purchased",
      "shipped",
      "in_transit",
      "out_for_delivery",
      "delivered",
    ];
    const ranks = ladder.map((status) => progressRank(status));
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const status of ["cancelled", "refunded", "returned"] as FulfillmentStatus[]) {
      expect(progressRank(status)).toBeNull();
    }
  });

  it("treats delivered, cancelled, refunded and returned as terminal", () => {
    const terminal = FULFILLMENT_STATUS_ORDER.filter((status) => isTerminal(status));
    expect(terminal).toEqual(["delivered", "cancelled", "refunded", "returned"]);
  });
});

describe("normalizeLegacyStatus", () => {
  // Every value the database can actually hold today, from the payment webhook,
  // quote orders, replacements, the admin dropdown and the removed 3PL.
  const LEGACY: Array<[string, FulfillmentStatus]> = [
    ["awaiting_fulfillment", "ready_to_fulfill"],
    ["pending", "paid"],
    ["processing", "ready_to_fulfill"],
    ["fulfilled", "shipped"],
    ["partially_fulfilled", "shipped"],
    ["sent_to_fulfillment", "ready_to_fulfill"],
    ["pending_payment", "awaiting_payment"],
    ["unpaid", "awaiting_payment"],
    ["canceled", "cancelled"],
    ["shipped", "shipped"],
    ["delivered", "delivered"],
    ["cancelled", "cancelled"],
    ["refunded", "refunded"],
    ["returned", "returned"],
    ["out_for_delivery", "out_for_delivery"],
    ["in_transit", "in_transit"],
    ["packed", "packed"],
    ["label_purchased", "label_purchased"],
    ["ready_to_fulfill", "ready_to_fulfill"],
    ["paid", "paid"],
    ["awaiting_payment", "awaiting_payment"],
  ];

  it.each(LEGACY)("maps %s to %s", (legacy, expected) => {
    expect(normalizeLegacyStatus(legacy)).toBe(expected);
  });

  it("maps every current status to itself", () => {
    for (const status of FULFILLMENT_STATUS_ORDER) {
      expect(normalizeLegacyStatus(status)).toBe(status);
    }
  });

  it("tolerates casing, padding and hand-typed separators", () => {
    expect(normalizeLegacyStatus("  Awaiting Fulfillment ")).toBe("ready_to_fulfill");
    expect(normalizeLegacyStatus("OUT-FOR-DELIVERY")).toBe("out_for_delivery");
  });

  it("returns null rather than guessing at an unknown value", () => {
    expect(normalizeLegacyStatus("teleported")).toBeNull();
    expect(normalizeLegacyStatus("")).toBeNull();
    expect(normalizeLegacyStatus("   ")).toBeNull();
    expect(normalizeLegacyStatus(null)).toBeNull();
    expect(normalizeLegacyStatus(undefined)).toBeNull();
  });

  it("still renders something readable for a value it cannot map", () => {
    expect(fulfillmentStatusLabel("awaiting_fulfillment")).toBe("Ready to fulfill");
    expect(fulfillmentStatusLabel("some_legacy_thing")).toBe("Some legacy thing");
    expect(fulfillmentStatusLabel(null)).toBe("Unknown");
  });
});

describe("canTransition - legal moves", () => {
  // Drive the assertions off the graph itself: if an edge is ever added without
  // a source that can travel it, this fails instead of silently shipping a
  // transition no caller can perform.
  const edges: Array<[FulfillmentStatus, FulfillmentStatus]> = FULFILLMENT_STATUS_ORDER.flatMap((from) =>
    FULFILLMENT_TRANSITIONS[from].map((to) => [from, to] as [FulfillmentStatus, FulfillmentStatus]),
  );

  it.each(edges)("allows %s -> %s for at least one source", (from, to) => {
    const accepted = ALL_SOURCES.filter((source) => canTransition(from, to, source).ok);
    expect(accepted.length).toBeGreaterThan(0);
  });

  it("walks the happy path from payment to delivery", () => {
    const path: Array<[FulfillmentStatus, FulfillmentStatus, TransitionSource]> = [
      ["awaiting_payment", "paid", "system"],
      ["paid", "ready_to_fulfill", "system"],
      ["ready_to_fulfill", "packed", "admin"],
      ["packed", "label_purchased", "system"],
      ["label_purchased", "shipped", "admin"],
      ["shipped", "in_transit", "shippo"],
      ["in_transit", "out_for_delivery", "shippo"],
      ["out_for_delivery", "delivered", "shippo"],
    ];
    for (const [from, to, source] of path) {
      const result = canTransition(from, to, source);
      expect(result.ok, `${from} -> ${to} via ${source}`).toBe(true);
      if (result.ok) {
        expect(result.next).toBe(to);
        expect(result.from).toBe(from);
      }
    }
  });

  it("accepts a legacy stored status as the starting point", () => {
    // The queue is full of rows that still say "awaiting_fulfillment".
    const result = canTransition("awaiting_fulfillment", "packed", "admin");
    expect(result).toMatchObject({ ok: true, from: "ready_to_fulfill", next: "packed" });
  });

  it("lets a label be voided back to packed and re-bought", () => {
    expect(canTransition("label_purchased", "packed", "system").ok).toBe(true);
    expect(canTransition("packed", "label_purchased", "system").ok).toBe(true);
  });

  it("allows tracking to skip statuses when scans are missed", () => {
    expect(canTransition("label_purchased", "delivered", "shippo").ok).toBe(true);
    expect(canTransition("shipped", "out_for_delivery", "shippo").ok).toBe(true);
  });
});

describe("canTransition - illegal moves", () => {
  it("rejects a jump that skips buying a label", () => {
    const result = canTransition("paid", "shipped", "admin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_allowed");
    }
  });

  it("rejects shipping an order that has not been paid for", () => {
    expect(canTransition("awaiting_payment", "ready_to_fulfill", "admin").ok).toBe(false);
    expect(canTransition("awaiting_payment", "delivered", "shippo").ok).toBe(false);
  });

  it("rejects cancelling an order whose goods already left", () => {
    const result = canTransition("shipped", "cancelled", "admin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_allowed");
    }
  });

  it("reports a no-op instead of pretending something changed", () => {
    const result = canTransition("delivered", "delivered", "shippo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unchanged");
    }
  });

  it("rejects unknown statuses on either side", () => {
    const from = canTransition("teleported", "packed", "admin");
    expect(from.ok).toBe(false);
    if (!from.ok) {
      expect(from.reason).toBe("unknown_status");
    }

    const to = canTransition("packed", "beamed_up", "admin");
    expect(to.ok).toBe(false);
    if (!to.ok) {
      expect(to.reason).toBe("unknown_status");
    }
  });

  it("rejects every pair that is not an edge, for every source", () => {
    for (const from of FULFILLMENT_STATUS_ORDER) {
      for (const to of FULFILLMENT_STATUS_ORDER) {
        if (from === to || FULFILLMENT_TRANSITIONS[from].includes(to)) {
          continue;
        }
        for (const source of ALL_SOURCES) {
          const result = canTransition(from, to, source);
          expect(result.ok, `${from} -> ${to} via ${source} should be rejected`).toBe(false);
        }
      }
    }
  });

  it("never throws on hostile input", () => {
    const junk = [null, undefined, "", "   ", "{}", "__proto__", "constructor", "toString", "1"];
    for (const from of junk) {
      for (const to of junk) {
        expect(() => canTransition(from, to, "shippo")).not.toThrow();
        expect(canTransition(from, to, "shippo").ok).toBe(false);
      }
    }
    // Prototype keys must not resolve through the lookup objects.
    expect(normalizeLegacyStatus("__proto__")).toBeNull();
    expect(mapShippoTrackingStatus("constructor")).toBeNull();
  });
});

describe("who may perform a transition", () => {
  it("lets a human mark an order packed and shipped", () => {
    expect(canTransition("ready_to_fulfill", "packed", "admin").ok).toBe(true);
    expect(canTransition("packed", "shipped", "admin").ok).toBe(true);
    expect(canTransition("label_purchased", "shipped", "admin").ok).toBe(true);
  });

  it("refuses to let a human claim a delivery only the carrier can observe", () => {
    for (const carrierOnly of ["in_transit", "out_for_delivery", "delivered"] as FulfillmentStatus[]) {
      for (const source of ["admin", "system"] as TransitionSource[]) {
        const result = canTransition("shipped", carrierOnly, source);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("source_not_permitted");
        }
      }
    }
  });

  it("refuses to let tracking touch packing, money or cancellation", () => {
    const forbidden: Array<[FulfillmentStatus, FulfillmentStatus]> = [
      ["ready_to_fulfill", "packed"],
      ["label_purchased", "shipped"],
      ["paid", "ready_to_fulfill"],
      ["delivered", "refunded"],
      ["paid", "cancelled"],
    ];
    for (const [from, to] of forbidden) {
      const result = canTransition(from, to, "shippo");
      expect(result.ok, `shippo must not set ${to}`).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("source_not_permitted");
      }
    }
  });

  it("keeps money state out of the fulfillment dropdown", () => {
    // Only the payment webhook marks an order paid.
    const result = canTransition("awaiting_payment", "paid", "admin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("source_not_permitted");
    }
    expect(canTransition("awaiting_payment", "paid", "system").ok).toBe(true);
  });

  it("offers a human only the buttons they can actually press", () => {
    expect(allowedTransitions("awaiting_fulfillment", "admin")).toEqual([
      "packed",
      "label_purchased",
      "shipped",
      "cancelled",
      "refunded",
    ]);
    // No in_transit / out_for_delivery / delivered - those are the carrier's to report.
    expect(allowedTransitions("shipped", "admin")).toEqual(["refunded", "returned"]);
    expect(allowedTransitions("refunded", "admin")).toEqual([]);
  });

  it("agrees with canTransition for every status and source", () => {
    for (const from of FULFILLMENT_STATUS_ORDER) {
      for (const source of ALL_SOURCES) {
        const offered = allowedTransitions(from, source);
        for (const to of FULFILLMENT_STATUS_ORDER) {
          expect(offered.includes(to)).toBe(canTransition(from, to, source).ok);
        }
      }
    }
  });
});

describe("terminal-state protection", () => {
  const TERMINALS: FulfillmentStatus[] = ["delivered", "cancelled", "refunded", "returned"];

  it("blocks every carrier scan once the journey has ended", () => {
    for (const from of TERMINALS) {
      for (const to of FULFILLMENT_STATUS_ORDER) {
        if (to === from) {
          continue;
        }
        const result = canTransition(from, to, "shippo");
        expect(result.ok, `shippo must not move ${from} -> ${to}`).toBe(false);
        if (!result.ok) {
          expect(["terminal", "source_not_permitted"]).toContain(result.reason);
        }
      }
    }
  });

  it("reports terminal, not a generic refusal, for a scan on a finished order", () => {
    const result = canTransition("delivered", "in_transit", "shippo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("terminal");
    }
  });

  it("still lets a human record the money outcome after the parcel is done", () => {
    expect(canTransition("delivered", "refunded", "admin").ok).toBe(true);
    expect(canTransition("delivered", "returned", "admin").ok).toBe(true);
    expect(canTransition("cancelled", "refunded", "admin").ok).toBe(true);
    expect(canTransition("returned", "refunded", "admin").ok).toBe(true);
  });

  it("treats refunded as the end of the line for everyone", () => {
    for (const to of FULFILLMENT_STATUS_ORDER) {
      for (const source of ALL_SOURCES) {
        expect(canTransition("refunded", to, source).ok).toBe(false);
      }
    }
  });
});

describe("out-of-order tracking webhooks", () => {
  it("ignores a TRANSIT event that arrives after DELIVERED", () => {
    const result = applyTrackingUpdate({ orderId: "VL-1", from: "delivered", trackingStatus: "TRANSIT" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("terminal");
      expect(result.to).toBe("in_transit");
    }
  });

  it("ignores an OUT_FOR_DELIVERY event that arrives after DELIVERED", () => {
    expect(applyTrackingUpdate({ orderId: "VL-1", from: "delivered", trackingStatus: "OUT_FOR_DELIVERY" }).ok).toBe(
      false,
    );
  });

  it("ignores a TRANSIT event that arrives after OUT_FOR_DELIVERY", () => {
    const result = applyTrackingUpdate({ orderId: "VL-1", from: "out_for_delivery", trackingStatus: "TRANSIT" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("regression");
    }
  });

  it("ignores a PRE_TRANSIT event that arrives after the parcel shipped", () => {
    const result = applyTrackingUpdate({ orderId: "VL-1", from: "shipped", trackingStatus: "PRE_TRANSIT" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("regression");
    }
  });

  it("ignores a redelivered duplicate of the current status", () => {
    const result = applyTrackingUpdate({ orderId: "VL-1", from: "in_transit", trackingStatus: "TRANSIT" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unchanged");
    }
  });

  it("applies the scans that are genuinely newer, in any arrival order", () => {
    // DELIVERED first, then the earlier scans: the order must end delivered.
    let status: FulfillmentStatus = "label_purchased";
    for (const scan of ["DELIVERED", "TRANSIT", "OUT_FOR_DELIVERY", "PRE_TRANSIT"]) {
      const result = applyTrackingUpdate({ orderId: "VL-1", from: status, trackingStatus: scan });
      if (result.ok) {
        status = result.next;
      }
    }
    expect(status).toBe("delivered");
  });

  it("routes a failed or returned parcel to returned from anywhere in flight", () => {
    for (const from of ["label_purchased", "shipped", "in_transit", "out_for_delivery"] as FulfillmentStatus[]) {
      for (const scan of ["RETURNED", "FAILURE"]) {
        const result = applyTrackingUpdate({ orderId: "VL-1", from, trackingStatus: scan });
        expect(result.ok, `${scan} from ${from}`).toBe(true);
        if (result.ok) {
          expect(result.next).toBe("returned");
        }
      }
    }
  });

  it("drops a scan state Shippo has never documented", () => {
    const result = applyTrackingUpdate({ orderId: "VL-1", from: "shipped", trackingStatus: "TELEPORTED" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unknown_status");
      expect(result.from).toBe("shipped");
    }
  });
});

describe("mapShippoTrackingStatus", () => {
  const CASES: Array<[string, FulfillmentStatus]> = [
    ["UNKNOWN", "label_purchased"],
    ["PRE_TRANSIT", "label_purchased"],
    ["TRANSIT", "in_transit"],
    ["OUT_FOR_DELIVERY", "out_for_delivery"],
    ["DELIVERED", "delivered"],
    ["RETURNED", "returned"],
    ["FAILURE", "returned"],
  ];

  it.each(CASES)("maps %s to %s", (scan, expected) => {
    expect(mapShippoTrackingStatus(scan)).toBe(expected);
  });

  it("normalises casing and padding from the wire", () => {
    expect(mapShippoTrackingStatus(" delivered ")).toBe("delivered");
  });

  it("returns null for anything else", () => {
    expect(mapShippoTrackingStatus("IN_TRANSIT")).toBeNull();
    expect(mapShippoTrackingStatus("")).toBeNull();
    expect(mapShippoTrackingStatus(null)).toBeNull();
    expect(mapShippoTrackingStatus(undefined)).toBeNull();
  });
});

describe("applyTransition", () => {
  it("returns an insertable history row on success", () => {
    const result = applyTransition({
      orderId: "VL-1001",
      from: "awaiting_fulfillment",
      to: "packed",
      source: "admin",
      actor: "  ben  ",
    });
    expect(result).toEqual({
      ok: true,
      from: "ready_to_fulfill",
      next: "packed",
      history: {
        order_id: "VL-1001",
        // Normalised, so the timeline is queryable with one vocabulary.
        from_status: "ready_to_fulfill",
        to_status: "packed",
        source: "admin",
        actor: "ben",
      },
    });
  });

  it("stores a null actor rather than an empty string", () => {
    const result = applyTransition({ orderId: "VL-1", from: "packed", to: "label_purchased", source: "system" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.history.actor).toBeNull();
    }
  });

  it("labels tracking-driven history rows with the shippo source", () => {
    const result = applyTrackingUpdate({ orderId: "VL-1", from: "shipped", trackingStatus: "TRANSIT" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.history).toEqual({
        order_id: "VL-1",
        from_status: "shipped",
        to_status: "in_transit",
        source: "shippo",
        actor: "shippo",
      });
    }
  });

  it("produces no history row when the transition is refused", () => {
    const result = applyTransition({ orderId: "VL-1", from: "paid", to: "shipped", source: "admin" });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("history");
    if (!result.ok) {
      expect(result.message).toBeTruthy();
    }
  });
});
