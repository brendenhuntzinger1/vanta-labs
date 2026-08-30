import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutBody, harness, seedStore, WEBHOOK_SECRET, type Shopper } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// DOES A REAL PAID ORDER ACTUALLY RING THE PHONE?
//
// order-push-notification.test.ts proves the module builds the right message
// and survives a broken webhook. Neither of those is the thing that goes wrong
// in practice. What goes wrong is the WIRING: the call sits in a branch that a
// real payment never takes, or it sits outside the exactly-once claim and the
// operator's phone buzzes twice for one order.
//
// So this drives the real storefront checkout and the real, signed payment
// webhook against the fake database — the same harness the commerce journey
// uses — and watches the outbound HTTP the store actually makes. Nothing here
// calls the notification module directly.
// ---------------------------------------------------------------------------

process.env.PAYMENT_PROVIDER = "mock";
process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ALLOW_MOCK_PAYMENTS = "true";
process.env.NEXT_PUBLIC_SITE_URL = "https://vantalabsresearch.test";
process.env.ORDER_PUSH_WEBHOOK_URL = "https://hooks.example.test/catch/1/e2e";

vi.mock("server-only", () => ({}));

// after() runs the callback immediately. The notification really IS scheduled
// by the webhook; deferring it here would only hide whether it was.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (fn: () => unknown) => { void Promise.resolve().then(fn); } };
});

vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  revalidateTag: () => {},
}));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return harness.db.client; },
  createServerClient: () => harness.db.client,
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => null,
  getSessionAccessToken: async () => null,
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));

// Shippo is pushed from the same side-effects block. Stubbed so a label call
// cannot be mistaken for the notification's HTTP.
vi.mock("@/lib/shippo/client", () => ({
  SHIPPO_REQUEST_TIMEOUT_MS: 15_000,
  createShippoOrder: async () => ({ ok: true as const, data: { object_id: "shippo_order_e2e" } }),
  createShipmentWithRates: async () => ({ ok: true as const, data: { shipmentId: "shippo_shipment_e2e", rates: [] } }),
  parseAmountToCents: () => null,
}));

vi.unmock("@/lib/coupons");
vi.unmock("@/lib/admin-control");
vi.unmock("@/lib/catalog");
vi.unmock("@/lib/cart-recovery");
vi.unmock("@/lib/membership");

const SHOPPER: Shopper = {
  email: "push.buyer@example.test",
  fullName: "Alpha Buyer",
  address: "10 Alpha Street",
  city: "Alphatown",
  state: "TX",
  postalCode: "75001",
  country: "US",
  phone: "555-0111",
};

const SLUG = "alpha-peptide-10mg";
const PRODUCTS = [
  { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 4499, inventory: 40, unitCostCents: 1200, weightOz: 0.4 },
];

/** Every outbound POST to the configured push webhook, in order. */
const pushes: Array<Record<string, string>> = [];

async function postCheckout(items: Array<{ productId: string; quantity: number }>) {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const response = await POST(
    new Request("https://vantalabsresearch.test/api/checkout/create-session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(checkoutBody(SHOPPER, items)),
    }),
  );
  return await response.json() as Record<string, unknown>;
}

async function postPaymentWebhook(event: Record<string, unknown>, eventId: string) {
  const { signWebhookPayload } = await import("@/lib/payment-provider");
  const { POST } = await import("@/app/api/webhooks/payment/route");
  const payload = JSON.stringify(event);
  const response = await POST(
    new Request("https://vantalabsresearch.test/api/webhooks/payment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
        "x-event-id": eventId,
      },
      body: payload,
    }),
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function paymentSucceeded(orderId: string, amount: number) {
  return {
    type: "payment.succeeded",
    data: { object: { metadata: { orderId, order_id: orderId, customerEmail: SHOPPER.email }, amount, currency: "USD" } },
  };
}

