import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkoutBody,
  countEmails,
  emailsTo,
  harness,
  seedStore,
  SHIPPO_WEBHOOK_SECRET,
  WEBHOOK_SECRET,
  type Shopper,
} from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// ONE ORDER, END TO END, THROUGH THE REAL APPLICATION.
//
// Storefront -> checkout -> paid -> inventory -> confirmation email -> Shippo
// push -> label -> carrier scans -> delivery -> accounting, with every step
// driven by the shipping code and joined ONLY by a shared database. The test
// never hands state from one stage to the next and never writes an order row
// itself; if a seam is wrong, the next stage simply does not find what it
// needs.
//
// Mocked: the Shippo HTTP client, the email transport, the cookie-backed
// session, and the payment processor's gateway. Everything above those lines is
// the production implementation, including all pricing, idempotency, the
// fulfillment state machine and the profit math.
// ---------------------------------------------------------------------------

process.env.PAYMENT_PROVIDER = "mock";
process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ALLOW_MOCK_PAYMENTS = "true";
process.env.SHIPPO_API_TOKEN = "shippo_test_e2e_certification";
process.env.SHIPPO_WEBHOOK_SECRET = SHIPPO_WEBHOOK_SECRET;
process.env.NEXT_PUBLIC_SITE_URL = "https://vantalabsresearch.test";

vi.mock("server-only", () => ({}));

// after() runs the callback immediately: the Shippo push really IS scheduled by
// the webhook, and deferring it here would only hide whether it was.
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

// cookies() needs a Next request scope only the server provides. Both shoppers
// check out as GUESTS, which is the harder path (no account perks, no stored
// identity) and the one a first-day customer actually takes.
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => null,
  getSessionAccessToken: async () => null,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string; html: string; text: string }) => {
    if (harness.emailFailures > 0) {
      harness.emailFailures -= 1;
      return { success: false, error: "provider down" };
    }
    harness.emails.push({ to: input.to, subject: input.subject, html: input.html, text: input.text ?? "" });
    return { success: true };
  },
}));

vi.mock("@/lib/shippo/client", () => ({
  SHIPPO_REQUEST_TIMEOUT_MS: 15_000,
  createShippoOrder: async (payload: unknown) => {
    harness.shippoCalls.push({ kind: "order", payload });
    if (harness.shippoOrderFailures > 0) {
      harness.shippoOrderFailures -= 1;
      return { ok: false as const, kind: "network", message: "simulated Shippo outage", safeToRetry: true };
    }
    return { ok: true as const, data: { object_id: harness.nextShippoOrderId } };
  },
  createShipmentWithRates: async (payload: unknown) => {
    harness.shippoCalls.push({ kind: "shipment", payload });
    return { ok: true as const, data: { shipmentId: harness.nextShipmentId, rates: [] } };
  },
  parseAmountToCents: (amount: unknown) => {
    if (amount == null) return null;
    const text = String(amount).trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
    return Math.round(Number(text) * 100);
  },
}));

// Real modules the global setup replaces with stubs. The point of this file is
// that money, discounts, stock and control settings run the real code.
vi.unmock("@/lib/coupons");
vi.unmock("@/lib/admin-control");
vi.unmock("@/lib/catalog");
vi.unmock("@/lib/cart-recovery");
vi.unmock("@/lib/membership");

const ALPHA: Shopper = {
  email: "alpha.buyer@example.test",
  fullName: "Alpha Buyer",
  address: "10 Alpha Street",
  city: "Alphatown",
  state: "TX",
  postalCode: "75001",
  country: "US",
  phone: "555-0111",
};

const BETA: Shopper = {
  email: "beta.buyer@example.test",
  fullName: "Beta Buyer",
  address: "20 Beta Avenue",
  city: "Betaville",
  state: "OH",
  postalCode: "44001",
  country: "US",
  phone: "555-0222",
};

const ALPHA_SLUG = "alpha-peptide-10mg";
const BETA_SLUG = "beta-peptide-5mg";

const PRODUCTS = [
  { slug: ALPHA_SLUG, name: "Alpha Peptide 10mg", priceCents: 4499, inventory: 40, unitCostCents: 1200, weightOz: 0.4 },
  { slug: BETA_SLUG, name: "Beta Peptide 5mg", priceCents: 6999, inventory: 25, unitCostCents: 2100, weightOz: 0.5 },
];

// The store's real, independently-computed expectation for ALPHA's basket.
// 3 x $44.99 with the published 3+ bundle rate (8%): 44.99 * 0.92 = 41.39/unit.
const ALPHA_UNIT = 41.39;
const ALPHA_SUBTOTAL = 124.17;
const ALPHA_TOTAL = 143.35; // subtotal + shipping + 5% card fee on 129.17
const CONFIRMATION = /^Order Confirmed/i;
const SHIPPING_EMAIL = /^Shipping Update/i;
const DELIVERY_EMAIL = /^Delivered/i;

// ------------------------------------------------------------ driving code --

