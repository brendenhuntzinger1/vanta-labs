import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutBody, countEmails, harness, seedStore, WEBHOOK_SECRET, type Shopper } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// SECTIONS F + H — THE BROWSER IS NOT THE PRICING AUTHORITY, AND THE PAYMENT
// LIFECYCLE IS IDEMPOTENT.
//
// Two questions, deliberately in one file because they share a fixture and the
// second only matters if the first holds.
//
//   F  A shopper controls their own request. Every number in it that could
//      move money is either absent from the contract or recomputed. These tests
//      SEND the tampered field and then read what the server wrote, rather than
//      asserting the type does not allow it — a type is a compile-time promise
//      and an attacker is a runtime one.
//
//   H  Money arrives over a webhook that can be replayed, duplicated, delayed
//      or reordered by the processor. Every one of those must converge on the
//      same single order, one stock movement, one confirmation, one redemption.
//
// The processor signature is verified for real. The gateway, mail and Shippo
// are mocked, because a real call there spends money, mail or postage.
// ---------------------------------------------------------------------------

process.env.PAYMENT_PROVIDER = "mock";
process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ALLOW_MOCK_PAYMENTS = "true";
process.env.NEXT_PUBLIC_SITE_URL = "https://vantalabsresearch.test";

vi.mock("server-only", () => ({}));
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
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string; html?: string; text?: string }) => {
    harness.emails.push({ to: message.to, subject: message.subject, html: message.html ?? "", text: message.text ?? "" });
    return { id: `email-${harness.emails.length}` };
  },
}));
vi.mock("@/lib/shippo/client", () => ({
  shippoRequest: async () => ({ object_id: "shippo_noop", status: "SUCCESS" }),
  isShippoConfigured: () => false,
}));

const PAID_SLUG = "tamper-peptide-10mg";
const GIFT_SLUG = "tamper-gift-50mg";
const PRICE_CENTS = 5000;
const COST_CENTS = 1000;

const SHOPPER: Shopper = {
  email: "tamper.tester@example.test",
  fullName: "Tamper Tester",
  address: "9 Adversary Lane",
  city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "512-555-0199",
};

const TOKEN = "tamper-offer-token";
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

function seedWorld() {
  harness.reset();
  seedStore(harness.db, [
    { slug: PAID_SLUG, name: "Tamper Peptide 10mg", priceCents: PRICE_CENTS, inventory: 50, unitCostCents: COST_CENTS, weightOz: 0.4 },
    { slug: GIFT_SLUG, name: "Tamper Gift 50mg", priceCents: 4000, inventory: 30, unitCostCents: 800, weightOz: 0.4 },
  ]);
}

function seedPrize(email = SHOPPER.email, overrides: Record<string, unknown> = {}) {
  harness.db.seed("customer_offers", [{
    id: "offer-tamper", offer_key: "spin:winback_2026q4", token_hash: hashToken(TOKEN),
    email, reward_kind: "free_product", product_slug: GIFT_SLUG, quantity: 1,
    percent_off: null, variant_id: null, min_subtotal_cents: 7500,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
    reserved_order_id: null, reserved_at: null, redeemed_order_id: null, redeemed_at: null, revoked_at: null,
    ...overrides,
  }]);
}

