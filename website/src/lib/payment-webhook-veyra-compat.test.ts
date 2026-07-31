import { describe, it, expect } from "vitest";
import { resolveWebhookOrderId } from "@/lib/payment-webhook";

// VeyraGate and the internal/mock gateway describe the same event differently.
// LivePaymentProvider already opens sessions with `metadata: { order_id }` — its
// own comment says the value "round-trips to the webhook at data.metadata.order_id"
// — but the webhook side only ever read a flat top-level `orderId`. So a real card
// payment would settle nothing: the id resolves to undefined, falls through to a
// random `order-<uuid>`, matches no order, and the customer is charged while their
// order stays unpaid. These pin every shape a real sender actually uses.
describe("resolveWebhookOrderId", () => {
  it("reads the flat orderId the internal gateway sends", () => {
    expect(resolveWebhookOrderId({ orderId: "ord_123" })).toBe("ord_123");
  });

  it("reads VeyraGate's nested data.metadata.order_id", () => {
    expect(
      resolveWebhookOrderId({ data: { metadata: { order_id: "ord_456" } } }),
    ).toBe("ord_456");
  });

  it("reads the un-nested variant where the charge sits under data.object", () => {
    expect(
      resolveWebhookOrderId({ data: { object: { metadata: { order_id: "ord_789" } } } }),
    ).toBe("ord_789");
  });

  it("prefers the flat id when both are present", () => {
    // The internal gateway is unambiguous about its own field; a nested value
    // should never override it.
    expect(
      resolveWebhookOrderId({ orderId: "flat", data: { metadata: { order_id: "nested" } } }),
    ).toBe("flat");
  });

  it("returns null when no sender supplied one, rather than inventing a value", () => {
    // The caller substitutes a synthetic id so the event is still recorded, but
    // that decision belongs to the caller, not here.
    expect(resolveWebhookOrderId({})).toBeNull();
    expect(resolveWebhookOrderId({ data: {} })).toBeNull();
    expect(resolveWebhookOrderId({ data: { metadata: {} } })).toBeNull();
  });
});
