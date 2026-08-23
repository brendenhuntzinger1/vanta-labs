import { describe, expect, it } from "vitest";
import {
  POINTS_PER_DOLLAR_REDEMPTION,
  calculateEarnedPoints,
  pointsToDollars,
  dollarsToPoints,
} from "@/lib/points-math";

// ---------------------------------------------------------------------------
// POINTS ARE STORE CREDIT, SO THIS IS MONEY MATH.
//
// 100 points = $1. Every point awarded is a liability the store settles later,
// and every point redeemed is revenue given up. Both directions have to be
// exact, and the rounding has to favour the store on the way in (floor) and be
// exact on the way out.
//
// WHY THIS FILE EXISTS
//
// Two sabotages left all 2,794 existing tests green:
//   - rounding earned points UP instead of down (every order awards more
//     credit than it earned)
//   - ignoring the promotional event multiplier entirely (a "2x points
//     weekend" the owner runs silently does nothing)
// ---------------------------------------------------------------------------

describe("earning points", () => {
  it("awards rate x amount at the ordinary multiplier", () => {
    expect(calculateEarnedPoints(200, 1, 1)).toBe(200);
  });

  it("applies a promotional multiplier", () => {
    // A 2x points weekend has to actually double them.
    expect(calculateEarnedPoints(200, 1, 2)).toBe(400);
    expect(calculateEarnedPoints(200, 1, 3)).toBe(600);
  });

  it("applies a non-integer multiplier", () => {
    expect(calculateEarnedPoints(200, 1, 1.5)).toBe(300);
  });

  it("applies a points-per-dollar rate above 1", () => {
    expect(calculateEarnedPoints(200, 2, 1)).toBe(400);
  });

  it("combines rate and multiplier", () => {
    expect(calculateEarnedPoints(100, 2, 1.5)).toBe(300);
  });

  describe("rounds DOWN, never up", () => {
    // Rounding up hands out credit that was not earned, on every single order.
    it("floors a fractional award", () => {
      expect(calculateEarnedPoints(10.9, 1, 1)).toBe(10);
    });

    it("floors an award just below the next point", () => {
      expect(calculateEarnedPoints(99.99, 1, 1)).toBe(99);
    });

    it("floors an award produced by the multiplier", () => {
      expect(calculateEarnedPoints(10, 1, 1.05)).toBe(10);
      expect(calculateEarnedPoints(33.4, 1, 1.5)).toBe(50);
    });

    it("awards nothing below one whole point", () => {
      expect(calculateEarnedPoints(0.99, 1, 1)).toBe(0);
    });
  });

  describe("never awards a negative balance", () => {
    for (const [amount, rate, multiplier] of [
      [-100, 1, 1],
      [100, -1, 1],
      [100, 1, -1],
      [-100, -1, -1],
    ] as const) {
      it(`clamps (${amount}, ${rate}, ${multiplier}) to zero`, () => {
        expect(calculateEarnedPoints(amount, rate, multiplier)).toBe(0);
      });
    }

    it("awards zero for a zero-value order", () => {
      expect(calculateEarnedPoints(0, 1, 1)).toBe(0);
    });
  });
});

describe("the redemption rate", () => {
  it("is 100 points to the dollar", () => {
    // Pinned deliberately: changing this silently re-prices every balance
    // customers have already accrued.
    expect(POINTS_PER_DOLLAR_REDEMPTION).toBe(100);
  });

  it("converts points to dollars at that rate", () => {
    expect(pointsToDollars(100)).toBe(1);
    expect(pointsToDollars(2500)).toBe(25);
    expect(pointsToDollars(0)).toBe(0);
  });

  it("converts dollars to points at that rate", () => {
    expect(dollarsToPoints(1)).toBe(100);
    expect(dollarsToPoints(25)).toBe(2500);
    expect(dollarsToPoints(0)).toBe(0);
  });

  it("gives an exact cent for a partial balance", () => {
    expect(pointsToDollars(150)).toBe(1.5);
    expect(pointsToDollars(1)).toBe(0.01);
    expect(pointsToDollars(33)).toBe(0.33);
  });

  it("returns an exact cent for every balance, including awkward ones", () => {
    // Checked across the range rather than at one lucky value. Note that the
    // Math.round in pointsToDollars is defensive rather than load-bearing:
    // for an INTEGER point balance, n / 100 is already the exact nearest
    // double, so removing the rounding changes no result here. Multiplying
    // the dollars BACK by 100 is what drifts (7 -> 0.07 -> 7.000000000000001),
    // which is a hazard for CALLERS, and why nothing downstream should
    // reconstruct points from dollars.
    for (const points of [1, 7, 33, 99, 150, 1105, 9999]) {
      const dollars = pointsToDollars(points);
      expect(dollars).toBe(Math.round(points) / 100);
      expect(Number(dollars.toFixed(2))).toBe(dollars);
    }
  });

  it("round-trips a whole-dollar amount exactly", () => {
    for (const dollars of [1, 5, 12, 99, 250]) {
      expect(pointsToDollars(dollarsToPoints(dollars))).toBe(dollars);
    }
  });

  it("floors a fractional dollar conversion rather than rounding up", () => {
    expect(dollarsToPoints(1.009)).toBe(100);
  });

  it("never converts a negative amount into points", () => {
    expect(dollarsToPoints(-5)).toBe(0);
  });
});
