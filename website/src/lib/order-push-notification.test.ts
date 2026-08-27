import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOrderPushPayload, type OrderPushInput } from "./order-push-notification";

// ---------------------------------------------------------------------------
// The order push notification — the operator's phone alert for a paid order.
//
// Two properties are worth testing and one is not. The message STRING is worth
// it: it is the entire product from the operator's point of view, it is
// assembled from six optional parts, and a wrong one is read at 2am and acted
// on. The SEND is worth it for one reason only — it must never, under any
// failure, disturb an order that has already been paid for. The HTTP shape
// (Zapier's field names) is contract, not behaviour, and is asserted once.
// ---------------------------------------------------------------------------

const base: OrderPushInput = {
  orderId: "ord_a1b2c3d4",
  orderNumber: "VL-1042",
  customerName: "Jordan Mitchell",
  total: 89,
  profit: 41.2,
  profitStatus: "estimated",
  itemCount: 3,
  placedAt: "2026-08-26T18:42:11.000Z",
  siteUrl: "https://vantalabs.com",
};

const message = (over: Partial<OrderPushInput> = {}) => buildOrderPushPayload({ ...base, ...over }).message;

describe("the notification message", () => {
  it("reads as one line an operator can act on without opening anything", () => {
    expect(message()).toBe("Order VL-1042 — Jordan M. — $89.00 — profit $41.20 (est.)");
  });

  it("marks an estimated profit so it is never mistaken for the settled figure", () => {
    // Profit is estimated until the real postage lands. Dropping "(est.)" would
    // let a number that moves later be read as final.
    expect(message({ profitStatus: "estimated" })).toContain("profit $41.20 (est.)");
    expect(message({ profitStatus: "finalized" })).toContain("profit $41.20");
    expect(message({ profitStatus: "finalized" })).not.toContain("(est.)");
  });

  it("shows a loss as a loss rather than a smaller win", () => {
    expect(message({ profit: -12.3, profitStatus: "finalized" })).toContain("profit -$12.30");
  });

  it("keeps going when profit could not be computed", () => {
    // A missing profit must not cost the operator the notification itself —
    // knowing an order came in matters more than knowing what it earned.
    const payload = buildOrderPushPayload({ ...base, profit: null, profitStatus: null });
    expect(payload.message).toBe("Order VL-1042 — Jordan M. — $89.00");
    expect(payload.profit).toBe("");
    expect(payload.profit_status).toBe("");
  });
});

describe("how much of the customer is sent to Zapier and Pushover", () => {
  it("reduces the surname to an initial", () => {
    // Zapier task history and the Pushover message log are two third-party
    // stores outside our control. The order number is the real key; the name is
    // only there so the operator recognises the order at a glance.
    expect(buildOrderPushPayload(base).customer).toBe("Jordan M.");
  });

  it("takes the initial from the last name, not the middle one", () => {
    expect(buildOrderPushPayload({ ...base, customerName: "Jordan Lee Mitchell" }).customer).toBe("Jordan M.");
  });

  it("leaves a single-word name alone rather than inventing an initial", () => {
    expect(buildOrderPushPayload({ ...base, customerName: "Jordan" }).customer).toBe("Jordan");
  });

  it("does not mangle a name it does not understand", () => {
    // No title-casing, no reordering. Whatever the customer typed is what they
    // are called; the only edit is dropping the surname.
    expect(buildOrderPushPayload({ ...base, customerName: "  o'brien  MCDONALD " }).customer).toBe("o'brien M.");
  });

  it("omits the customer entirely when there is no name", () => {
    for (const customerName of [null, "", "   "]) {
      const payload = buildOrderPushPayload({ ...base, customerName });
      expect(payload.customer).toBe("");
      expect(payload.message).toBe("Order VL-1042 — $89.00 — profit $41.20 (est.)");
    }
  });

  it("never sends the email address or the shipping address", () => {
    // Enforced by the input type having nowhere to put them. This asserts the
    // absence at the payload boundary so a later "just add the email" is a
    // deliberate decision and not an accident.
    const keys = Object.keys(buildOrderPushPayload(base));
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("address");
    expect(JSON.stringify(buildOrderPushPayload(base))).not.toMatch(/@/);
  });
});