/** after() defers onto the microtask queue; let the scheduled work land. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Buy something, for real, and pay for it. Returns the order id. */
async function buyAndPay(quantity: number, eventSuffix = "1") {
  const body = await postCheckout([{ productId: SLUG, quantity }]);
  const orderId = String(body.orderId);
  await postPaymentWebhook(paymentSucceeded(orderId, Number(body.total)), `evt-${orderId}-${eventSuffix}`);
  await settle();
  return orderId;
}

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, PRODUCTS);
  pushes.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://hooks.example.test/")) {
      pushes.push(JSON.parse(String(init?.body)) as Record<string, string>);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected outbound request to ${String(url)}`);
  });
});

describe("a real paid order", () => {
  it("sends exactly one notification, describing the order that was actually placed", async () => {
    const orderId = await buyAndPay(2);

    expect(pushes).toHaveLength(1);

    const order = harness.db.rows("orders").find((row) => row.order_id === orderId)!;
    const paid = Number(order.amount_paid).toFixed(2);

    // Asserted against the DATABASE, not against a number written here: the
    // whole point is that the phone reports what the store actually charged.
    expect(pushes[0]).toMatchObject({
      event: "new_order",
      title: `New Order ${order.order_number}`,
      order_id: orderId,
      total: paid,
      item_count: "2",
      url: `https://vantalabsresearch.test/admin/orders/${orderId}`,
    });
    expect(pushes[0].message).toContain(`$${paid}`);
    expect(pushes[0].message).toContain("profit ");
  });

  it("names the product that was actually bought, read back out of the order", async () => {
    // The operator asked to see what was in the order. Reading the name from
    // the order_items rows the checkout actually wrote is the only way to know
    // the notification describes THIS order rather than a hardcoded string.
    await buyAndPay(2);
    expect(pushes[0].items).toBe("2× Alpha Peptide 10mg");
    expect(pushes[0].message).toContain("2× Alpha Peptide 10mg");
  });

  it("stamps the time in the store's zone so an evening order is not dated tomorrow", async () => {
    await buyAndPay(1);
    // Vercel runs UTC; the display zone is Eastern. Asserting the suffix and a
    // real parse is enough — format-date.test.ts owns the zone arithmetic.
    expect(pushes[0].placed_at_display).toMatch(/ ET$/);
    expect(Number.isNaN(Date.parse(pushes[0].placed_at))).toBe(false);
  });

  it("sends the shopper's full name, and still no way to contact or find them", async () => {
    await buyAndPay(1);
    // The operator chose the full name over the old "Alpha B." redaction. That
    // is the ONLY thing that widened: the email address and the shipping
    // address must still be absent from the payload entirely.
    expect(pushes[0].customer).toBe("Alpha Buyer");
    expect(JSON.stringify(pushes[0])).not.toContain(SHOPPER.email);
    expect(JSON.stringify(pushes[0])).not.toContain(SHOPPER.address);
    expect(JSON.stringify(pushes[0])).not.toContain(SHOPPER.phone);
    expect(JSON.stringify(pushes[0])).not.toContain(SHOPPER.postalCode);
  });

  it("does not ring the phone twice when the processor redelivers the same payment", async () => {
    // Payment processors retry. The notification sits inside the paid
    // side-effects claim precisely so a redelivery cannot double-notify.
    const body = await postCheckout([{ productId: SLUG, quantity: 1 }]);
    const orderId = String(body.orderId);
    const event = paymentSucceeded(orderId, Number(body.total));

    await postPaymentWebhook(event, "evt_dupe_a");
    await postPaymentWebhook(event, "evt_dupe_b");
    await settle();

    expect(pushes).toHaveLength(1);
  });

  it("stays silent for a checkout that was never paid", async () => {
    await postCheckout([{ productId: SLUG, quantity: 1 }]);
    await settle();

    // An order row exists and stock is held, but nobody has been charged.
    expect(harness.db.rows("orders")).toHaveLength(1);
    expect(pushes).toHaveLength(0);
  });
});

describe("when the operator has not set the webhook up", () => {
  it("completes the order without sending anything", async () => {
    vi.stubEnv("ORDER_PUSH_WEBHOOK_URL", "");
    const orderId = await buyAndPay(1);

    expect(pushes).toHaveLength(0);
    // The order still settled: paid, and stock committed.
    const order = harness.db.rows("orders").find((row) => row.order_id === orderId)!;
    expect(order.payment_status).toBe("paid");
    expect(order.paid_side_effects_at).toBeTruthy();
    vi.unstubAllEnvs();
  });
});
