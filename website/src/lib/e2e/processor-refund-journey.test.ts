import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness, seedStore, checkoutBody, WEBHOOK_SECRET, type Shopper } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// A PROCESSOR-INITIATED REFUND, END TO END, THROUGH THE REAL WEBHOOK ROUTE.
//
// The unit tests around resolveRefundOutcome prove the arithmetic. This proves
// the SEAM: a real signed refund.completed reaching /api/webhooks/payment, the
// real payment-webhook module, and the real membership + store-credit modules,
// joined only by the shared database — the same way production joins them.
//
// What it certifies (VL-20 / REF-01):
//
//   a $12 refund on a $141 order returns $12. It does not return the customer's
//   store credit, does not restore the points they spent, does not claw back
//   the points they earned, and does not put the goods back on the shelf.
//
//   the REMAINDER refund does all four, exactly once, because the cumulative
//   total is what decides full versus partial.
//
// Every one of those effects writes ONE row per order, so a partial that fires
// them is not a smaller mistake than a full one — it is a permanent one: the
// later full refund finds the row already there and does nothing.
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
  sendEmail: async (input: { to: string; subject: string; html: string; text?: string }) => {
    harness.emails.push({ to: input.to, subject: input.subject, html: input.html, text: input.text ?? "" });
    return { success: true };
  },
}));
vi.mock("@/lib/shippo/client", () => ({
  shippoRequest: async () => ({ ok: true, data: {} }),
  isShippoConfigured: () => false,
}));

const BUYER: Shopper = {
  email: "refund.buyer@example.test",
  fullName: "Refund Buyer",
  address: "10 Return Street",
  city: "Returnville",
  state: "TX",
  postalCode: "75001",
  country: "US",
  phone: "555-0111",
};

const USER_ID = "22222222-2222-2222-2222-222222222222";
const SLUG = "alpha-peptide-10mg";
const PRODUCTS = [
  { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 4499, inventory: 40, unitCostCents: 1200, weightOz: 0.4 },
];

/** Points the order earned, and points + store credit the customer spent. */
const POINTS_EARNED = 300;
const POINTS_SPENT = 200;
const CREDIT_SPENT_CENTS = 1000;

async function postPaymentWebhook(event: Record<string, unknown>, eventId: string) {
  const { signWebhookPayload } = await import("@/lib/payment-provider");
  const { POST } = await import("@/app/api/webhooks/payment/route");
  const payload = JSON.stringify(event);
  const response = await POST(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
      "x-event-id": eventId,
    },
    body: payload,
  }));
  // The webhook defers work with after(); let the microtasks drain.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/**
 * A PAID order that spent points and store credit, created through the real
 * checkout + payment webhook.
 *
 * The account-tied tender is attached to the order row and its ledgers
 * afterwards: checkout here is a guest flow, and what this file is about is what
 * the REFUND does with tender that is already recorded.
 */
async function paidOrderWithTender() {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const created = await POST(new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(checkoutBody(BUYER, [{ productId: SLUG, quantity: 3 }])),
  }));
  const body = await created.json() as Record<string, unknown>;
  const orderId = String(body.orderId);
  const amount = Number(body.total);

  await postPaymentWebhook({
    type: "payment.succeeded",
    orderId,
    amount,
    data: { object: { metadata: { orderId, order_id: orderId }, amount, currency: "USD" } },
  }, `evt-paid-${orderId}`);

  const row = harness.db.table("orders").find((o) => o.order_id === orderId)!;
  row.customer_user_id = USER_ID;
  row.points_earned = POINTS_EARNED;
  row.points_redeemed = POINTS_SPENT;
  row.store_credit_redeemed_cents = CREDIT_SPENT_CENTS;

  harness.db.table("points_ledger").push({
    id: "pl-redeem", user_id: USER_ID, amount: -POINTS_SPENT, reason: "redeem",
    order_id: orderId, created_at: new Date().toISOString(),
  });
  harness.db.table("store_credit_ledger").push({
    id: "scl-redeem", user_id: USER_ID, amount_cents: -CREDIT_SPENT_CENTS,
    reason: "membership_redemption", order_id: orderId, created_at: new Date().toISOString(),
  });

  harness.emails.length = 0;
  return { orderId, amount };
}

