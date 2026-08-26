import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// G-03 — a checkout that dies at the payment provider must not leave an order
// behind, and must not keep holding the stock.
//
// REPRODUCED IN THE BROWSER, not reasoned about. A real purchase was driven
// through a production build with the provider host unreachable. The order row
// was written, the items were written, stock was reserved, and only then did
// `provider.createCheckoutSession` throw ECONNREFUSED. The route's catch
// answered the customer with:
//
//   "No charge was made and no order was placed — please try again in a moment."
//
// while `orders` held a live `pending_payment` row and `inventory_reservations`
// held a 15-minute hold on the stock. The message is false, and the hold is
// real.
//
// Three consequences, in order of how much they cost:
//
//   1. Denial of inventory. The customer is invited to "try again in a moment",
//      and each attempt takes another 15-minute hold on the same units. A
//      provider outage therefore drains sellable stock at the rate customers
//      retry, and the last units of a scarce dose can be locked out of the
//      catalogue by shoppers who were never able to buy them.
//   2. Orphan orders. Every failure leaves a pending_payment row that no
//      webhook will ever settle. It sits in reconciliation queries until the
//      reservation sweep expires it, and it inflates the pending-order count
//      the operator uses to judge whether checkout is healthy.
//   3. A false statement to the customer, which is the one an operator finds
//      out about from a support ticket rather than a dashboard.
//
// The fix is not new machinery. The shortfall branch immediately above the
// provider call ALREADY does the right thing — cancel the order, then throw.
// The provider call simply had no equivalent. This suite pins that it does.
// ---------------------------------------------------------------------------

const releaseInventoryForOrder = vi.fn(async () => {});
const providerCreateCheckoutSession = vi.fn();

const orders = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());

vi.mock("@/lib/inventory-reservation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-reservation")>();
  return {
    ...actual,
    // The reservation itself succeeds. The whole point of this suite is the
    // window AFTER stock has been held and BEFORE the customer reaches the
    // processor.
    reserveInventoryForOrder: vi.fn(async () => ({ ok: true as const, reserved: 1, degraded: false })),
    releaseInventoryForOrder,
  };
});

vi.mock("@/lib/payment-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-provider")>();
  return {
    ...actual,
    isCheckoutOpen: () => true,
    getPaymentProvider: () => ({
      id: "test",
      createCheckoutSession: providerCreateCheckoutSession,
      verifyWebhookSignature: () => true,
    }),
  };
});

vi.mock("@/lib/supabase-server", () => {
  const table = (name: string) => {
    const filters: Record<string, unknown> = {};
    const client = {
      insert: (payload: unknown) => {
        const rows = Array.isArray(payload) ? payload : [payload];
        if (name === "orders") {
          for (const row of rows) {
            const r = row as Record<string, unknown>;
            orders.set(String(r.order_id), { ...r });
          }
        }
        const result = { data: rows, error: null };
        return {
          ...result,
          select: () => ({ ...result, single: async () => ({ data: rows[0], error: null }) }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
        };
      },
      update: (payload: Record<string, unknown>) => {
        const apply = () => {
          if (name === "orders" && filters.order_id !== undefined) {
            const key = String(filters.order_id);
            orders.set(key, { ...(orders.get(key) ?? { order_id: key }), ...payload });
          }
          return { data: null, error: null };
        };
        const chain: Record<string, unknown> = {
          eq: (col: string, value: unknown) => {
            filters[col] = value;
            return chain;
          },
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(apply()).then(resolve),
        };
        return chain;
      },
      select: () => {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          is: () => chain,
          not: () => chain,
          in: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return chain;
      },
    };
    return client;
  };
  const mockClient = {
    from: (name: string) => table(name),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
      admin: { inviteUserByEmail: async () => ({ data: null, error: null }) },
    },
  };
  return { createServerClient: () => mockClient, supabaseAdmin: mockClient };
});

const customer = {
  email: "client@example.com",
  fullName: "Alex Morgan",
  address: "88 Meridian Avenue",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "United States",
};

const buy = async () => {
  const { createCheckoutSession } = await import("@/lib/payment-service");
  return createCheckoutSession({
    items: [{ id: "bpc-157-10mg", quantity: 1 }],
    customer,
  });
};

const theOrder = () => [...orders.values()].at(-1);

describe("a checkout that fails at the payment provider", () => {
  beforeEach(() => {
    orders.clear();
    releaseInventoryForOrder.mockClear();
    providerCreateCheckoutSession.mockReset();
  });

  it("does not leave the order sitting in pending_payment", async () => {
    // The exact failure observed in the browser: the provider host refuses the
    // connection after the order and its stock hold already exist.
    providerCreateCheckoutSession.mockRejectedValue(
      Object.assign(new Error("fetch failed"), { cause: new Error("connect ECONNREFUSED 127.0.0.1:59999") }),
    );

    await expect(buy()).rejects.toThrow();

    const order = theOrder();
    expect(order, "the order row was written before the provider was called").toBeDefined();
    expect(order?.payment_status).toBe("canceled");
  });

  it("gives the reserved stock back", async () => {
    providerCreateCheckoutSession.mockRejectedValue(new Error("fetch failed"));

    await expect(buy()).rejects.toThrow();

    // Without this the units stay held for the full reservation window, and a
    // customer following the route's own "try again in a moment" advice takes
    // another hold on each attempt.
    expect(releaseInventoryForOrder).toHaveBeenCalledTimes(1);
    expect(releaseInventoryForOrder).toHaveBeenCalledWith(String(theOrder()?.order_id));
  });

  it("still fails the checkout — cleanup is not a way to pretend it worked", async () => {
    // The customer must NOT be handed a session that does not exist. Cleaning
    // up and then returning success would be strictly worse than the bug.
    providerCreateCheckoutSession.mockRejectedValue(new Error("gateway exploded"));
    await expect(buy()).rejects.toThrow();
  });

  it("does not cancel or release when the provider succeeds", async () => {
    // The guard against a fix that fires on the happy path too.
    providerCreateCheckoutSession.mockResolvedValue({
      paymentId: "pay_ok",
      hostedCheckoutUrl: "https://processor.test/session/pay_ok",
    });

    const result = await buy();

    expect(result.hostedCheckoutUrl).toBe("https://processor.test/session/pay_ok");
    expect(releaseInventoryForOrder).not.toHaveBeenCalled();
    expect(theOrder()?.payment_status).not.toBe("canceled");
  });

  it("survives a cleanup that itself fails, and still reports the real cause", async () => {
    // Cleanup is best-effort. If releasing the hold throws, the customer must
    // still get the provider's failure — not a confusing second error from the
    // recovery path, which is how a diagnosable outage becomes an undiagnosable
    // one.
    providerCreateCheckoutSession.mockRejectedValue(new Error("gateway exploded"));
    releaseInventoryForOrder.mockRejectedValueOnce(new Error("release also broken"));

    await expect(buy()).rejects.toThrow("gateway exploded");
  });
});