async function postCheckout(shopper: Shopper, items: Array<{ productId: string; quantity: number }>) {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const request = new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(checkoutBody(shopper, items)),
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** A payment event signed exactly the way the live processor signs it. */
async function postPaymentWebhook(event: Record<string, unknown>, eventId: string) {
  const { signWebhookPayload } = await import("@/lib/payment-provider");
  const { POST } = await import("@/app/api/webhooks/payment/route");
  const payload = JSON.stringify(event);
  const request = new Request("https://vantalabsresearch.test/api/webhooks/payment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
      "x-event-id": eventId,
    },
    body: payload,
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function paymentSucceeded(orderId: string, amount: number, email: string) {
  return {
    type: "payment.succeeded",
    data: { object: { metadata: { orderId, order_id: orderId, customerEmail: email }, amount, currency: "USD" } },
  };
}

async function postShippoWebhook(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/webhooks/shippo/route");
  const request = new Request(
    `https://vantalabsresearch.test/api/webhooks/shippo?secret=${encodeURIComponent(SHIPPO_WEBHOOK_SECRET)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const response = await POST(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function transactionCreated(input: {
  shippoOrderId: string;
  transactionId: string;
  trackingNumber: string;
  postage: string;
  carrier?: string;
}) {
  return {
    event: "transaction_created",
    data: {
      object_id: input.transactionId,
      status: "SUCCESS",
      order: input.shippoOrderId,
      tracking_number: input.trackingNumber,
      label_url: `https://shippo-delivery.example/${input.transactionId}.pdf`,
      rate: {
        amount: input.postage,
        provider: input.carrier ?? "USPS",
        servicelevel: { name: "Priority Mail" },
      },
    },
  };
}

function trackUpdated(input: {
  transactionId: string;
  trackingNumber: string;
  status: string;
  statusDate: string;
  carrier?: string;
}) {
  return {
    event: "track_updated",
    data: {
      transaction: input.transactionId,
      tracking_number: input.trackingNumber,
      carrier: input.carrier ?? "usps",
      tracking_status: { status: input.status, status_date: input.statusDate },
    },
  };
}

function order(orderId: string) {
  return harness.db.findOne("orders", "order_id", orderId);
}

function stock(slug: string) {
  const row = harness.db.findOne("products", "slug", slug);
  return { onHand: Number(row?.inventory_quantity ?? 0), reserved: Number(row?.reserved_quantity ?? 0) };
}

/** Let the after()-scheduled Shippo push run to completion. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Checkout + pay, returning the order id. The two steps a real shopper takes. */
async function buyAndPay(shopper: Shopper, slug: string, quantity: number, eventSuffix = "1") {
  const { body } = await postCheckout(shopper, [{ productId: slug, quantity }]);
  const orderId = String(body.orderId);
  const amount = Number(body.total);
  await postPaymentWebhook(paymentSucceeded(orderId, amount, shopper.email), `evt-${orderId}-${eventSuffix}`);
  await settle();
  return { orderId, amount };
}

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, PRODUCTS);
  vi.clearAllMocks();
});

// ===========================================================================
describe("PHASE 1 — checkout writes one order and holds the stock", () => {
  it("creates a pending order and reserves exactly the units bought", async () => {
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 40, reserved: 0 });

    const { status, body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const row = order(String(body.orderId));
    expect(row?.payment_status).toBe("pending_payment");
    expect(row?.customer_email).toBe(ALPHA.email);

    // The hold is taken; nothing is DEDUCTED until money arrives.
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 40, reserved: 3 });
  });

  it("prices the order server-side from the products table", async () => {
    const { body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    const row = order(String(body.orderId));
    const items = harness.db.rows("order_items");

    // The published 3+ bundle rate applied by the real pricing engine.
    expect(Number(items[0]?.unit_price)).toBeCloseTo(ALPHA_UNIT, 2);
    expect(Number(row?.subtotal)).toBeCloseTo(ALPHA_SUBTOTAL, 2);
    expect(Number(row?.amount_paid)).toBeCloseTo(ALPHA_TOTAL, 2);
  });

  it("sends NO email at checkout — an unpaid order is not a confirmed one", async () => {
    await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    expect(harness.emails).toHaveLength(0);
  });

  it("leaves fulfillment out of the queue until the money lands", async () => {
    const { body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    expect(order(String(body.orderId))?.fulfillment_status).not.toBe("awaiting_fulfillment");
  });
});

// ===========================================================================
describe("PHASE 2 — payment lands: stock committed, one confirmation, queued", () => {
  it("marks the order paid and commits exactly 3 units", async () => {
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);

    expect(order(orderId)?.payment_status).toBe("paid");
    // 40 -> 37 on hand, and the hold is gone rather than double-counted.
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 37, reserved: 0 });
  });

  it("sends the confirmation email EXACTLY once, to the buyer", async () => {
    await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    expect(emailsTo(ALPHA.email)).toHaveLength(1);
    expect(countEmails(ALPHA.email, CONFIRMATION)).toBe(1);
  });

  it("puts the order in the fulfillment queue", async () => {
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    expect(order(orderId)?.fulfillment_status).toBe("awaiting_fulfillment");
  });

  it("REFUSES an unsigned payment event outright", async () => {
    const { body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    const orderId = String(body.orderId);
    const { POST } = await import("@/app/api/webhooks/payment/route");
    const response = await POST(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment-signature": "forged", "x-event-id": "evt-forged" },
      body: JSON.stringify(paymentSucceeded(orderId, ALPHA_TOTAL, ALPHA.email)),
    }));

    expect(response.status).toBe(400);
    expect(order(orderId)?.payment_status).toBe("pending_payment");
    // The whole point: no stock moved, no email, no money recorded.
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 40, reserved: 3 });
    expect(harness.emails).toHaveLength(0);
  });
});