function refundEvent(orderId: string, amount: number) {
  return {
    type: "refund.completed",
    orderId,
    amount,
    data: { object: { metadata: { orderId, order_id: orderId }, amount, currency: "USD" } },
  };
}

const ledger = (reason: string) =>
  harness.db.table("points_ledger").filter((row) => String(row.reason) === reason);
const creditLedger = (reason: string) =>
  harness.db.table("store_credit_ledger").filter((row) => String(row.reason) === reason);
const orderRow = (orderId: string) =>
  harness.db.table("orders").find((row) => row.order_id === orderId)!;
const onHand = () => Number(harness.db.findOne("products", "slug", SLUG)?.inventory_quantity ?? 0);

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, PRODUCTS);
  vi.clearAllMocks();
});

describe("a partial refund returns the money and nothing else", () => {
  it("records the partial without touching points, credit or stock", async () => {
    const { orderId, amount } = await paidOrderWithTender();
    const stockAfterSale = onHand();

    const { status } = await postPaymentWebhook(refundEvent(orderId, 12), `evt-partial-${orderId}`);
    expect(status).toBe(200);

    const row = orderRow(orderId);
    expect(String(row.payment_status)).toBe("partially_refunded");
    expect(Number(row.refund_amount)).toBeCloseTo(12, 2);
    expect(amount).toBeGreaterThan(12); // it really is a partial

    // The four all-or-nothing effects: none of them ran.
    expect(ledger("order_refund_reversal")).toHaveLength(0);
    expect(ledger("order_refund_points_restore")).toHaveLength(0);
    expect(creditLedger("membership_redemption_refund")).toHaveLength(0);
    expect(onHand()).toBe(stockAfterSale);
  });

  it("keeps the customer's spent points and store credit spent", async () => {
    const { orderId } = await paidOrderWithTender();
    await postPaymentWebhook(refundEvent(orderId, 12), `evt-partial2-${orderId}`);

    // Balances move only by what the refund actually returned: nothing here.
    const points = harness.db.table("points_ledger")
      .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
    const credit = harness.db.table("store_credit_ledger")
      .reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0);
    expect(points).toBe(-POINTS_SPENT);
    expect(credit).toBe(-CREDIT_SPENT_CENTS);
  });
});

describe("the refund that completes the return", () => {
  it("runs every all-or-nothing effect once, and restocks", async () => {
    const { orderId, amount } = await paidOrderWithTender();
    const stockAfterSale = onHand();

    await postPaymentWebhook(refundEvent(orderId, 12), `evt-p1-${orderId}`);
    await postPaymentWebhook(refundEvent(orderId, amount - 12), `evt-p2-${orderId}`);

    const row = orderRow(orderId);
    expect(String(row.payment_status)).toBe("refunded");

    expect(ledger("order_refund_reversal")).toHaveLength(1);
    expect(ledger("order_refund_reversal")[0].amount).toBe(-POINTS_EARNED);
    expect(ledger("order_refund_points_restore")).toHaveLength(1);
    expect(ledger("order_refund_points_restore")[0].amount).toBe(POINTS_SPENT);

    const returned = creditLedger("membership_redemption_refund");
    expect(returned).toHaveLength(1);
    expect(Number(returned[0].amount_cents)).toBe(CREDIT_SPENT_CENTS);

    expect(onHand()).toBe(stockAfterSale + 3);
  });

  it("does not repeat any of them for a second refund event", async () => {
    const { orderId, amount } = await paidOrderWithTender();
    const stockAfterSale = onHand();

    await postPaymentWebhook(refundEvent(orderId, amount), `evt-full-${orderId}`);
    // A chargeback lands afterwards with a DIFFERENT event id, so the event
    // claim cannot catch it — the terminal-status guard has to.
    await postPaymentWebhook({
      type: "chargeback.lost",
      orderId,
      amount,
      data: { object: { metadata: { orderId, order_id: orderId }, amount } },
    }, `evt-chargeback-${orderId}`);

    expect(ledger("order_refund_reversal")).toHaveLength(1);
    expect(ledger("order_refund_points_restore")).toHaveLength(1);
    expect(creditLedger("membership_redemption_refund")).toHaveLength(1);
    expect(onHand()).toBe(stockAfterSale + 3);
  });
});
