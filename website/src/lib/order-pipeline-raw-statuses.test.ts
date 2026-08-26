import { describe, expect, it } from "vitest";

import { normalizeLegacyStatus, rawStatusesFor } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// THE SYNONYM TRAP.
//
// orders.fulfillment_status carries live rows in several spellings that all
// mean the same thing. Any count that filters on ONE literal misses the rest.
//
// That is not hypothetical: the Revenue page's "Awaiting Fulfillment" tile
// filtered on `.eq("fulfillment_status", "awaiting_fulfillment")`. Driven
// against 120 orders with 60 sitting in the pick queue as `ready_to_fulfill`,
// it reported 0 while the fulfilment workstation reported 60 — two screens,
// same database, opposite answers.
//
// rawStatusesFor() is the queryable inverse of normalizeLegacyStatus(): give it
// a canonical status, get every raw value that normalises to it.
// ---------------------------------------------------------------------------

describe("rawStatusesFor", () => {
  it("returns every spelling that lands in the pick queue", () => {
    expect(rawStatusesFor("ready_to_fulfill").sort()).toEqual(
      ["awaiting_fulfillment", "processing", "ready_to_fulfill", "sent_to_fulfillment"].sort(),
    );
  });

  it("includes the canonical value itself", () => {
    for (const status of ["paid", "packed", "shipped", "delivered", "ready_to_fulfill"] as const) {
      expect(rawStatusesFor(status)).toContain(status);
    }
  });

  it("round-trips: everything it returns normalises back to what was asked for", () => {
    // The invariant that makes it safe to hand straight to an .in() filter.
    for (const status of [
      "awaiting_payment",
      "paid",
      "ready_to_fulfill",
      "packed",
      "label_purchased",
      "shipped",
      "in_transit",
      "delivered",
      "returned",
    ] as const) {
      for (const raw of rawStatusesFor(status)) {
        expect(normalizeLegacyStatus(raw)).toBe(status);
      }
    }
  });

  it("never returns an empty list for a canonical status", () => {
    // An empty list handed to .in() matches nothing, which would silently zero
    // whichever counter used it — the exact failure being fixed.
    for (const status of ["paid", "ready_to_fulfill", "packed", "shipped"] as const) {
      expect(rawStatusesFor(status).length).toBeGreaterThan(0);
    }
  });

  it("keeps the pick queue and the shipped queue disjoint", () => {
    const ready = new Set(rawStatusesFor("ready_to_fulfill"));
    for (const raw of rawStatusesFor("shipped")) {
      expect(ready.has(raw)).toBe(false);
    }
  });
});