// ===========================================================================
describe("PHASE 3 — the paid order reaches Shippo automatically", () => {
  it("pushes the order and records the Shippo ids on the row", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    harness.nextShipmentId = "shippo_shipment_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);

    const row = order(orderId);
    expect(row?.shippo_order_id).toBe("shippo_order_alpha");
    expect(row?.shippo_shipment_id).toBe("shippo_shipment_alpha");
    expect(row?.shippo_sync_status).toBe("synced");
  });

  it("sends Shippo the customer's address and the real parcel weight", async () => {
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    const push = harness.shippoCalls.find((call) => call.kind === "order")?.payload as Record<string, never>;

    const to = push.to_address as unknown as Record<string, string>;
    expect(to.street1).toBe(ALPHA.address);
    expect(to.zip).toBe(ALPHA.postalCode);
    expect(String(push.order_number)).toBe(String(order(orderId)?.order_number));
    // 3 x 0.4oz merchandise + 1.2oz packaging tare = 2.4oz.
    expect(Number(push.weight)).toBeCloseTo(2.4, 2);
  });

  it("does NOT advance fulfillment or email anyone just for reaching Shippo", async () => {
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    expect(order(orderId)?.fulfillment_status).toBe("awaiting_fulfillment");
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(0);
  });

  it("recovers on the next sweep when Shippo is down at payment time", async () => {
    // The failure the owner would otherwise never see: the push dies, the order
    // is paid, and nothing retries. The sweep is the safety net.
    harness.shippoOrderFailures = 1;
    harness.nextShippoOrderId = "shippo_order_recovered";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    expect(order(orderId)?.shippo_order_id).toBeFalsy();

    const { sweepUnsyncedOrders } = await import("@/lib/shippo/order-sync");
    const result = await sweepUnsyncedOrders(10);

    expect(result.synced).toBe(1);
    expect(order(orderId)?.shippo_order_id).toBe("shippo_order_recovered");
  });
});

// ===========================================================================
describe("PHASE 4 — a label is bought: postage recorded, still no email", () => {
  async function toLabel() {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    const result = await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha",
      transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001",
      postage: "7.43",
    }));
    return { orderId, result };
  }

  it("moves the order to label_purchased and records tracking + carrier", async () => {
    const { orderId, result } = await toLabel();
    expect(result.status).toBe(200);

    const row = order(orderId);
    expect(row?.fulfillment_status).toBe("label_purchased");
    expect(row?.tracking_number).toBe("TRKALPHA000001");
    expect(row?.shipping_carrier).toBe("USPS");
    expect(row?.shippo_transaction_id).toBe("txn_alpha");
  });

  it("records the EXACT postage in cents, not a rounded dollar", async () => {
    const { orderId } = await toLabel();
    expect(order(orderId)?.postage_cost_cents).toBe(743);
    expect(order(orderId)?.actual_shipping_cost_cents).toBe(743);
    expect(order(orderId)?.shipping_cost_source).toBe("shippo");
  });

  it("sends NO shipping email — a printed label is not a shipped parcel", async () => {
    await toLabel();
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(0);
    expect(emailsTo(ALPHA.email)).toHaveLength(1); // still just the confirmation
  });

  it("attaches an unattributable label to NO order at all", async () => {
    await toLabel();
    const before = harness.db.rows("orders").map((row) => ({ ...row }));

    const result = await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_belongs_to_nobody",
      transactionId: "txn_stranger",
      trackingNumber: "TRKSTRANGER1",
      postage: "99.99",
    }));

    expect(result.status).toBe(200);
    // Not one field of any order moved, and no postage was recorded anywhere.
    expect(harness.db.rows("orders")).toEqual(before);
  });
});

// ===========================================================================
describe("PHASE 5 — the carrier moves the parcel", () => {
  async function toLabel() {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha",
      transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001",
      postage: "7.43",
    }));
    return orderId;
  }

  const scan = (status: string, date: string) => trackUpdated({
    transactionId: "txn_alpha",
    trackingNumber: "TRKALPHA000001",
    status,
    statusDate: date,
  });

  it("TRANSIT moves the order to in_transit and sends the shipping email ONCE", async () => {
    const orderId = await toLabel();
    await postShippoWebhook(scan("TRANSIT", "2026-08-20T10:00:00Z"));

    expect(order(orderId)?.fulfillment_status).toBe("in_transit");
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(1);
  });

  it("OUT_FOR_DELIVERY advances the status and sends NO second shipping email", async () => {
    const orderId = await toLabel();
    await postShippoWebhook(scan("TRANSIT", "2026-08-20T10:00:00Z"));
    await postShippoWebhook(scan("OUT_FOR_DELIVERY", "2026-08-21T08:00:00Z"));

    expect(order(orderId)?.fulfillment_status).toBe("out_for_delivery");
    // Four scans used to mean four emails. One journey, one shipping notice.
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(1);
  });

  it("DELIVERED sends the delivery email exactly once and stamps delivered_at", async () => {
    const orderId = await toLabel();
    await postShippoWebhook(scan("TRANSIT", "2026-08-20T10:00:00Z"));
    await postShippoWebhook(scan("OUT_FOR_DELIVERY", "2026-08-21T08:00:00Z"));
    await postShippoWebhook(scan("DELIVERED", "2026-08-21T15:30:00Z"));

    const row = order(orderId);
    expect(row?.fulfillment_status).toBe("delivered");
    expect(row?.delivered_at).toBeTruthy();
    expect(countEmails(ALPHA.email, DELIVERY_EMAIL)).toBe(1);
  });

  it("the whole journey sends the customer EXACTLY three emails", async () => {
    const orderId = await toLabel();
    await postShippoWebhook(scan("TRANSIT", "2026-08-20T10:00:00Z"));
    await postShippoWebhook(scan("OUT_FOR_DELIVERY", "2026-08-21T08:00:00Z"));
    await postShippoWebhook(scan("DELIVERED", "2026-08-21T15:30:00Z"));

    // Confirmation, shipped, delivered. Nothing else, ever.
    expect(emailsTo(ALPHA.email)).toHaveLength(3);
    expect(order(orderId)?.fulfillment_status).toBe("delivered");
  });
});