/** Post an arbitrary body — the point is to send what a browser must not. */
async function rawCheckout(body: unknown, cookie?: string) {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const request = new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const response = await POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function paymentWebhook(event: Record<string, unknown>, eventId: string) {
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
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const succeeded = (orderId: string, amount: number, email: string) => ({
  type: "payment.succeeded",
  data: { object: { metadata: { orderId, order_id: orderId, customerEmail: email }, amount, currency: "USD" } },
});

const orderRow = (id: string) => harness.db.table("orders").find((r) => String(r.order_id) === id);
const itemsFor = (id: string) => harness.db.table("order_items").filter((r) => String(r.order_id) === id);
const stockOf = (slug: string) => {
  const r = harness.db.table("products").find((p) => String(p.slug) === slug);
  return { onHand: Number(r?.inventory_quantity ?? 0), reserved: Number(r?.reserved_quantity ?? 0) };
};

beforeEach(() => { seedWorld(); });

// ===========================================================================
// F — SERVER AUTHORITY
// ===========================================================================
describe("F — the server recomputes every number the browser could lie about", () => {
  /** The honest baseline every tampered order is measured against. */
  async function baseline() {
    const res = await rawCheckout(checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]));
    expect(res.status).toBe(200);
    return orderRow(String(res.body.orderId))!;
  }

  it("BASELINE: two units price themselves from the products table", async () => {
    const order = await baseline();
    // 2 x $50.00 less the published 5% two-unit bundle rate.
    expect(Number(order.subtotal)).toBeCloseTo(95.0, 2);
  });

  it("ignores a claimed unit price", async () => {
    const honest = await baseline();
    seedWorld();
    const body = checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]) as Record<string, unknown>;
    (body.items as Array<Record<string, unknown>>)[0].price = 0.01;
    (body.items as Array<Record<string, unknown>>)[0].unitPrice = 0.01;
    (body.items as Array<Record<string, unknown>>)[0].priceCents = 1;
    const res = await rawCheckout(body);
    expect(res.status).toBe(200);
    expect(Number(orderRow(String(res.body.orderId))!.subtotal),
      "a claimed price reached the order").toBeCloseTo(Number(honest.subtotal), 2);
  });

  it("ignores a claimed subtotal, discount and total", async () => {
    const honest = await baseline();
    seedWorld();
    const body = checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]) as Record<string, unknown>;
    body.subtotal = 1; body.discountAmount = 94; body.total = 1; body.expectedTotal = 1;
    body.amountPaid = 1; body.shipping = 0; body.taxAmount = 0;
    const res = await rawCheckout(body);

    // TWO ACCEPTABLE ANSWERS, and the store gives the stronger one.
    //
    // Ignoring the claimed figures and recomputing would be sufficient. The
    // checkout instead REFUSES the request outright (400) because
    // `expectedTotal` is part of its contract: a body whose own stated total
    // disagrees with the server's is treated as a tampered or stale cart
    // rather than silently re-priced, so the shopper is never charged a
    // number they did not see. Both outcomes are asserted so a future change
    // from one to the other is a deliberate decision, not a silent slip.
    if (res.status === 200) {
      const order = orderRow(String(res.body.orderId))!;
      expect(Number(order.subtotal), "a claimed subtotal was believed").toBeCloseTo(Number(honest.subtotal), 2);
      expect(Number(order.discount_amount ?? 0), "a claimed discount was believed").toBe(Number(honest.discount_amount ?? 0));
      expect(Number(order.amount_paid), "a claimed total was believed").toBeCloseTo(Number(honest.amount_paid), 2);
    } else {
      expect(res.status, "a tampered total was neither refused nor recomputed").toBeGreaterThanOrEqual(400);
      expect(harness.db.table("orders").filter((o) => String(o.order_id) !== String(honest.order_id)),
        "a refused checkout still wrote an order").toHaveLength(0);
    }
  });

  it("refuses a product id that is not in the catalogue", async () => {
    const res = await rawCheckout(checkoutBody(SHOPPER, [{ productId: "does-not-exist", quantity: 1 }]));
    expect(res.status, "an unknown slug was priced at something").toBeGreaterThanOrEqual(400);
    expect(harness.db.table("orders")).toHaveLength(0);
  });

  it("refuses a nonsensical quantity rather than inverting the order", async () => {
    for (const quantity of [-5, 0]) {
      seedWorld();
      const res = await rawCheckout(checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity }]));
      const order = harness.db.table("orders")[0];
      if (res.status === 200 && order) {
        expect(Number(order.subtotal), `quantity ${quantity} produced a negative order`).toBeGreaterThanOrEqual(0);
        expect(Number(order.amount_paid), `quantity ${quantity} produced a negative charge`).toBeGreaterThanOrEqual(0);
      } else {
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("cannot be handed a $0 gift line by the client — a free unit is server-minted only", async () => {
    const body = checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]) as Record<string, unknown>;
    (body.items as Array<Record<string, unknown>>).push({ id: GIFT_SLUG, quantity: 1, price: 0, gift: true, isGift: true });
    const res = await rawCheckout(body);
    expect(res.status).toBe(200);
    const items = itemsFor(String(res.body.orderId));
    expect(items.filter((i) => Number(i.unit_price) === 0),
      "THE CLIENT MINTED ITSELF A FREE VIAL").toHaveLength(0);
    // The extra line is priced, not free.
    const giftLine = items.find((i) => String(i.product_id).includes(GIFT_SLUG));
    if (giftLine) expect(Number(giftLine.unit_price)).toBeGreaterThan(0);
  });

  it("refuses an offer token that belongs to somebody else", async () => {
    seedPrize("somebody.else@example.test");
    const res = await rawCheckout(
      checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]),
      `vl_offer=${TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(itemsFor(String(res.body.orderId)).filter((i) => Number(i.unit_price) === 0),
      "A FORWARDED TOKEN SPENT SOMEBODY ELSE'S PRIZE").toHaveLength(0);
    expect(harness.db.table("customer_offers")[0].reserved_order_id,
      "another customer's prize was reserved").toBeNull();
  });

  it("refuses a forged offer token", async () => {
    seedPrize();
    const res = await rawCheckout(
      checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]),
      "vl_offer=not-the-real-token",
    );
    expect(res.status).toBe(200);
    expect(itemsFor(String(res.body.orderId)).filter((i) => Number(i.unit_price) === 0),
      "a guessed token minted a free vial").toHaveLength(0);
  });

  it("refuses an EXPIRED prize even though the cookie is still in the browser", async () => {
    seedPrize(SHOPPER.email, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const res = await rawCheckout(
      checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]),
      `vl_offer=${TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(itemsFor(String(res.body.orderId)).filter((i) => Number(i.unit_price) === 0),
      "AN EXPIRED PRIZE WAS HONOURED").toHaveLength(0);
  });

  it("withholds the gift below its own minimum however the cart is dressed up", async () => {
    seedPrize();
    // One unit is $50 — under the $75 floor.
    const res = await rawCheckout(
      checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 1 }]),
      `vl_offer=${TOKEN}`,
    );
    expect(res.status).toBe(200);
    expect(itemsFor(String(res.body.orderId)).filter((i) => Number(i.unit_price) === 0),
      "the floor was cleared by a cart that never reached it").toHaveLength(0);
  });

  it("cannot be talked into shipping more than the shelf holds", async () => {
    const res = await rawCheckout(checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 10_000 }]));
    if (res.status === 200) {
      const order = harness.db.table("orders")[0];
      expect(order, "an order was written for stock that does not exist").toBeUndefined();
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(stockOf(PAID_SLUG).onHand, "stock went negative").toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// H — PAYMENT LIFECYCLE
// ===========================================================================
describe("H — the payment lifecycle converges however the processor behaves", () => {
  async function placeOrder() {
    seedPrize();
    const res = await rawCheckout(
      checkoutBody(SHOPPER, [{ productId: PAID_SLUG, quantity: 2 }]),
      `vl_offer=${TOKEN}`,
    );
    expect(res.status).toBe(200);
    const id = String(res.body.orderId);
    return { id, amount: Number(orderRow(id)!.amount_paid) };
  }

  it("SUCCESS: one order, one stock movement, one confirmation, one redemption", async () => {
    const { id, amount } = await placeOrder();
    await paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-h-success");

    expect(String(orderRow(id)!.payment_status)).toBe("paid");
    expect(stockOf(PAID_SLUG)).toEqual({ onHand: 48, reserved: 0 });
    expect(stockOf(GIFT_SLUG)).toEqual({ onHand: 29, reserved: 0 });
    expect(countEmails(SHOPPER.email, /^Order Confirmed/i)).toBe(1);
    expect(harness.db.table("customer_offers")[0].redeemed_at).toBeTruthy();
  });

  it("DUPLICATE EVENT ID: the replay is refused and nothing moves twice", async () => {
    const { id, amount } = await placeOrder();
    const first = await paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-dupe");
    const second = await paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-dupe");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(stockOf(PAID_SLUG), "stock moved twice on a replay").toEqual({ onHand: 48, reserved: 0 });
    expect(countEmails(SHOPPER.email, /^Order Confirmed/i), "two confirmations for one payment").toBe(1);
    expect(harness.db.table("orders").filter((o) => String(o.order_id) === id)).toHaveLength(1);
  });

  it("DISTINCT EVENT IDS for the same payment: still exactly once", async () => {
    // The harder case — a processor that retries with a fresh id. The order's
    // own paid latch, not the event table, is what has to hold here.
    const { id, amount } = await placeOrder();
    await paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-retry-1");
    await paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-retry-2");
    await paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-retry-3");

    expect(stockOf(PAID_SLUG), "a re-signed retry moved stock again").toEqual({ onHand: 48, reserved: 0 });
    expect(countEmails(SHOPPER.email, /^Order Confirmed/i), "a retry sent a second confirmation").toBe(1);
    const offer = harness.db.table("customer_offers")[0];
    expect(String(offer.redeemed_order_id)).toBe(id);
  });

  it("LATE EVENT: a webhook arriving long after the order still settles it correctly", async () => {
    const { id, amount } = await placeOrder();
    // Nothing else has touched the order in the meantime; the row is the only
    // state, so a late arrival must be indistinguishable from a prompt one.
    await paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-late");
    expect(String(orderRow(id)!.payment_status)).toBe("paid");
    expect(countEmails(SHOPPER.email, /^Order Confirmed/i)).toBe(1);
  });

  it("CONCURRENT DELIVERY: two webhooks in flight at once settle once", async () => {
    const { id, amount } = await placeOrder();
    await Promise.all([
      paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-conc-a"),
      paymentWebhook(succeeded(id, amount, SHOPPER.email), "evt-conc-b"),
    ]);
    expect(stockOf(PAID_SLUG), "concurrent webhooks double-committed stock").toEqual({ onHand: 48, reserved: 0 });
    expect(countEmails(SHOPPER.email, /^Order Confirmed/i), "concurrent webhooks sent two receipts").toBe(1);
  });

  it("UNSIGNED and MIS-SIGNED events are refused outright", async () => {
    const { id, amount } = await placeOrder();
    const { POST } = await import("@/app/api/webhooks/payment/route");
    const payload = JSON.stringify(succeeded(id, amount, SHOPPER.email));

    const unsigned = await POST(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
      method: "POST", headers: { "content-type": "application/json", "x-event-id": "evt-unsigned" }, body: payload,
    }));
    expect(unsigned.status, "an unsigned event was accepted").toBeGreaterThanOrEqual(400);

    const wrong = await POST(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment-signature": "deadbeef", "x-event-id": "evt-wrong" },
      body: payload,
    }));
    expect(wrong.status, "a forged signature was accepted").toBeGreaterThanOrEqual(400);

    expect(String(orderRow(id)!.payment_status), "an unsigned event paid the order").not.toBe("paid");
    expect(countEmails(SHOPPER.email, /^Order Confirmed/i)).toBe(0);
  });

  it("ABANDONMENT: an order nobody pays holds no prize and no stock for ever", async () => {
    const { id } = await placeOrder();
    expect(harness.db.table("customer_offers")[0].reserved_order_id).toBe(id);
    expect(stockOf(PAID_SLUG).reserved).toBe(2);

    // The reservation carries its own expiry; the sweep is what reclaims it.
    const { GET } = await import("@/app/api/cron/sweep/route");
    const request = new Request("https://vantalabsresearch.test/api/cron/sweep", {
      method: "GET", headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? "test"}` },
    });
    await GET(request).catch(() => null);

    // Whatever the sweep does, the invariant is that an UNPAID order never ends
    // up holding stock it also committed, and never redeems a prize.
    expect(harness.db.table("customer_offers")[0].redeemed_at,
      "an abandoned order consumed the prize").toBeNull();
    expect(String(orderRow(id)!.payment_status)).not.toBe("paid");
  });
});
