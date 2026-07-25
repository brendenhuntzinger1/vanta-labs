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

// The shipped default disables the card fee (the merchant absorbs it), so the
// math tests below force `enabled: true` to exercise the calculation itself.
const fee = (over: Partial<CardProcessingFeeConfig> = {}): CardProcessingFeeConfig => ({
  ...DEFAULT_CARD_PROCESSING_FEE,
  enabled: true,
  ...over,
});

describe("payment methods", () => {
  it("does not charge customers a card processing fee by default", () => {
    // The merchant absorbs card fees — shoppers are never surcharged.
    expect(DEFAULT_CARD_PROCESSING_FEE.enabled).toBe(false);
    expect(calculateCardProcessingFee(250, DEFAULT_CARD_PROCESSING_FEE).amount).toBe(0);
  });

  it("computes a 5% fee when the surcharge is explicitly enabled", () => {
    // $250 subtotal → +$12.50 fee when a surcharge is turned on.
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

  it("builds a default notice from the configured percentage without naming other methods", () => {
    const notice = cardProcessingFeeNotice(fee({ percentage: 7 }));
    expect(notice).toContain("7%");
    for (const removed of ["Cash App", "Zelle", "PayPal", "Venmo"]) {
      expect(notice).not.toContain(removed);
    }
  });

  it("prefers a custom notice when provided", () => {
    expect(cardProcessingFeeNotice(fee({ noticeText: "Custom copy" }))).toBe("Custom copy");
  });

  it("card is not a manual method", () => {
    const card = getPaymentMethodById(DEFAULT_PAYMENT_METHODS, "card");
    expect(isManualPaymentMethod(card)).toBe(false);
  });

  it("offers ONLY the card method — Cash App / Zelle / PayPal / Venmo are gone entirely", () => {
    const enabled = getEnabledPaymentMethods(DEFAULT_PAYMENT_METHODS);
    // Card (debit/credit/Apple Pay) is the only method the site offers.
    expect(enabled.map((m) => m.id)).toEqual(["card"]);
    // The removed peer-to-peer methods must not exist in config at all.
    for (const id of ["cashapp", "zelle", "paypal", "venmo"]) {
      expect(getPaymentMethodById(DEFAULT_PAYMENT_METHODS, id)).toBeUndefined();
    }
  });
});