// ===========================================================================
describe("PHASE 6 — replays, duplicates and out-of-order delivery", () => {
  async function toTransit() {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId, amount } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha",
      transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001",
      postage: "7.43",
    }));
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));
    return { orderId, amount };
  }

  it("a REPLAYED payment event with the same id changes nothing", async () => {
    const { orderId, amount } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    const stockAfterFirst = stock(ALPHA_SLUG);

    const replay = await postPaymentWebhook(
      paymentSucceeded(orderId, amount, ALPHA.email),
      `evt-${orderId}-1`, // the SAME event id
    );
    await settle();

    expect(replay.body.duplicate).toBe(true);
    expect(stock(ALPHA_SLUG)).toEqual(stockAfterFirst);
    expect(emailsTo(ALPHA.email)).toHaveLength(1);
  });

  it("a SECOND, DISTINCT success event does not pay the order twice", async () => {
    // Not caught by the event-id claim — this is the atomic paid-flip's job.
    const { orderId, amount } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);

    await postPaymentWebhook(paymentSucceeded(orderId, amount, ALPHA.email), `evt-${orderId}-SECOND`);
    await settle();

    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 37, reserved: 0 });
    expect(emailsTo(ALPHA.email)).toHaveLength(1);
  });

  it("three simultaneous payment events commit ONE sale", async () => {
    const { body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    const orderId = String(body.orderId);
    const amount = Number(body.total);

    await Promise.all([
      postPaymentWebhook(paymentSucceeded(orderId, amount, ALPHA.email), `race-a-${orderId}`),
      postPaymentWebhook(paymentSucceeded(orderId, amount, ALPHA.email), `race-b-${orderId}`),
      postPaymentWebhook(paymentSucceeded(orderId, amount, ALPHA.email), `race-c-${orderId}`),
    ]);
    await settle();

    expect(order(orderId)?.payment_status).toBe("paid");
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 37, reserved: 0 });
    expect(emailsTo(ALPHA.email)).toHaveLength(1);
  });

  it("a redelivered tracking scan sends no second email", async () => {
    const { orderId } = await toTransit();
    const duplicate = await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));

    expect(duplicate.status).toBe(200);
    expect(order(orderId)?.fulfillment_status).toBe("in_transit");
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(1);
  });

  it("a LATE transaction_created cannot drag a moving parcel back to label_purchased", async () => {
    const { orderId } = await toTransit();

    // Shippo redelivers the label event after the parcel is already moving.
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha",
      transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001",
      postage: "7.43",
    }));

    // The parcel's real progress survives; the label FACTS are still true.
    expect(order(orderId)?.fulfillment_status).toBe("in_transit");
    expect(order(orderId)?.postage_cost_cents).toBe(743);
  });

  it("an out-of-order scan cannot move a DELIVERED order backwards", async () => {
    const { orderId } = await toTransit();
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "DELIVERED", statusDate: "2026-08-21T15:30:00Z",
    }));
    expect(order(orderId)?.fulfillment_status).toBe("delivered");

    // A stale TRANSIT scan arrives after delivery.
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T18:00:00Z",
    }));

    expect(order(orderId)?.fulfillment_status).toBe("delivered");
    // And the customer is not told it shipped after it arrived.
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(1);
    expect(countEmails(ALPHA.email, DELIVERY_EMAIL)).toBe(1);
  });

  it("delivering the scans in reverse still ends DELIVERED with two emails", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));

    for (const [status, date] of [
      ["DELIVERED", "2026-08-21T15:30:00Z"],
      ["OUT_FOR_DELIVERY", "2026-08-21T08:00:00Z"],
      ["TRANSIT", "2026-08-20T10:00:00Z"],
    ] as const) {
      await postShippoWebhook(trackUpdated({
        transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001", status, statusDate: date,
      }));
    }

    expect(order(orderId)?.fulfillment_status).toBe("delivered");
    // Straight to delivered earns only the delivery notice — being told it
    // shipped after it arrived helps nobody.
    expect(countEmails(ALPHA.email, DELIVERY_EMAIL)).toBe(1);
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(0);
  });
});