describe("the field contract Zapier maps against", () => {
  it("sends the agreed fields, with money as plain numbers", () => {
    // total/profit carry no currency symbol so a Zap can filter on them
    // numerically ("only alert above $200"). The symbols live in `message`.
    expect(buildOrderPushPayload(base)).toEqual({
      event: "new_order",
      title: "New Order",
      message: "Order VL-1042 — Jordan M. — $89.00 — profit $41.20 (est.)",
      order_number: "VL-1042",
      order_id: "ord_a1b2c3d4",
      customer: "Jordan M.",
      total: "89.00",
      profit: "41.20",
      profit_status: "estimated",
      item_count: "3",
      url: "https://vantalabs.com/admin/orders/ord_a1b2c3d4",
      placed_at: "2026-08-26T18:42:11.000Z",
    });
  });

  it("falls back to the order id when the order has no number yet", () => {
    const payload = buildOrderPushPayload({ ...base, orderNumber: null });
    expect(payload.order_number).toBe("");
    expect(payload.message).toBe("Order ord_a1b2c3d4 — Jordan M. — $89.00 — profit $41.20 (est.)");
  });

  it("sends an empty link rather than a broken one when the site url is unset", () => {
    // A preview deploy with no NEXT_PUBLIC_SITE_URL would otherwise produce
    // "undefined/admin/orders/..." as the notification's tap target.
    expect(buildOrderPushPayload({ ...base, siteUrl: null }).url).toBe("");
    expect(buildOrderPushPayload({ ...base, siteUrl: "https://vantalabs.com/" }).url).toBe(
      "https://vantalabs.com/admin/orders/ord_a1b2c3d4",
    );
  });
});

// ---------------------------------------------------------------------------
// The send path. Mocked in this suite and nowhere globally: the real Supabase
// client and the real profit engine have their own coverage, and what is under
// test here is what this module does when they, or the network, misbehave.
// ---------------------------------------------------------------------------

const orderRow = {
  order_id: "ord_a1b2c3d4",
  order_number: "VL-1042",
  customer_name: "Jordan Mitchell",
  amount_paid: 89,
  paid_at: "2026-08-26T18:42:11.000Z",
};

let dbOrder: typeof orderRow | null = orderRow;

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "order_items"
            ? Promise.resolve({ data: [{ quantity: 2 }, { quantity: 1 }], error: null })
            : { maybeSingle: () => Promise.resolve({ data: dbOrder, error: null }) },
      }),
    }),
  },
}));

let profitResult: Promise<unknown> = Promise.resolve({ profit: 41.2, profitStatus: "estimated" });
vi.mock("@/lib/admin-profit", () => ({ getOrderProfit: () => profitResult }));

const alerts: Array<{ type: string; severity: string }> = [];
vi.mock("@/lib/monitoring", () => ({
  recordSystemAlert: async (input: { type: string; severity: string }) => {
    alerts.push(input);
  },
}));

const { sendOrderPushNotification } = await import("./order-push-notification");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "https://hooks.example.com/catch/1/abc");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://vantalabs.com");
  dbOrder = orderRow;
  profitResult = Promise.resolve({ profit: 41.2, profitStatus: "estimated" });
  alerts.length = 0;
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sending", () => {
  it("posts the payload as JSON to the configured webhook", async () => {
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({ sent: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/catch/1/abc");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toMatchObject({
      event: "new_order",
      message: "Order VL-1042 — Jordan M. — $89.00 — profit $41.20 (est.)",
      item_count: "3",
      url: "https://vantalabs.com/admin/orders/ord_a1b2c3d4",
    });
  });

  it("gives the request a deadline", async () => {
    // Without one, a hung webhook holds the function open until the platform
    // kills it. Asserted here as well as in third-party-timeouts.test.ts
    // because this one observes the actual call rather than the source text.
    await sendOrderPushNotification("ord_a1b2c3d4");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("does nothing at all — not even a log line — when no webhook is configured", async () => {
    for (const value of ["", "   "]) {
      vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", value);
      await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({
        sent: false,
        reason: "not_configured",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });

  it("refuses to send over http rather than putting the URL on the wire in the clear", async () => {
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "http://hooks.example.com/catch/1/abc");
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({
      sent: false,
      reason: "insecure_url",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alerts[0]).toMatchObject({ type: "order_push_misconfigured", severity: "warning" });
  });
});

describe("what happens when things break", () => {
  // Every case below runs immediately after a customer has been charged and the
  // stock has moved. None of them may throw, because the caller is in the
  // middle of a paid order's side effects.

  it("survives a webhook that refuses the request", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 410 });
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({
      sent: false,
      reason: "delivery_failed",
      detail: "webhook answered 410",
    });
    expect(alerts[0]).toMatchObject({ type: "order_push_failed", severity: "warning" });
  });

  it("survives a webhook that never answers", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const result = await sendOrderPushNotification("ord_a1b2c3d4");
    expect(result).toMatchObject({ sent: false, reason: "delivery_failed" });
  });

  it("survives DNS and TLS failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toMatchObject({ reason: "delivery_failed" });
  });

  it("survives the profit engine failing, and still tells the operator about the order", async () => {
    profitResult = Promise.reject(new Error("profit settings unavailable"));
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toEqual({ sent: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      message: "Order VL-1042 — Jordan M. — $89.00",
      profit: "",
    });
  });

  it("sends nothing when the order cannot be found", async () => {
    dbOrder = null;
    await expect(sendOrderPushNotification("ord_missing")).resolves.toEqual({
      sent: false,
      reason: "order_not_found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never rejects, whatever the alerting path does", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(sendOrderPushNotification("ord_a1b2c3d4")).resolves.toBeTruthy();
  });
});
