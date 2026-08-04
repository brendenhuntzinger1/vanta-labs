import { describe, expect, it } from "vitest";
import { customerSafeFailureReason, customerSafeMessage, isCustomerSafeMessage } from "@/lib/safe-error";

// Vanta Labs must be the only brand a customer ever sees. Routes echoing
// `error.message` leak vendor names exactly when something breaks — the moment
// a shopper is already unhappy and most likely to read closely.

const FALLBACK = "Something went wrong. Please try again.";

describe("vendor names never reach a customer", () => {
  it("blocks the payment processor by name", () => {
    expect(isCustomerSafeMessage("Veyra checkout script failed to load.")).toBe(false);
    expect(isCustomerSafeMessage("VeyraGate returned 502")).toBe(false);
  });

  it("blocks the fulfilment partner and supplier by name", () => {
    expect(isCustomerSafeMessage("Evo Labs rejected the order")).toBe(false);
    expect(isCustomerSafeMessage("evolabsresearch order failed")).toBe(false);
    expect(isCustomerSafeMessage("Arcline API error (422)")).toBe(false);
  });

  it("blocks infrastructure vendors", () => {
    expect(isCustomerSafeMessage("Supabase connection lost")).toBe(false);
    expect(isCustomerSafeMessage("SMTP auth failed")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCustomerSafeMessage("VEYRA IS DOWN")).toBe(false);
    expect(isCustomerSafeMessage("ArClInE timeout")).toBe(false);
  });
});

describe("technical detail never reaches a customer", () => {
  it("blocks hostnames and URLs", () => {
    expect(isCustomerSafeMessage("getaddrinfo ENOTFOUND veyragate.com")).toBe(false);
    expect(isCustomerSafeMessage("Request to https://api.example.com failed")).toBe(false);
    expect(isCustomerSafeMessage("could not reach evolabsresearch.co")).toBe(false);
  });

  it("blocks socket and DNS errors", () => {
    expect(isCustomerSafeMessage("connect ECONNREFUSED 10.0.0.1")).toBe(false);
    expect(isCustomerSafeMessage("fetch failed")).toBe(false);
    expect(isCustomerSafeMessage("socket hang up")).toBe(false);
  });

  it("blocks database internals", () => {
    expect(isCustomerSafeMessage('null value in column "customer_email" of relation "orders"')).toBe(false);
    expect(isCustomerSafeMessage("select * from orders where id = 1")).toBe(false);
  });

  it("blocks UUIDs and credential words", () => {
    expect(isCustomerSafeMessage("Order 46beeab4-46d5-49ec-b264-824567203ef9 not found")).toBe(false);
    expect(isCustomerSafeMessage("Invalid api_key supplied")).toBe(false);
    expect(isCustomerSafeMessage("Bearer token rejected")).toBe(false);
  });

  it("blocks stack traces and overlong dumps", () => {
    expect(isCustomerSafeMessage("TypeError: x is not a function\n    at handler (/app/x.js:1:1)")).toBe(false);
    expect(isCustomerSafeMessage("e".repeat(250))).toBe(false);
  });

  it("blocks an empty or whitespace message", () => {
    expect(isCustomerSafeMessage("")).toBe(false);
    expect(isCustomerSafeMessage("   ")).toBe(false);
  });
});

describe("genuinely helpful messages still get through", () => {
  it("keeps validation feedback the shopper can act on", () => {
    expect(isCustomerSafeMessage("Invalid email address")).toBe(true);
    expect(isCustomerSafeMessage("Incomplete customer details")).toBe(true);
    expect(isCustomerSafeMessage("We only ship to the US and Canada.")).toBe(true);
  });

  it("keeps store-state messages", () => {
    expect(isCustomerSafeMessage("This item is out of stock.")).toBe(true);
    expect(isCustomerSafeMessage("This coupon has expired.")).toBe(true);
    expect(isCustomerSafeMessage("Checkout isn't open yet — contact support to activate your membership.")).toBe(true);
  });
});

describe("customerSafeMessage", () => {
  it("passes a safe message through", () => {
    expect(customerSafeMessage(new Error("Invalid email address"), FALLBACK)).toBe("Invalid email address");
  });

  it("substitutes the fallback for a leaky one", () => {
    expect(customerSafeMessage(new Error("getaddrinfo ENOTFOUND veyragate.com"), FALLBACK)).toBe(FALLBACK);
  });

  it("handles non-Error throws", () => {
    expect(customerSafeMessage("Veyra exploded", FALLBACK)).toBe(FALLBACK);
    expect(customerSafeMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(customerSafeMessage({ weird: true }, FALLBACK)).toBe(FALLBACK);
  });
});

describe("customerSafeFailureReason — billing history must not leak", () => {
  // Both of these were rendered VERBATIM in a customer's billing history.
  const PROCESSOR_JSON = '{"type":"invalid_request_error","code":"payment_unavailable","message":"We couldn\'t process your card. Please try a different card.","decline_code":"generic_decline","request_id":"req_0JetRM3XaYXkNEB6VrF7jD3X"}';
  const INTERNAL_OPS = "No billing processor configured. Set BILLING_PROVIDER and the matching credentials once one is connected.";

  it("extracts the cardholder message from a processor JSON envelope", () => {
    const shown = customerSafeFailureReason(PROCESSOR_JSON);
    expect(shown).toBe("We couldn't process your card. Please try a different card.");
  });

  it("drops request_id, decline_code and the raw envelope", () => {
    const shown = customerSafeFailureReason(PROCESSOR_JSON) ?? "";
    expect(shown).not.toContain("req_0JetRM3XaYXkNEB6VrF7jD3X");
    expect(shown).not.toContain("decline_code");
    expect(shown).not.toContain("invalid_request_error");
    expect(shown).not.toContain("{");
  });

  it("never tells a customer to configure an environment variable", () => {
    const shown = customerSafeFailureReason(INTERNAL_OPS) ?? "";
    expect(shown).not.toContain("BILLING_PROVIDER");
    expect(shown).toBe("The card was declined.");
  });

  it("blocks any SCREAMING_SNAKE env var name", () => {
    expect(isCustomerSafeMessage("Set VEYRA_SECRET_KEY to continue")).toBe(false);
    expect(isCustomerSafeMessage("NEXT_PUBLIC_SITE_URL is missing")).toBe(false);
  });

  it("falls back to plain wording for an unparseable blob", () => {
    expect(customerSafeFailureReason('{"broken json')).toBe("The card was declined.");
  });

  it("keeps a plain cardholder-facing reason as written", () => {
    expect(customerSafeFailureReason("Your card was declined.")).toBe("Your card was declined.");
    expect(customerSafeFailureReason("Insufficient funds.")).toBe("Insufficient funds.");
  });

  it("returns null for no reason at all, so nothing is appended", () => {
    expect(customerSafeFailureReason(null)).toBeNull();
    expect(customerSafeFailureReason("")).toBeNull();
    expect(customerSafeFailureReason("   ")).toBeNull();
  });

  it("does not let a vendor name through inside an envelope message", () => {
    const shown = customerSafeFailureReason('{"message":"Veyra rejected this card"}');
    expect(shown).toBe("The card was declined.");
  });
});
