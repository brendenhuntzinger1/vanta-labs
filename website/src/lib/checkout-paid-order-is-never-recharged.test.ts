import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A PAID ORDER MUST NEVER BE HANDED A FRESH CARD FORM.
//
// createCheckoutSession resumes an existing order when the request carries an
// idempotency key it has seen before. That is the right behaviour: it is what
// stops a lost response, a back-navigation or a double tap from creating two
// orders and two inventory holds for one purchase.
//
// But the lookup excluded only canceled / cancelled / payment_failed. A PAID
// order matching the key therefore reached the resume path, which:
//
//   1. called provider.createCheckoutSession() — minting a NEW, CHARGEABLE
//      processor session for an order that has already settled;
//   2. returned status "pending_payment" with that session's hosted URL.
//
// The checkout page assigns that URL, so the shopper lands on a live card form
// for an order they have already paid. Paying it charges them twice for one
// purchase. The `.neq("payment_status","paid")` further down guards the STORED
// session pointer, not the minting — and the minting is the part that can take
// the money.
//
// Replaying a spent key is not exotic: the key is held per page-session, and
// any response the browser loses leaves the client holding a key whose order
// may already have been paid by the request that "failed".
//
// Returning no URL is NOT an acceptable answer either — the checkout page reads
// an empty url as "we couldn't reach the payment provider, so your card was not
// charged", which is false and invites exactly the retry this prevents. So the
// server reports alreadyPaid and the page routes to the receipt.
// ---------------------------------------------------------------------------

const PAID_ORDER = {
  order_id: "order-already-paid-1",
  order_number: "VL-PAID001",
  payment_id: "vs_the_session_that_actually_paid",
  payment_method: "card",
  amount_paid: 224.58,
  card_processing_fee: 6.54,
  card_processing_fee_percent: 3,
  payment_status: "paid",
};

/** Every attempt to mint a processor session, so a second charge is countable. */
const sessionsMinted: Array<{ orderId: string; amount: number }> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-provider", () => ({
  getPaymentProvider: () => ({
    createCheckoutSession: async (input: { orderId: string; amount: number }) => {
      sessionsMinted.push({ orderId: input.orderId, amount: input.amount });
      return { paymentId: "vs_a_brand_new_chargeable_session", hostedCheckoutUrl: "https://veyragate.test/pay/new" };
    },
  }),
  isCheckoutOpen: () => true,
}));

vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());

// The order lookup is the only part of the database this test needs to be
// specific about: the idempotency-key read answers with a PAID order.
vi.mock("@/lib/supabase-server", () => {
  // One generically chainable builder. quoteOrder reads several tables before
  // the idempotency lookup is even reached (products, costs, settings), so a
  // double that only models `orders` throws on the way in and the test fails
  // for a reason that has nothing to do with what it is proving.
  const builder = (rows: unknown[], single: unknown) => {
    const b: Record<string, unknown> = {
      select() { return b; },
      eq() { return b; },
      neq() { return b; },
      not() { return b; },
      in() { return b; },
      is() { return b; },
      gte() { return b; },
      lte() { return b; },
      lt() { return b; },
      gt() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      async maybeSingle() { return { data: single, error: null }; },
      async single() { return { data: single, error: null }; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: rows, error: null }).then(resolve); },
    };
    return b;
  };

  const from = (table: string) => ({
    // The one specific fact: the idempotency-key read answers with a PAID order.
    select: () => (table === "orders" ? builder([PAID_ORDER], PAID_ORDER) : builder([], null)),
    update: () => builder([], null),
    insert: () => builder([{ id: "row" }], { id: "row" }),
    upsert: () => builder([], null),
    delete: () => builder([], null),
  });
  return { supabaseAdmin: { from }, default: { from } };
});

const request = () => ({
  items: [{ id: "bpc-157-10mg", quantity: 1 }],
  customer: {
    email: "paid.shopper@example.test",
    fullName: "Paid Shopper",
    address: "1 Test Way",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "United States",
  },
  currency: "USD",
  // The key whose order has already settled.
  idempotencyKey: "idem-already-paid-1",
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionsMinted.length = 0;
});

describe("replaying an idempotency key whose order has already been paid", () => {
  it("does not ask the processor for another chargeable session", async () => {
    const { createCheckoutSession } = await import("@/lib/payment-service");
    await createCheckoutSession(request());

    // THE ASSERTION THAT MATTERS. One charge, one session.
    expect(sessionsMinted).toEqual([]);
  });

  it("reports the order as already paid, with no card form to return to", async () => {
    const { createCheckoutSession } = await import("@/lib/payment-service");
    const result = await createCheckoutSession(request());

    expect(result.orderId).toBe(PAID_ORDER.order_id);
    expect((result as { alreadyPaid?: boolean }).alreadyPaid).toBe(true);
    expect(result.status).toBe("paid");
    // An empty url must be accompanied by alreadyPaid, or the checkout page
    // tells a paid shopper their card was not charged.
    expect(result.hostedCheckoutUrl).toBe("");
  });

  it("keeps pointing at the session that actually paid", async () => {
    const { createCheckoutSession } = await import("@/lib/payment-service");
    const result = await createCheckoutSession(request());

    expect(result.paymentId).toBe(PAID_ORDER.payment_id);
  });
});
