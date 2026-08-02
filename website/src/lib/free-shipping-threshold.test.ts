import { describe, expect, it } from "vitest";
import { calculateShipping, DEFAULT_SHIPPING_CONFIG, FREE_SHIPPING_THRESHOLD } from "@/lib/shipping";
import { getShippingProgress } from "@/components/cart-context";

// Locks the free-shipping threshold end to end: the charge itself, the progress
// bar the shopper sees, and the boundary. Everything derives from the exported
// constant, so moving the bar again updates these expectations with it — except
// the one assertion that pins the actual dollar value, which is deliberate: it
// is the tripwire that tells you the business rule changed.

describe("free shipping threshold", () => {
  it("is $200", () => {
    expect(FREE_SHIPPING_THRESHOLD).toBe(200);
    expect(DEFAULT_SHIPPING_CONFIG.freeShippingThreshold).toBe(200);
  });

  describe("shipping charge (US)", () => {
    it("charges the flat rate below the threshold", () => {
      expect(calculateShipping(199.99, "United States")).toBe(DEFAULT_SHIPPING_CONFIG.domesticFee);
      expect(calculateShipping(150, "United States")).toBe(DEFAULT_SHIPPING_CONFIG.domesticFee);
    });

    it("is free AT the threshold and above — no charge sneaks back in", () => {
      expect(calculateShipping(FREE_SHIPPING_THRESHOLD, "United States")).toBe(0);
      expect(calculateShipping(200.01, "United States")).toBe(0);
      expect(calculateShipping(1000, "United States")).toBe(0);
    });
  });

  describe("progress bar", () => {
    it("cart $150 → $50 away", () => {
      const progress = getShippingProgress(150);
      expect(progress.isEligibleForFreeShipping).toBe(false);
      expect(progress.amountToFreeShipping).toBeCloseTo(50, 2);
      expect(progress.progressPercentage).toBeCloseTo(75, 2);
    });

    it("cart $199.99 → $0.01 away", () => {
      const progress = getShippingProgress(199.99);
      expect(progress.isEligibleForFreeShipping).toBe(false);
      expect(progress.amountToFreeShipping).toBeCloseTo(0.01, 2);
    });

    it("cart $200 → unlocked, capped at 100%", () => {
      const progress = getShippingProgress(200);
      expect(progress.isEligibleForFreeShipping).toBe(true);
      expect(progress.amountToFreeShipping).toBe(0);
      expect(progress.progressPercentage).toBe(100);
    });

    it("never reports a negative remainder or over 100% on a large cart", () => {
      const progress = getShippingProgress(5000);
      expect(progress.amountToFreeShipping).toBe(0);
      expect(progress.progressPercentage).toBe(100);
    });

    it("an empty cart is 0% and owes the full threshold", () => {
      const progress = getShippingProgress(0);
      expect(progress.isEligibleForFreeShipping).toBe(false);
      expect(progress.amountToFreeShipping).toBe(FREE_SHIPPING_THRESHOLD);
      expect(progress.progressPercentage).toBe(0);
    });
  });

  it("the admin override still wins over the coded default", () => {
    // A store that configures a different bar in Control Center must be honored
    // by both the charge and the progress bar.
    const custom = { ...DEFAULT_SHIPPING_CONFIG, freeShippingThreshold: 300 };
    expect(calculateShipping(250, "United States", custom)).toBe(custom.domesticFee);
    expect(calculateShipping(300, "United States", custom)).toBe(0);
    expect(getShippingProgress(250, 300).amountToFreeShipping).toBeCloseTo(50, 2);
  });

  it("Canada keeps its own separate threshold — unchanged by the US bar", () => {
    expect(DEFAULT_SHIPPING_CONFIG.northAmericaFreeShippingThreshold).toBe(400);
    expect(calculateShipping(200, "Canada")).toBe(DEFAULT_SHIPPING_CONFIG.northAmericaFee);
    expect(calculateShipping(400, "Canada")).toBe(0);
  });
});
