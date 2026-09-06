import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A RETRY AFTER A DEAD FIRST ATTEMPT DEAD-ENDED FOREVER.
//
// createCheckoutSession has TWO idempotency reads and they disagreed. The one
// before the insert deliberately skips canceled/failed orders, so a shopper
// whose first attempt died can try again. The unique index on
// idempotency_key does not share that view — it covers every row — so the
// retry's INSERT collided, and the post-collision read had NO status filter and
// handed the DEAD order straight back:
//
//     { success: true, orderId: <the cancelled one>,
//       status: "pending_payment", hostedCheckoutUrl: "" }
//
// checkout/page.tsx reads an empty URL as "we couldn't reach the payment
// provider, please try again", and KEEPS the same idempotency key on purpose so
// a retry can resume — so every further click reproduced it exactly and the
// shopper could not reach a card form again without a full page reload.
//
// Reproduced against the harness before the fix; the sequence below is that
// reproduction. Two further costs came with it: the duplicate branch returned
// BEFORE releasing the promotion claim and the one-time gift reservation this
// attempt had just taken, so a limited offer leaked a slot on every retry.
// ---------------------------------------------------------------------------

const providerCreateCheckoutSession = vi.fn();
const releasePromotionRedemption = vi.fn(async () => {});
const releaseCustomerOffer = vi.fn(async () => {});

/** Rows keyed by order_id, plus the unique index on idempotency_key. */
const orders = new Map<string, Record<string, unknown>>();
const keyIndex = new Map<string, string>();

vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());

vi.mock("@/lib/inventory-reservation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-reservation")>();
  return {
    ...actual,
    reserveInventoryForOrder: vi.fn(async () => ({ ok: true as const, reserved: 1, degraded: false })),
    releaseInventoryForOrder: vi.fn(async () => {}),
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

vi.mock("@/lib/offers/customer-offers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/offers/customer-offers")>();
  return { ...actual, releaseCustomerOffer };
});

vi.mock("@/lib/bxgy-promotions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bxgy-promotions")>();
  return { ...actual, releasePromotionRedemption };
});

vi.mock("@/lib/supabase-server", () => {
  const table = (name: string) => {
    const filters: Record<string, unknown> = {};
    const notFilters: Array<[string, string]> = [];

    const matches = (row: Record<string, unknown>) => {
      for (const [col, value] of Object.entries(filters)) {
        if (String(row[col] ?? "") !== String(value)) return false;
      }
      for (const [col, list] of notFilters) {
        const values = list.replace(/[()]/g, "").split(",").map((v) => v.trim());
        if (values.includes(String(row[col] ?? ""))) return false;
      }
      return true;
    };

    return {
      insert: (payload: unknown) => {
        const rows = (Array.isArray(payload) ? payload : [payload]) as Record<string, unknown>[];
        let error: { code?: string; message?: string } | null = null;
        if (name === "orders") {
          for (const row of rows) {
            const key = row.idempotency_key ? String(row.idempotency_key) : null;
            // The real unique index: partial on NOT NULL, covering every status.
            if (key && keyIndex.has(key)) {
              error = { code: "23505", message: `duplicate key value violates unique constraint "orders_idempotency_key_uniq"` };
              break;
            }
          }
          if (!error) {
            for (const row of rows) {
              orders.set(String(row.order_id), { ...row });
              if (row.idempotency_key) keyIndex.set(String(row.idempotency_key), String(row.order_id));
            }
          }
        }
        const result = { data: error ? null : rows, error };
        return {
          ...result,
          select: () => ({ ...result, single: async () => ({ data: rows[0], error }) }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
        };
      },
      update: (payload: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {
          eq: (col: string, value: unknown) => { filters[col] = value; return chain; },
          neq: () => chain,
          then: (resolve: (v: unknown) => unknown) => {
            for (const [id, row] of orders) if (matches(row)) orders.set(id, { ...row, ...payload });
            return Promise.resolve({ data: null, error: null }).then(resolve);
          },
        };
        return chain;
      },
      select: () => {
        const chain: Record<string, unknown> = {
          eq: (col: string, value: unknown) => { filters[col] = value; return chain; },
          is: () => chain,
          not: (col: string, _op: string, list: string) => { notFilters.push([col, list]); return chain; },
          in: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => {
            if (name !== "orders") return { data: null, error: null };
            const found = [...orders.values()].find(matches) ?? null;
            return { data: found, error: null };
          },
          single: async () => ({ data: null, error: null }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return chain;
      },
    };
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
  email: "retry@example.com",
  fullName: "Alex Morgan",
  address: "88 Meridian Avenue",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "United States",
};

const IDEM = "the-same-submit";
const buy = async () => {
  const { createCheckoutSession } = await import("@/lib/payment-service");
  return createCheckoutSession({
    items: [{ id: "bpc-157-10mg", quantity: 1 }],
    customer,
    idempotencyKey: IDEM,
  });
};

describe("a shopper whose first checkout attempt died can still buy", () => {
  beforeEach(() => {
    orders.clear();
    keyIndex.clear();
    providerCreateCheckoutSession.mockReset();
    releasePromotionRedemption.mockClear();
    releaseCustomerOffer.mockClear();
    let n = 0;
    providerCreateCheckoutSession.mockImplementation(async () => {
      n += 1;
      return { paymentId: `pay_${n}`, hostedCheckoutUrl: `https://pay.example/${n}` };
    });
  });

  it("the retry creates a LIVE order with a usable card session", async () => {
    const first = await buy();
    expect(first.orderId).toBeTruthy();

    // Exactly what payment-service does when the provider throws.
    orders.set(first.orderId, { ...orders.get(first.orderId)!, payment_status: "canceled" });

    const retry = await buy();
    expect(retry.orderId, "the cancelled order must not be handed back").not.toBe(first.orderId);
    expect(retry.hostedCheckoutUrl, "an empty URL reads to the page as a provider outage").toBeTruthy();
    expect(String(orders.get(retry.orderId)?.payment_status)).toBe("pending_payment");
  });

  it("repeating the retry is idempotent AND still usable", async () => {
    const first = await buy();
    orders.set(first.orderId, { ...orders.get(first.orderId)!, payment_status: "canceled" });
    const retry = await buy();
    const again = await buy();

    expect(again.orderId, "a double-click on the retry must not open a third order").toBe(retry.orderId);
    expect(again.hostedCheckoutUrl, "and must still reach a card form").toBeTruthy();
    expect(orders.size, "exactly two orders exist: the dead one and the live one").toBe(2);
  });

  it("a genuine duplicate submit against a LIVE order still returns that order", async () => {
    const first = await buy();
    const duplicate = await buy();
    expect(duplicate.orderId).toBe(first.orderId);
    expect(duplicate.hostedCheckoutUrl).toBeTruthy();
    expect(orders.size, "no second order for the same live submit").toBe(1);
  });

  it("never resurrects a dead order as pending_payment", async () => {
    const first = await buy();
    orders.set(first.orderId, { ...orders.get(first.orderId)!, payment_status: "payment_failed" });
    const retry = await buy();
    expect(retry.orderId).not.toBe(first.orderId);
    expect(String(orders.get(first.orderId)?.payment_status)).toBe("payment_failed");
  });
});
