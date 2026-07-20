import { describe, expect, it } from "vitest";
import {
  calculateCardProcessingFee,
  cardProcessingFeeNotice,
  getEnabledPaymentMethods,
  getPaymentMethodById,
  isManualPaymentMethod,
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_CARD_PROCESSING_FEE,
  type CardProcessingFeeConfig,
} from "@/lib/payment-methods";

const fee = (over: Partial<CardProcessingFeeConfig> = {}): CardProcessingFeeConfig => ({
  ...DEFAULT_CARD_PROCESSING_FEE,
  ...over,
});

describe("payment methods", () => {
  it("adds a 5% card processing fee by default", () => {
    // Matches the checkout example: $250 subtotal → +$12.50 fee.
    expect(calculateCardProcessingFee(250, fee())).toEqual({ amount: 12.5, percentage: 5 });
  });

  it("rounds the fee to cents", () => {
    expect(calculateCardProcessingFee(19.99, fee({ percentage: 5 })).amount).toBe(1);
  });

  it("charges no fee when disabled", () => {
    expect(calculateCardProcessingFee(250, fee({ enabled: false })).amount).toBe(0);
  });

  it("charges no fee on a zero or negative total", () => {
    expect(calculateCardProcessingFee(0, fee()).amount).toBe(0);
    expect(calculateCardProcessingFee(-10, fee()).amount).toBe(0);
  });

  it("supports a configurable percentage", () => {
    expect(calculateCardProcessingFee(100, fee({ percentage: 3 })).amount).toBe(3);
  });

  it("builds a default notice from the configured percentage", () => {
    expect(cardProcessingFeeNotice(fee({ percentage: 7 }))).toContain("7%");
  });

  it("prefers a custom notice when provided", () => {
    expect(cardProcessingFeeNotice(fee({ noticeText: "Custom copy" }))).toBe("Custom copy");
  });

  it("recognises manual methods and excludes card", () => {
    const card = getPaymentMethodById(DEFAULT_PAYMENT_METHODS, "card");
    const cashapp = getPaymentMethodById(DEFAULT_PAYMENT_METHODS, "cashapp");
    expect(isManualPaymentMethod(card)).toBe(false);
    expect(isManualPaymentMethod(cashapp)).toBe(true);
  });

  it("lists enabled methods with recommended (no-fee) ones first", () => {
    const enabled = getEnabledPaymentMethods(DEFAULT_PAYMENT_METHODS);
    expect(enabled[0].recommended).toBe(true);
    expect(enabled[0].id).toBe("cashapp");
    // Card is offered but ordered last (secondary).
    expect(enabled[enabled.length - 1].id).toBe("card");
    // Disabled example methods (venmo) are excluded.
    expect(enabled.some((m) => m.id === "venmo")).toBe(false);
  });
});
