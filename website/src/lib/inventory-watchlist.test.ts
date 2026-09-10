// RED phase: these describe the watch-list rules before any of them exist.
import { describe, expect, it } from "vitest";

import { buildWatchlist, type WatchlistLine, type WatchlistSettings } from "@/lib/inventory-watchlist";

const SETTINGS: WatchlistSettings = {
  leadTimeDays: 14,
  coverTargetDays: 30,
  salesWindowDays: 30,
};

function line(overrides: Partial<WatchlistLine> = {}): WatchlistLine {
  return {
    key: "dose:1",
    productName: "GLP-3",
    variantLabel: "30mg",
    sku: "GLP3-30",
    availableQuantity: 100,
    incomingQuantity: 0,
    lowStockThreshold: 5,
    ...overrides,
  };
}

describe("buildWatchlist — what it flags", () => {
  it("leaves a well-stocked line off the list entirely", () => {
    // 30 units sold in 30 days = 1/day. 100 on hand is 100 days of cover,
    // well past the 44-day (14 lead + 30 cover) horizon.
    const result = buildWatchlist([line({ availableQuantity: 100 })], { "dose:1": 30 }, SETTINGS);

    expect(result).toEqual([]);
  });

  it("flags a line that runs out inside the lead time as order-now", () => {
    // 1/day pace, 10 left -> 10 days, inside the 14-day lead time.
    const result = buildWatchlist([line({ availableQuantity: 10 })], { "dose:1": 30 }, SETTINGS);

    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe("order-now");
    expect(result[0].daysUntilOut).toBe(10);
  });

  it("flags a line that runs out inside the cover horizon as order-soon", () => {
    // 1/day pace, 40 left -> 40 days: past lead time, inside 44.
    const result = buildWatchlist([line({ availableQuantity: 40 })], { "dose:1": 30 }, SETTINGS);

    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe("order-soon");
  });

  it("flags a zero-stock line as out even when it has never sold", () => {
    const result = buildWatchlist([line({ availableQuantity: 0 })], {}, SETTINGS);

    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe("out");
  });
});