// ===========================================================================
describe("PHASE 7 — ALPHA and BETA run together with zero contamination", () => {
  interface Journey { orderId: string; amount: number }

  async function runBoth(): Promise<{ alpha: Journey; beta: Journey }> {
    // Two shoppers, two products, two quantities, two carriers, two postages.
    harness.nextShippoOrderId = "shippo_order_alpha";
    harness.nextShipmentId = "shippo_shipment_alpha";
    const alpha = await buyAndPay(ALPHA, ALPHA_SLUG, 3, "a");

    harness.nextShippoOrderId = "shippo_order_beta";
    harness.nextShipmentId = "shippo_shipment_beta";
    const beta = await buyAndPay(BETA, BETA_SLUG, 2, "b");

    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43", carrier: "USPS",
    }));
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_beta", transactionId: "txn_beta",
      trackingNumber: "TRKBETA000002", postage: "12.85", carrier: "UPS",
    }));

    return { alpha, beta };
  }

  it("keeps each order's tracking, carrier and postage entirely separate", async () => {
    const { alpha, beta } = await runBoth();

    const a = order(alpha.orderId);
    const b = order(beta.orderId);

    expect(a?.tracking_number).toBe("TRKALPHA000001");
    expect(b?.tracking_number).toBe("TRKBETA000002");
    expect(a?.shipping_carrier).toBe("USPS");
    expect(b?.shipping_carrier).toBe("UPS");
    expect(a?.postage_cost_cents).toBe(743);
    expect(b?.postage_cost_cents).toBe(1285);
    expect(a?.shippo_order_id).toBe("shippo_order_alpha");
    expect(b?.shippo_order_id).toBe("shippo_order_beta");
  });

  it("deducts each product's own stock and neither the other's", async () => {
    await runBoth();
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 37, reserved: 0 });
    expect(stock(BETA_SLUG)).toEqual({ onHand: 23, reserved: 0 });
  });

  it("sends each customer only their own emails", async () => {
    const { alpha, beta } = await runBoth();

    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));

    expect(emailsTo(ALPHA.email)).toHaveLength(2); // confirmation + shipped
    expect(emailsTo(BETA.email)).toHaveLength(1);  // confirmation only

    // The consequence that matters: BETA's customer never receives ALPHA's
    // tracking number, and vice versa.
    for (const email of emailsTo(BETA.email)) {
      expect(email.html).not.toContain("TRKALPHA000001");
      expect(email.html).not.toContain(ALPHA.address);
    }
    for (const email of emailsTo(ALPHA.email)) {
      expect(email.html).not.toContain("TRKBETA000002");
      expect(email.html).not.toContain(BETA.address);
    }
    expect(alpha.orderId).not.toBe(beta.orderId);
  });

  it("ships each parcel to its own address", async () => {
    await runBoth();
    const pushes = harness.shippoCalls
      .filter((call) => call.kind === "order")
      .map((call) => call.payload as Record<string, never>);

    const streets = pushes.map((push) => (push.to_address as unknown as Record<string, string>).street1);
    expect(streets).toContain(ALPHA.address);
    expect(streets).toContain(BETA.address);
    expect(new Set(streets).size).toBe(2);
  });

  it("advancing ALPHA to delivered leaves BETA exactly where it was", async () => {
    const { alpha, beta } = await runBoth();
    const betaBefore = order(beta.orderId);

    for (const [status, date] of [
      ["TRANSIT", "2026-08-20T10:00:00Z"],
      ["OUT_FOR_DELIVERY", "2026-08-21T08:00:00Z"],
      ["DELIVERED", "2026-08-21T15:30:00Z"],
    ] as const) {
      await postShippoWebhook(trackUpdated({
        transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001", status, statusDate: date,
      }));
    }

    expect(order(alpha.orderId)?.fulfillment_status).toBe("delivered");
    expect(order(beta.orderId)).toEqual(betaBefore);
  });
});

