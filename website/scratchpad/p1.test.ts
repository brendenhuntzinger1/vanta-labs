import { describe, it } from "vitest";
import { pointsToDollars, dollarsToPoints } from "@/lib/points-math";

describe("points floor", () => {
  it("finds dollar values where dollarsToPoints under-counts", () => {
    const bad: Array<[number, number, number]> = [];
    for (let cents = 1; cents <= 20000; cents++) {
      const dollars = cents / 100;               // a rounded 2dp money value
      const pts = dollarsToPoints(dollars);      // Math.floor(dollars * 100)
      if (pts !== cents) bad.push([dollars, cents, pts]);
    }
    console.log("mismatches:", bad.length, "first 20:", JSON.stringify(bad.slice(0, 20)));
  });

  it("round-trip: redeem cap path", () => {
    // pointsDiscountAmount = roundMoney(Math.min(requestedDollars, totalAfterCredit))
    const totalAfterCredit = 8.03;
    const requestedDollars = pointsToDollars(5000); // $50
    const disc = Math.round(Math.min(requestedDollars, totalAfterCredit) * 100) / 100;
    console.log("discount$", disc, "pointsRedeemed", dollarsToPoints(disc), "should be", Math.round(disc*100));
  });
});
