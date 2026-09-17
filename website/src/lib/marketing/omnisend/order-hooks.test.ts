import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { omnisendEventId, type OmnisendOrder } from "@/lib/marketing/omnisend/events";

/**
 * WHAT A REFUSED ORDER EVENT DOES TO ITS LEDGER CLAIM.
 *
 * `order fulfilled`, `order canceled` and `order refunded` are each fired
 * once, from the shipping notice, the cancel writer and the admin refund.
 * Only paid-order claims are ever released by the backstop sweep, so a
 * refused send of one of these used to be final: the claim stayed, recorded
 * undelivered, and nothing ever asked again. That is right for a refusal that
 * will recur (a 4xx is the request's own fault) and wrong for one that may
 * not (a transport failure, a rate limit, a gateway error), where the claim
 * has to go back so a later legitimate notice or the backstop can retry.
 *
 * The transport, the ledger and the database are replaced here; the event
 * builder is real, so the event that is sent is the one the store sends.
 */

const sendOmnisendEvent = vi.fn();
const claimSend = vi.fn(async () => true);
const recordSend = vi.fn(async () => {});
const releaseSend = vi.fn(async () => {});

vi.mock("@/lib/marketing/omnisend/client", () => ({
  omnisendActive: () => ({ active: true, reason: null }),
}));
vi.mock("@/lib/marketing/omnisend/ledger", () => ({
  omnisendLedger: () => ({ claimSend, claimSendWithin: claimSend, recordSend, releaseSend }),
}));
vi.mock("@/lib/marketing/omnisend/events", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/marketing/omnisend/events")>();
  return { ...actual, sendOmnisendEvent: (...args: unknown[]) => sendOmnisendEvent(...args) };
});
// The order is passed in, so nothing here may touch the database. A Proxy
// that throws on any access makes that a failure rather than a silent read.
vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("the database was touched");
      },
    },
  ),
}));

const order: OmnisendOrder = {
  orderId: "order-9",
  orderNumber: "VL-9",
  orderType: "product",
  replacementOf: null,
  email: "jo@example.com",
  customerName: "Jo Smith",
  currency: "USD",
  amountPaid: 100,
  subtotal: 100,
  shipping: 0,
  discount: 0,
  tax: 0,
  createdAt: "2026-09-14T11:00:00.000Z",
  paidAt: "2026-09-14T11:05:00.000Z",
  shippedAt: "2026-09-15T09:00:00.000Z",
  lineItems: [{ productID: "bpc-157", productTitle: "BPC-157", productPrice: 100, productQuantity: 1, productURL: "https://x/p/bpc-157" }],
  siteOrigin: "https://www.vantalabsresearch.com",
};

async function send(name: "order fulfilled" | "order canceled" | "order refunded" = "order fulfilled") {
  const { sendOrderEventOnce } = await import("@/lib/marketing/omnisend/order-hooks");
  await sendOrderEventOnce(order.orderId, name, order);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("a delivered order event", () => {
  it("records the claim delivered and keeps it", async () => {
    sendOmnisendEvent.mockResolvedValueOnce({ ok: true, status: 200, error: null });
    await send();
    expect(claimSend).toHaveBeenCalledWith("order fulfilled", omnisendEventId("order-9:order fulfilled"));
    expect(recordSend).toHaveBeenCalledWith("order fulfilled", omnisendEventId("order-9:order fulfilled"), true, null);
    expect(releaseSend).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("a transiently refused order event hands its claim back", () => {
  it.each([0, 429, 500, 502, 503, 504])("status %i: logs, releases the claim, records nothing", async (status) => {
    sendOmnisendEvent.mockResolvedValueOnce({ ok: false, status, error: `omnisend ${status}` });
    await send();
    expect(releaseSend).toHaveBeenCalledWith("order fulfilled");
    expect(recordSend).not.toHaveBeenCalled();
    // Logged before it is released, under the module prefix, with the status.
    expect(errorSpy).toHaveBeenCalledWith("[omnisend/orders]", "order fulfilled", "refused", "order-9", expect.objectContaining({ status }));
    expect(errorSpy.mock.invocationCallOrder[0]).toBeLessThan(releaseSend.mock.invocationCallOrder[0]);
  });

  it("does the same for a cancel and a refund", async () => {
    sendOmnisendEvent.mockResolvedValue({ ok: false, status: 503, error: "omnisend 503" });
    await send("order canceled");
    await send("order refunded");
    expect(releaseSend.mock.calls).toEqual([["order canceled"], ["order refunded"]]);
    expect(recordSend).not.toHaveBeenCalled();
  });
});

describe("a permanently refused order event keeps its claim, recorded undelivered", () => {
  it.each([400, 401, 403, 404, 422])("status %i: records delivered=false with the error and does not release", async (status) => {
    sendOmnisendEvent.mockResolvedValueOnce({ ok: false, status, error: `omnisend ${status}` });
    await send();
    expect(recordSend).toHaveBeenCalledWith("order fulfilled", omnisendEventId("order-9:order fulfilled"), false, `omnisend ${status}`);
    expect(releaseSend).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[omnisend/orders]", "order fulfilled", "refused", "order-9", expect.objectContaining({ status }));
  });
});

describe("the claim is the gate", () => {
  it("sends nothing when the claim is already held", async () => {
    claimSend.mockResolvedValueOnce(false);
    await send();
    expect(sendOmnisendEvent).not.toHaveBeenCalled();
    expect(recordSend).not.toHaveBeenCalled();
    expect(releaseSend).not.toHaveBeenCalled();
  });

  it("a send that throws releases the claim and never reaches the caller", async () => {
    sendOmnisendEvent.mockRejectedValueOnce(new Error("boom"));
    await expect(send()).resolves.toBeUndefined();
    expect(releaseSend).toHaveBeenCalledWith("order fulfilled");
    expect(recordSend).not.toHaveBeenCalled();
  });
});