// ===========================================================================
describe("PHASE 8 — failures injected between the writes that matter", () => {
  it("a crash BETWEEN the paid flip and the side-effects is recovered by a retry", async () => {
    const { body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    const orderId = String(body.orderId);
    const amount = Number(body.total);

    // Kill the side-effects claim: the order flips to paid, then the process
    // dies before anything downstream runs. This is the dangerous shape — money
    // taken, customer told nothing, stock not committed.
    harness.db.injectFailure({ table: "orders", op: "update", times: 1, message: "process killed" });
    // The first update after the flip is the claim, so the flip itself lands.
    await postPaymentWebhook(paymentSucceeded(orderId, amount, ALPHA.email), `crash-${orderId}`);
    await settle();
    harness.db.clearFailures();

    // The processor retries with a NEW event id, as a real one does.
    await postPaymentWebhook(paymentSucceeded(orderId, amount, ALPHA.email), `retry-${orderId}`);
    await settle();

    // Everything completes exactly once, and nothing ran twice.
    expect(order(orderId)?.payment_status).toBe("paid");
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 37, reserved: 0 });
    expect(emailsTo(ALPHA.email)).toHaveLength(1);
  });

  it("a tracking update that cannot be written is left for Shippo to retry", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));

    harness.db.injectFailure({ table: "orders", op: "update", times: 1, message: "write failed" });
    const failed = await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));
    harness.db.clearFailures();

    // A failed write must NOT be answered 200-and-forgotten, and must NOT email
    // the customer about a status that did not persist.
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(order(orderId)?.fulfillment_status).toBe("label_purchased");
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(0);

    // Shippo's retry then genuinely re-runs it — the claim was released.
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));
    expect(order(orderId)?.fulfillment_status).toBe("in_transit");
    expect(countEmails(ALPHA.email, SHIPPING_EMAIL)).toBe(1);
  });

  it("an email provider outage never strands the order, and queues the retry", async () => {
    const { body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    const orderId = String(body.orderId);

    harness.emailFailures = 1;
    await postPaymentWebhook(paymentSucceeded(orderId, Number(body.total), ALPHA.email), `mail-${orderId}`);
    await settle();

    // The sale is complete and the stock is committed even though the receipt
    // could not be delivered — and the failure is queued rather than lost.
    expect(order(orderId)?.payment_status).toBe("paid");
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 37, reserved: 0 });
    expect(harness.emails).toHaveLength(0);
    // Logging a failure is not a retry: the receipt is queued for the sweep.
    expect(harness.db.rows("pending_emails")).toHaveLength(1);
    expect(harness.db.rows("pending_emails")[0]?.to_email ?? harness.db.rows("pending_emails")[0]?.recipient)
      .toBe(ALPHA.email);
  });

  it("an abandoned checkout returns its held stock to the shelf", async () => {
    await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 40, reserved: 3 });

    // Age the hold past its expiry, then run the real sweep.
    for (const reservation of harness.db.table("inventory_reservations")) {
      reservation.expires_at = "2000-01-01T00:00:00.000Z";
    }
    const { expireStaleReservations } = await import("@/lib/inventory-reservation");
    const reclaimed = await expireStaleReservations();

    expect(reclaimed).toBe(1);
    expect(stock(ALPHA_SLUG)).toEqual({ onHand: 40, reserved: 0 });
  });
});

// ===========================================================================
describe("PHASE 9 — the books reconcile to the cent", () => {
  it("agrees, line by line, with an independent calculation", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));

    const { getOrderProfit } = await import("@/lib/admin-profit");
    const profit = await getOrderProfit(orderId);

    // ---- computed here, by hand, from the store's published rules ----------
    // merchandise  3 x $44.99 less the 8% 3+ bundle rate      = $124.17
    // shipping     flat domestic fee                          = $ 15.00
    // card fee     5% of (merch + shipping)                   = $  4.18
    // customer paid                                            = $143.35
    // COGS         3 x $12.00 product cost                    = $ 36.00
    // postage      the exact Shippo amount, not an estimate   = $  7.43
    // processing   8% of $143.35 (default profit setting)     = $ 11.47
    // profit       143.35 - 36.00 - 7.43 - 11.47              = $ 88.45
    expect(profit?.merchandiseRevenue).toBeCloseTo(124.17, 2);
    expect(profit?.shippingRevenue).toBeCloseTo(15, 2);
    expect(profit?.additionalRevenue).toBeCloseTo(4.18, 2);
    expect(profit?.revenue).toBeCloseTo(143.35, 2);
    expect(profit?.cogs).toBeCloseTo(36, 2);
    expect(profit?.shippingCost).toBeCloseTo(7.43, 2);
    expect(profit?.processingFee).toBeCloseTo(11.47, 2);
    expect(profit?.profit).toBeCloseTo(88.45, 2);
  });

  it("counts revenue as exactly what the customer was charged", async () => {
    const { orderId, amount } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    const { getOrderProfit } = await import("@/lib/admin-profit");
    const profit = await getOrderProfit(orderId);
    // No tax is collected here (no nexus configured), so revenue and the charge
    // must agree exactly — a penny apart means a component is double-counted.
    expect(profit?.revenue).toBeCloseTo(amount, 2);
  });

  it("marks the order estimated before the label and finalized after", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    const { getOrderProfit } = await import("@/lib/admin-profit");

    const before = await getOrderProfit(orderId);
    expect(before?.shippingCostIsEstimate).toBe(true);
    expect(before?.shippingCost).toBeCloseTo(6, 2); // the configured estimate

    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));

    const after = await getOrderProfit(orderId);
    expect(after?.shippingCostIsEstimate).toBe(false);
    expect(after?.shippingCost).toBeCloseTo(7.43, 2);
    // The estimate is preserved for the audit trail rather than overwritten.
    expect(order(orderId)?.estimated_shipping_cost_cents).toBe(600);
  });

  it("keeps ALPHA's and BETA's books entirely separate", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const alpha = await buyAndPay(ALPHA, ALPHA_SLUG, 3, "a");
    harness.nextShippoOrderId = "shippo_order_beta";
    const beta = await buyAndPay(BETA, BETA_SLUG, 2, "b");

    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_beta", transactionId: "txn_beta",
      trackingNumber: "TRKBETA000002", postage: "12.85",
    }));

    const { getOrderProfit } = await import("@/lib/admin-profit");
    const a = await getOrderProfit(alpha.orderId);
    const b = await getOrderProfit(beta.orderId);

    expect(a?.shippingCost).toBeCloseTo(7.43, 2);
    expect(b?.shippingCost).toBeCloseTo(12.85, 2);
    expect(a?.cogs).toBeCloseTo(36, 2);   // 3 x $12.00
    expect(b?.cogs).toBeCloseTo(42, 2);   // 2 x $21.00
  });
});