describe("buildWatchlist — lines with no recent sales fall back to the threshold", () => {
  it("flags a no-sales line at or below its threshold as order-now", () => {
    const result = buildWatchlist([line({ availableQuantity: 5, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe("order-now");
    expect(result[0].basis).toBe("threshold");
    expect(result[0].daysUntilOut).toBeNull();
    expect(result[0].unitsPerWeek).toBeNull();
  });

  it("flags a no-sales line within twice its threshold as order-soon", () => {
    const result = buildWatchlist([line({ availableQuantity: 9, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result[0].tier).toBe("order-soon");
  });

  it("leaves a no-sales line well above its threshold off the list", () => {
    const result = buildWatchlist([line({ availableQuantity: 40, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result).toEqual([]);
  });

  it("never nags about a no-sales line whose threshold is zero", () => {
    // Threshold 0 is the owner saying "don't warn me about this one".
    const result = buildWatchlist([line({ availableQuantity: 1, lowStockThreshold: 0 })], {}, SETTINGS);

    expect(result).toEqual([]);
  });
});

describe("buildWatchlist — stock already on order", () => {
  it("stops flagging a line once enough is on order to cover it", () => {
    // 1/day, 10 available would be order-now, but 60 are already inbound.
    const result = buildWatchlist(
      [line({ availableQuantity: 10, incomingQuantity: 60 })],
      { "dose:1": 30 },
      SETTINGS,
    );

    expect(result).toEqual([]);
  });

  it("still reports a zero-stock line as out while a shipment is inbound", () => {
    const result = buildWatchlist(
      [line({ availableQuantity: 0, incomingQuantity: 60 })],
      { "dose:1": 30 },
      SETTINGS,
    );

    expect(result[0].tier).toBe("out");
    expect(result[0].incoming).toBe(60);
  });

  it("subtracts what is already on order from the suggested quantity", () => {
    // 1/day x 44 days of target cover = 44 units wanted; 10 here + 20 inbound.
    const result = buildWatchlist(
      [line({ availableQuantity: 10, incomingQuantity: 20 })],
      { "dose:1": 30 },
      SETTINGS,
    );

    expect(result[0].suggestedOrderQty).toBe(14);
  });
});

describe("buildWatchlist — suggested order quantity", () => {
  it("orders enough to cover lead time plus the cover target", () => {
    // 60 units in 30 days = 2/day. 2 x 44 = 88 wanted, 10 on hand -> 78.
    const result = buildWatchlist([line({ availableQuantity: 10 })], { "dose:1": 60 }, SETTINGS);

    expect(result[0].suggestedOrderQty).toBe(78);
  });

  it("rounds a fractional requirement up to whole units", () => {
    // 10 units in 30 days = 0.333/day. 0.333 x 44 = 14.67 -> 15, less 1 on hand.
    const result = buildWatchlist([line({ availableQuantity: 1 })], { "dose:1": 10 }, SETTINGS);

    expect(result[0].suggestedOrderQty).toBe(14);
  });

  it("tops a no-sales line up to twice its threshold", () => {
    const result = buildWatchlist([line({ availableQuantity: 2, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result[0].suggestedOrderQty).toBe(8);
  });
});

describe("buildWatchlist — ordering", () => {
  it("puts out-of-stock first, then order-now, then order-soon", () => {
    const result = buildWatchlist(
      [
        line({ key: "dose:soon", availableQuantity: 40 }),
        line({ key: "dose:out", availableQuantity: 0 }),
        line({ key: "dose:now", availableQuantity: 10 }),
      ],
      { "dose:soon": 30, "dose:out": 30, "dose:now": 30 },
      SETTINGS,
    );

    expect(result.map((entry) => entry.key)).toEqual(["dose:out", "dose:now", "dose:soon"]);
  });

  it("puts the line that runs out soonest first within a tier", () => {
    const result = buildWatchlist(
      [
        line({ key: "dose:twelve", availableQuantity: 12 }),
        line({ key: "dose:three", availableQuantity: 3 }),
      ],
      { "dose:twelve": 30, "dose:three": 30 },
      SETTINGS,
    );

    expect(result.map((entry) => entry.key)).toEqual(["dose:three", "dose:twelve"]);
  });
});

describe("buildWatchlist — tier boundaries are exact", () => {
  // 1 unit/day, so available == days. Lead time 14, horizon 44.
  const sold = { "dose:1": 30 };

  it("treats exactly the lead time as order-now", () => {
    expect(buildWatchlist([line({ availableQuantity: 14 })], sold, SETTINGS)[0].tier).toBe("order-now");
  });

  it("treats one day past the lead time as order-soon", () => {
    expect(buildWatchlist([line({ availableQuantity: 15 })], sold, SETTINGS)[0].tier).toBe("order-soon");
  });

  it("treats exactly the cover horizon as order-soon", () => {
    expect(buildWatchlist([line({ availableQuantity: 44 })], sold, SETTINGS)[0].tier).toBe("order-soon");
  });

  it("leaves one day past the cover horizon off the list", () => {
    expect(buildWatchlist([line({ availableQuantity: 45 })], sold, SETTINGS)).toEqual([]);
  });
});

describe("buildWatchlist — survives unusable data instead of guessing", () => {
  it("treats a NaN quantity as no stock rather than forecasting from it", () => {
    const result = buildWatchlist(
      [line({ availableQuantity: Number.NaN })],
      { "dose:1": 30 },
      SETTINGS,
    );

    expect(result[0].tier).toBe("out");
    expect(result[0].available).toBe(0);
  });

  it("treats a negative quantity as no stock", () => {
    const result = buildWatchlist([line({ availableQuantity: -12 })], {}, SETTINGS);

    expect(result[0].tier).toBe("out");
    expect(result[0].available).toBe(0);
  });

  it("ignores negative sales rather than forecasting a growing shelf", () => {
    const result = buildWatchlist([line({ availableQuantity: 3 })], { "dose:1": -30 }, SETTINGS);

    expect(result[0].basis).toBe("threshold");
    expect(result[0].daysUntilOut).toBeNull();
  });

  it("floors a fractional quantity to whole vials", () => {
    const result = buildWatchlist([line({ availableQuantity: 4.9, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result[0].available).toBe(4);
  });

  it("falls back to the threshold when the sales window is unusable", () => {
    // A zero-length window makes any sales count meaningless, so forecasting
    // from it would invent an alarming "runs out today" from a config typo.
    const result = buildWatchlist(
      [line({ availableQuantity: 3, lowStockThreshold: 5 })],
      { "dose:1": 30 },
      { ...SETTINGS, salesWindowDays: 0 },
    );

    expect(result[0].basis).toBe("threshold");
    expect(result[0].daysUntilOut).toBeNull();
    expect(Number.isFinite(result[0].suggestedOrderQty)).toBe(true);
  });

  it("does not claim a sales window it never measured", () => {
    const result = buildWatchlist(
      [line({ availableQuantity: 3, lowStockThreshold: 5 })],
      {},
      { ...SETTINGS, salesWindowDays: 0 },
    );

    expect(result[0].reason).toBe("3 units left — at or below your alert level of 5");
  });

  it("handles a same-day supplier with a zero lead time", () => {
    const result = buildWatchlist(
      [line({ availableQuantity: 10 })],
      { "dose:1": 30 },
      { ...SETTINGS, leadTimeDays: 0 },
    );

    expect(result[0].tier).toBe("order-soon");
  });

  it("never suggests a negative order for a line already over-ordered", () => {
    const result = buildWatchlist(
      [line({ availableQuantity: 0, incomingQuantity: 500 })],
      { "dose:1": 30 },
      SETTINGS,
    );

    expect(result[0].tier).toBe("out");
    expect(result[0].suggestedOrderQty).toBe(0);
  });

  it("returns nothing for an empty catalogue", () => {
    expect(buildWatchlist([], {}, SETTINGS)).toEqual([]);
  });
});

describe("buildWatchlist — the sentence shown on screen", () => {
  it("explains a forecast line in plain words", () => {
    const result = buildWatchlist([line({ availableQuantity: 9 })], { "dose:1": 30 }, SETTINGS);

    expect(result[0].reason).toBe("Runs out in about 9 days · selling about 7/week");
  });

  it("says runs out today when less than a day is left", () => {
    // 60 units in 30 days = 2/day, 1 left.
    const result = buildWatchlist([line({ availableQuantity: 1 })], { "dose:1": 60 }, SETTINGS);

    expect(result[0].reason).toBe("Runs out today · selling about 14/week");
  });

  it("mentions stock already on order", () => {
    const result = buildWatchlist(
      [line({ availableQuantity: 9, incomingQuantity: 6 })],
      { "dose:1": 30 },
      SETTINGS,
    );

    expect(result[0].reason).toBe("Runs out in about 9 days · selling about 7/week · 6 on order");
  });

  it("explains a threshold line without pretending to forecast", () => {
    const result = buildWatchlist([line({ availableQuantity: 3, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result[0].reason).toBe(
      "3 units left — at or below your alert level of 5 · no sales in the last 30 days",
    );
  });

  it("distinguishes a threshold line that is merely getting close", () => {
    const result = buildWatchlist([line({ availableQuantity: 8, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result[0].reason).toBe(
      "8 units left — getting close to your alert level of 5 · no sales in the last 30 days",
    );
  });

  it("says one unit rather than 1 units", () => {
    const result = buildWatchlist([line({ availableQuantity: 1, lowStockThreshold: 5 })], {}, SETTINGS);

    expect(result[0].reason).toBe(
      "1 unit left — at or below your alert level of 5 · no sales in the last 30 days",
    );
  });

  it("names an out-of-stock line plainly", () => {
    const result = buildWatchlist([line({ availableQuantity: 0 })], {}, SETTINGS);

    expect(result[0].reason).toBe("Out of stock");
  });

  it("reassures when an out-of-stock line is already on order", () => {
    const result = buildWatchlist([line({ availableQuantity: 0, incomingQuantity: 24 })], {}, SETTINGS);

    expect(result[0].reason).toBe("Out of stock — 24 already on order");
  });
});
