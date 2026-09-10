// ---------------------------------------------------------------------------
// THE SEAM BETWEEN THE TWO PURE HALVES.
//
// tallyUnitsSoldByLineKey() produces keys; buildWatchlist() consumes them. Both
// are tested on their own, and both would still pass if they disagreed about
// what a key looks like — the tally would credit "dose:x" while inventory asked
// about "product:x", every forecast would silently vanish, and the watch list
// would fall back to thresholds forever while looking perfectly healthy.
//
// So this composes them over rows shaped like the real tables, using the key
// convention admin-inventory.ts actually emits (`dose:<id>` / `product:<id>`).
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";

import { tallyUnitsSoldByLineKey } from "@/lib/inventory-velocity";
import { buildWatchlist, type WatchlistLine } from "@/lib/inventory-watchlist";

const SETTINGS = { leadTimeDays: 14, coverTargetDays: 30, salesWindowDays: 30 };

// Shaped exactly as getInventoryRows() builds them (see toLine()).
const DOSE_LINE: WatchlistLine = {
  key: "dose:aaaaaaa1-0000-4000-8000-000000000001",
  productName: "BPC-157",
  variantLabel: "10mg",
  sku: null,
  availableQuantity: 25,
  incomingQuantity: 0,
  lowStockThreshold: 5,
};

const PRODUCT_LINE: WatchlistLine = {
  key: "product:55555555-5555-5555-5555-555555555555",
  productName: "GHK-Cu",
  variantLabel: null,
  sku: null,
  availableQuantity: 60,
  incomingQuantity: 0,
  lowStockThreshold: 5,
};

const SLUG_TO_PRODUCT_ID = { "ghk-cu": "55555555-5555-5555-5555-555555555555" };

describe("velocity keys reach the watch list", () => {
  it("forecasts a dose line from an order written as slug::doseId", () => {
    const sold = tallyUnitsSoldByLineKey(
      [{ product_id: "bpc-157-10mg::aaaaaaa1-0000-4000-8000-000000000001", quantity: 60 }],
      SLUG_TO_PRODUCT_ID,
    );

    const [entry] = buildWatchlist([DOSE_LINE], sold, SETTINGS);

    // 60 units / 30 days = 2/day against 25 on hand.
    expect(entry.basis).toBe("sales");
    expect(entry.daysUntilOut).toBe(12);
    expect(entry.tier).toBe("order-now");
    expect(entry.suggestedOrderQty).toBe(63);
  });

  it("forecasts a dose-less line from an order written as a bare slug", () => {
    const sold = tallyUnitsSoldByLineKey([{ product_id: "ghk-cu", quantity: 90 }], SLUG_TO_PRODUCT_ID);

    const [entry] = buildWatchlist([PRODUCT_LINE], sold, SETTINGS);

    // 90 / 30 = 3/day against 60 on hand.
    expect(entry.basis).toBe("sales");
    expect(entry.daysUntilOut).toBe(20);
    expect(entry.tier).toBe("order-soon");
    expect(entry.suggestedOrderQty).toBe(72);
  });

  it("does not credit one product's sales to another product's dose", () => {
    const sold = tallyUnitsSoldByLineKey([{ product_id: "ghk-cu", quantity: 90 }], SLUG_TO_PRODUCT_ID);

    const [entry] = buildWatchlist([DOSE_LINE], sold, SETTINGS);

    // The dose sold nothing, so it must fall back rather than inherit a pace.
    expect(entry).toBeUndefined();
  });
});