// ===========================================================================
describe("PHASE 10 — a replacement costs money and is not a sale", () => {
  async function deliveredOrder() {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));
    return orderId;
  }

  async function replace(originalOrderId: string, requestId: string) {
    const { createReplacementOrder } = await import("@/lib/admin-replacements");
    return createReplacementOrder({ originalOrderId, reason: "damaged", requestId });
  }

  it("creates a $0 order to the SAME address, with no revenue attached", async () => {
    const originalId = await deliveredOrder();
    const result = await replace(originalId, "req-alpha-1");

    const row = order(result.orderId);
    expect(row?.order_type).toBe("replacement");
    expect(Number(row?.amount_paid)).toBe(0);
    expect(Number(row?.subtotal)).toBe(0);
    expect(row?.shipping_address).toBe(ALPHA.address);
    expect(row?.replacement_of).toBe(originalId);
    // It joins the fulfillment queue like any parcel that has to be posted.
    expect(row?.fulfillment_status).toBe("awaiting_fulfillment");
  });

  it("deducts stock again — a reship is real product off the shelf", async () => {
    const originalId = await deliveredOrder();
    expect(stock(ALPHA_SLUG).onHand).toBe(37);

    await replace(originalId, "req-alpha-1");

    expect(stock(ALPHA_SLUG).onHand).toBe(34);
  });

  it("carries COGS and postage but ZERO revenue in the books", async () => {
    const originalId = await deliveredOrder();
    const result = await replace(originalId, "req-alpha-1");

    harness.nextShippoOrderId = "shippo_order_replacement";
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha",
      transactionId: "txn_replacement",
      trackingNumber: "TRKREPL000003",
      postage: "6.10",
    }));

    const { getOrderProfit } = await import("@/lib/admin-profit");
    const replacement = await getOrderProfit(result.orderId);

    expect(replacement?.revenue).toBe(0);
    expect(replacement?.merchandiseRevenue).toBe(0);
    // The costs are real and must land somewhere.
    expect(replacement?.cogs).toBeCloseTo(36, 2);
    expect(replacement?.profit).toBeLessThan(0);
  });

  it("is NOT counted as a sale, so average order value is not dragged down", async () => {
    const originalId = await deliveredOrder();
    const result = await replace(originalId, "req-alpha-1");

    // The distinction the reporting layer depends on: orderType tells revenue
    // reporting to exclude this row from the sale COUNT while still charging
    // its costs against the period.
    const { getOrderProfit } = await import("@/lib/admin-profit");
    expect((await getOrderProfit(result.orderId))?.orderType).toBe("replacement");
    expect((await getOrderProfit(originalId))?.orderType).not.toBe("replacement");
  });

  it("a double-clicked replacement ships ONE parcel", async () => {
    const originalId = await deliveredOrder();
    const first = await replace(originalId, "req-alpha-1");
    const second = await replace(originalId, "req-alpha-1");

    expect(second.orderId).toBe(first.orderId);
    expect(second.duplicate).toBe(true);
    // 37 - 3, not 37 - 6.
    expect(stock(ALPHA_SLUG).onHand).toBe(34);
    expect(harness.db.rows("orders").filter((row) => row.order_type === "replacement")).toHaveLength(1);
  });

  it("refuses to replace an order that was never paid for", async () => {
    const { body } = await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 3 }]);
    await expect(replace(String(body.orderId), "req-unpaid")).rejects.toThrow(/paid/i);
  });
});

// ===========================================================================
describe("PHASE 11 — privacy: what a customer can and cannot see", () => {
  it("never puts the ship-from origin in anything sent to a customer", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));

    // The synthetic stand-in for the real private origin. It is the SHIP-FROM,
    // and it must never reach the customer — only the separate, deliberately
    // configured return address may.
    const ORIGIN_SENTINEL = "1 Synthetic Origin Way";
    for (const email of emailsTo(ALPHA.email)) {
      expect(email.html).not.toContain(ORIGIN_SENTINEL);
      expect(email.text).not.toContain(ORIGIN_SENTINEL);
    }
    expect(orderId).toBeTruthy();
  });

  it("sends Shippo a SEPARATE return address, so the label does not print the origin", async () => {
    await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    const shipment = harness.shippoCalls.find((call) => call.kind === "shipment")?.payload as Record<string, never>;

    const from = shipment.addressFrom as unknown as Record<string, string>;
    const ret = shipment.addressReturn as unknown as Record<string, string>;
    expect(from.street1).toBe("1 Synthetic Origin Way");
    expect(ret.street1).toBe("2 Synthetic Return Road");
    // Shippo defaults address_return to address_from when it is omitted — which
    // is exactly the leak the separate address exists to avoid.
    expect(ret.street1).not.toBe(from.street1);
  });

  it("never leaks one customer's postage, cost or margin into their emails", async () => {
    harness.nextShippoOrderId = "shippo_order_alpha";
    await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));

    for (const email of emailsTo(ALPHA.email)) {
      expect(email.html).not.toContain("7.43");   // what postage cost us
      expect(email.html).not.toContain("12.00");  // what the product cost us
    }
  });

  it("does not disclose stock depth when a line is short", async () => {
    // Buy the shelf out, then try to buy more.
    await postCheckout(ALPHA, [{ productId: ALPHA_SLUG, quantity: 40 }]);
    const { status, body } = await postCheckout(BETA, [{ productId: ALPHA_SLUG, quantity: 5 }]);

    expect(status).toBe(400);
    const message = String(body.error ?? "");
    // Names the item so the cart is fixable; never the count, which would make
    // checkout a free inventory API.
    expect(message).toMatch(/Alpha Peptide/i);
    expect(message).not.toMatch(/\b\d+\s*(left|remaining|available)/i);
  });
});

// ===========================================================================
describe("PHASE 12 — protections the happy path alone cannot exercise", () => {
  async function toTransit() {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const paid = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));
    return paid;
  }

  it("a LATE duplicate payment event cannot drag a moving parcel back into the queue", async () => {
    // The distinct job of the paid-flip's `.neq("payment_status","paid")`: a
    // second success delivery (new event id, so the event claim does not catch
    // it) must update ZERO rows. Without it the flip rewrites
    // fulfillment_status to awaiting_fulfillment and stamps a new paid_at — so
    // a parcel already with the carrier reappears on the packing bench and the
    // owner ships it twice.
    const { orderId, amount } = await toTransit();
    const paidAtBefore = order(orderId)?.paid_at;

    await postPaymentWebhook(paymentSucceeded(orderId, amount, ALPHA.email), `late-dup-${orderId}`);
    await settle();

    expect(order(orderId)?.fulfillment_status).toBe("in_transit");
    expect(order(orderId)?.paid_at).toBe(paidAtBefore);
  });

  it("an admin cannot mark an order delivered, and CAN still record a hand-carried shipment", async () => {
    // The source rule in order-pipeline.ts, exercised through the canonical
    // writer the admin API calls. Delivery is the carrier's to report; the
    // courier escape hatch stays open.
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));

    const { setOrderFulfillmentStatus } = await import("@/lib/shippo/service");

    const refused = await setOrderFulfillmentStatus({ orderId, to: "delivered", source: "admin", actor: "owner" });
    expect(refused.ok).toBe(false);
    expect(order(orderId)?.fulfillment_status).toBe("label_purchased");
    // And no delivery email went out on the strength of a refused write.
    expect(countEmails(ALPHA.email, DELIVERY_EMAIL)).toBe(0);

    const allowed = await setOrderFulfillmentStatus({ orderId, to: "shipped", source: "admin", actor: "owner" });
    expect(allowed.ok).toBe(true);
    expect(order(orderId)?.fulfillment_status).toBe("shipped");
  });

  it("a redelivered scan writes no second history row", async () => {
    const { orderId } = await toTransit();
    const before = harness.db.rows("order_status_history").filter((row) => row.order_id === orderId).length;

    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));

    const after = harness.db.rows("order_status_history").filter((row) => row.order_id === orderId).length;
    expect(after).toBe(before);
  });

  it("the customer's order timeline records every real move, and only real moves", async () => {
    const { orderId } = await toTransit();
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "DELIVERED", statusDate: "2026-08-21T15:30:00Z",
    }));

    const history = harness.db.rows("order_status_history")
      .filter((row) => row.order_id === orderId)
      .map((row) => row.to_status);

    expect(history).toEqual(["label_purchased", "in_transit", "delivered"]);
  });
});

// ===========================================================================
describe("PHASE 13 — staleness rules, isolated from the terminal rule", () => {
  async function toOutForDelivery() {
    harness.nextShippoOrderId = "shippo_order_alpha";
    const paid = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));
    for (const [status, date] of [
      ["TRANSIT", "2026-08-20T10:00:00Z"],
      ["OUT_FOR_DELIVERY", "2026-08-21T08:00:00Z"],
    ] as const) {
      await postShippoWebhook(trackUpdated({
        transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001", status, statusDate: date,
      }));
    }
    return paid;
  }

  it("a stale scan cannot walk a NON-terminal order backwards", async () => {
    // out_for_delivery is not terminal, so the terminal rule does not apply
    // here — only the no-regression rank comparison stands between a
    // re-ordered carrier feed and an order that tells the customer it is back
    // in transit after the van already had it.
    const { orderId } = await toOutForDelivery();

    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T18:00:00Z",
    }));

    expect(order(orderId)?.fulfillment_status).toBe("out_for_delivery");
  });

  it("shipped_at is stamped once and never moved by a later scan", async () => {
    // The date the customer is shown as "shipped". Re-stamping it on every
    // subsequent scan would make a parcel posted on Monday claim it shipped on
    // Thursday — and it is the clock every delivery-time promise is measured
    // against.
    harness.nextShippoOrderId = "shippo_order_alpha";
    const { orderId } = await buyAndPay(ALPHA, ALPHA_SLUG, 3);
    await postShippoWebhook(transactionCreated({
      shippoOrderId: "shippo_order_alpha", transactionId: "txn_alpha",
      trackingNumber: "TRKALPHA000001", postage: "7.43",
    }));
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "TRANSIT", statusDate: "2026-08-20T10:00:00Z",
    }));

    const firstStamp = order(orderId)?.shipped_at;
    expect(firstStamp).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await postShippoWebhook(trackUpdated({
      transactionId: "txn_alpha", trackingNumber: "TRKALPHA000001",
      status: "OUT_FOR_DELIVERY", statusDate: "2026-08-21T08:00:00Z",
    }));

    expect(order(orderId)?.shipped_at).toBe(firstStamp);
  });
});
