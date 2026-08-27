import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness, seedStore, checkoutBody, WEBHOOK_SECRET, type Shopper } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// VANTA RECORDS THE REIMBURSEMENT. VANTA DOES NOT SEND IT.
//
// The workflow this file certifies is entirely manual on the money side:
//
//   customer emails support -> owner authorises the return -> the sealed vial
//   comes back -> the owner inspects it -> THE OWNER SENDS THE MONEY HIMSELF
//   (Zelle / Cash App) -> the owner records that it happened here.
//
// So the invariants are unusual, and every one of them is about something NOT
// happening: no payment API is called, no stock returns to the shelf, no
// second record for one payment, and no email that claims a card was credited.
//
// Driven through the real admin route against the shared in-memory database,
// with the payment provider watched rather than stubbed away — the point is to
// prove the refund endpoint is never reached, so it has to be reachable.
// ---------------------------------------------------------------------------

process.env.PAYMENT_PROVIDER = "mock";
process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.ALLOW_MOCK_PAYMENTS = "true";
process.env.NEXT_PUBLIC_SITE_URL = "https://vantalabsresearch.test";

const refundPayment = vi.fn(async () => {});

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
  sendEmail: async (input: { to: string; subject: string; html: string; text: string }) => {
    if (harness.emailFailures > 0) {
      harness.emailFailures -= 1;
      return { success: false, error: "provider down" };
    }
    harness.emails.push({ to: input.to, subject: input.subject, html: input.html, text: input.text ?? "" });
    return { success: true };
  },
}));

// THE PROVIDER IS WATCHED, NOT REMOVED. A test that deletes the payment client
// cannot tell "we never call it" from "it isn't there".
vi.mock("@/lib/payment-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payment-provider")>("@/lib/payment-provider");
  return {
    ...actual,
    getPaymentProvider: () => ({
      createCheckoutSession: async () => ({ paymentId: "pay_1", hostedCheckoutUrl: "https://example.test/pay" }),
      verifyWebhookSignature: actual.verifyWebhookSignatureImpl,
      processWebhookEvent: async () => {},
      refundPayment,
      retrievePaymentStatus: async () => "succeeded" as const,
    }),
  };
});

// F-11: the four refund side-effects on this lane were bare `catch {}`. Driving
// a real failure through needs one of them to actually fail.
const effectFailure = { membershipRevocation: false, storeCredit: false };
vi.mock("@/lib/membership-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/membership-billing")>();
  return {
    ...actual,
    revokeMembershipForRefund: vi.fn(async (userId: string) => {
      if (effectFailure.membershipRevocation) throw new Error("membership revoke failed");
      return actual.revokeMembershipForRefund(userId);
    }),
  };
});
vi.mock("@/lib/store-credit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store-credit")>();
  return {
    ...actual,
    refundStoreCreditForOrder: vi.fn(async (orderId: string) => {
      if (effectFailure.storeCredit) throw new Error("store credit ledger unreadable");
      return actual.refundStoreCreditForOrder(orderId);
    }),
  };
});

const ADMIN = { username: "owner", role: "super_admin" as const };
const session = vi.fn(async () => ADMIN as { username: string; role: string } | null);
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: () => session(),
  getRequestIpAddress: () => "203.0.113.9",
  getRequestUserAgent: () => "test-agent",
}));

vi.unmock("@/lib/coupons");
vi.unmock("@/lib/admin-control");
vi.unmock("@/lib/catalog");
vi.unmock("@/lib/cart-recovery");
vi.unmock("@/lib/membership");

const BUYER: Shopper = {
  email: "returns.buyer@example.test",
  fullName: "Returns Buyer",
  address: "10 Return Street",
  city: "Returnville",
  state: "TX",
  postalCode: "75001",
  country: "US",
  phone: "555-0111",
};

const SLUG = "alpha-peptide-10mg";
const PRODUCTS = [
  { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 4499, inventory: 40, unitCostCents: 1200, weightOz: 0.4 },
];

async function reimburse(orderId: string, body: Record<string, unknown> = {}) {
  const { PATCH } = await import("@/app/api/admin/orders/[orderId]/route");
  const request = new Request(`https://vantalabsresearch.test/api/admin/orders/${orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "refund", reimbursementMethod: "zelle", ...body }),
  });
  const response = await PATCH(request, { params: Promise.resolve({ orderId }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** A delivered order, created and paid through the real checkout + webhook. */
async function deliveredOrder() {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const created = await POST(new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(checkoutBody(BUYER, [{ productId: SLUG, quantity: 3 }])),
  }));
  const body = await created.json() as Record<string, unknown>;
  const orderId = String(body.orderId);

  const { signWebhookPayload } = await import("@/lib/payment-provider");
  const { POST: webhook } = await import("@/app/api/webhooks/payment/route");
  const payload = JSON.stringify({
    type: "payment.succeeded",
    data: { object: { metadata: { orderId, order_id: orderId }, amount: Number(body.total), currency: "USD" } },
  });
  await webhook(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
      "x-event-id": `evt-${orderId}`,
    },
    body: payload,
  }));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();

  // The parcel was delivered. Nothing about a return may undo that.
  const row = harness.db.table("orders").find((o) => o.order_id === orderId)!;
  row.fulfillment_status = "delivered";
  row.delivered_at = "2026-08-20T15:00:00.000Z";
  row.tracking_number = "TRKRETURN0001";
  row.shipping_carrier = "USPS";

  harness.emails.length = 0; // drop the confirmation; this file is about what follows
  return { orderId, amount: Number(body.total) };
}

function order(orderId: string) {
  return harness.db.findOne("orders", "order_id", orderId);
}

function stock() {
  const row = harness.db.findOne("products", "slug", SLUG);
  return { onHand: Number(row?.inventory_quantity ?? 0), reserved: Number(row?.reserved_quantity ?? 0) };
}

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, PRODUCTS);
  vi.clearAllMocks();
  session.mockResolvedValue(ADMIN);
  effectFailure.membershipRevocation = false;
  effectFailure.storeCredit = false;
});

// ===========================================================================
describe("recording a reimbursement moves no money", () => {
  it("never calls the payment provider's refund endpoint", async () => {
    const { orderId } = await deliveredOrder();

    const { status, body } = await reimburse(orderId, { refundAmount: 50 });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // THE INVARIANT. Veyra is not asked to refund anything, ever, on this path.
    expect(refundPayment).not.toHaveBeenCalled();
    expect(body.providerRefunded).toBe(false);
  });

  it("says so in the response, in words an owner cannot misread", async () => {
    const { orderId } = await deliveredOrder();
    const { body } = await reimburse(orderId, { refundAmount: 50 });
    expect(String(body.message)).toMatch(/did not send any money/i);
  });

  it("records the method and the note without storing any account detail", async () => {
    const { orderId } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: 50, reimbursementMethod: "cashapp", note: "Seal intact" });

    const audit = harness.db.rows("admin_audit_logs").find((row) => row.action === "order_refund");
    const metadata = audit?.metadata as Record<string, unknown>;
    expect(metadata.reimbursementMethod).toBe("cashapp");
    expect(metadata.note).toBe("Seal intact");
    expect(metadata.providerRefunded).toBe(false);
    expect(metadata.performedBy).toBe("owner");
  });

  it("rejects a made-up method rather than storing free text", async () => {
    const { orderId } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: 50, reimbursementMethod: "routing 021000021 acct 12345" });

    const audit = harness.db.rows("admin_audit_logs").find((row) => row.action === "order_refund");
    expect((audit?.metadata as Record<string, unknown>).reimbursementMethod).toBe("other");
  });
});

// ===========================================================================
describe("amounts", () => {
  it("records a partial reimbursement and leaves the order partially refunded", async () => {
    const { orderId } = await deliveredOrder();

    await reimburse(orderId, { refundAmount: 41.39 });

    const row = order(orderId);
    expect(Number(row?.refund_amount)).toBeCloseTo(41.39, 2);
    expect(row?.payment_status).toBe("partially_refunded");
  });

  it("records a full reimbursement", async () => {
    const { orderId, amount } = await deliveredOrder();

    await reimburse(orderId, { refundAmount: amount });

    expect(order(orderId)?.payment_status).toBe("refunded");
  });

  it("accumulates two genuine partials", async () => {
    const { orderId } = await deliveredOrder();

    await reimburse(orderId, { refundAmount: 20 });
    await reimburse(orderId, { refundAmount: 15 });

    expect(Number(order(orderId)?.refund_amount)).toBeCloseTo(35, 2);
  });

  it("REFUSES to reimburse more than the customer paid", async () => {
    const { orderId, amount } = await deliveredOrder();

    const { status, body } = await reimburse(orderId, { refundAmount: amount + 0.01 });

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/between/i);
    expect(Number(order(orderId)?.refund_amount ?? 0)).toBe(0);
  });

  it("REFUSES a second reimbursement that would exceed the remainder", async () => {
    const { orderId, amount } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: amount - 10 });

    const { status } = await reimburse(orderId, { refundAmount: 50 });

    expect(status).toBe(400);
    expect(Number(order(orderId)?.refund_amount)).toBeCloseTo(amount - 10, 2);
  });

  it("refuses anything once the order is fully reimbursed", async () => {
    const { orderId, amount } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: amount });

    const { status, body } = await reimburse(orderId, { refundAmount: 1 });

    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/already been fully/i);
  });
});

// ===========================================================================
describe("one payment, one record", () => {
  it("a double-click records ONE reimbursement", async () => {
    const { orderId } = await deliveredOrder();

    const [first, second] = await Promise.all([
      reimburse(orderId, { refundAmount: 50 }),
      reimburse(orderId, { refundAmount: 50 }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.status === 200)).toHaveLength(1);
    expect(Number(order(orderId)?.refund_amount)).toBeCloseTo(50, 2);
  });

  it("three concurrent requests record ONE reimbursement", async () => {
    const { orderId } = await deliveredOrder();

    const results = await Promise.all([
      reimburse(orderId, { refundAmount: 40 }),
      reimburse(orderId, { refundAmount: 40 }),
      reimburse(orderId, { refundAmount: 40 }),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(Number(order(orderId)?.refund_amount)).toBeCloseTo(40, 2);
    // Two tabs must not double-deduct revenue or double-email the customer.
    expect(harness.emails).toHaveLength(1);
  });

  it("tells the loser it was already recorded rather than failing silently", async () => {
    const { orderId } = await deliveredOrder();
    const results = await Promise.all([
      reimburse(orderId, { refundAmount: 40 }),
      reimburse(orderId, { refundAmount: 40 }),
    ]);
    const loser = results.find((r) => r.status !== 200);
    expect(loser?.status).toBe(409);
    expect(String(loser?.body.error)).toMatch(/already recorded/i);
  });

  it("writes exactly one audit row for one payment", async () => {
    const { orderId } = await deliveredOrder();
    await Promise.all([
      reimburse(orderId, { refundAmount: 50 }),
      reimburse(orderId, { refundAmount: 50 }),
    ]);
    expect(harness.db.rows("admin_audit_logs").filter((r) => r.action === "order_refund")).toHaveLength(1);
  });
});

// ===========================================================================
describe("returned stock does NOT go back on the shelf", () => {
  it("leaves inventory untouched on a partial reimbursement", async () => {
    const { orderId } = await deliveredOrder();
    const before = stock();

    await reimburse(orderId, { refundAmount: 41.39 });

    expect(stock()).toEqual(before);
  });

  it("leaves inventory untouched on a FULL reimbursement", async () => {
    // The behaviour the owner asked for: a vial that spent a week in a mailbox
    // is not automatically saleable again just because the money was recorded.
    const { orderId, amount } = await deliveredOrder();
    expect(stock().onHand).toBe(37);

    await reimburse(orderId, { refundAmount: amount });

    expect(stock().onHand).toBe(37);
  });

  it("does not consume the restock claim, so a later decision is still possible", async () => {
    const { orderId, amount } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: amount });
    expect(order(orderId)?.inventory_restocked_at ?? null).toBeNull();
  });
});

// ===========================================================================
describe("the delivery record survives", () => {
  it("keeps the order delivered, with its tracking and timestamp", async () => {
    const { orderId, amount } = await deliveredOrder();

    await reimburse(orderId, { refundAmount: amount });

    const row = order(orderId);
    expect(row?.fulfillment_status).toBe("delivered");
    expect(row?.delivered_at).toBe("2026-08-20T15:00:00.000Z");
    expect(row?.tracking_number).toBe("TRKRETURN0001");
    expect(row?.shipping_carrier).toBe("USPS");
  });

  it("writes no fulfillment history row — a return is not a shipping event", async () => {
    const { orderId, amount } = await deliveredOrder();
    const before = harness.db.rows("order_status_history").length;

    await reimburse(orderId, { refundAmount: amount });

    expect(harness.db.rows("order_status_history")).toHaveLength(before);
  });
});

// ===========================================================================
describe("the customer is told once, and told the truth", () => {
  it("sends exactly one confirmation email", async () => {
    const { orderId } = await deliveredOrder();

    await reimburse(orderId, { refundAmount: 50 });

    expect(harness.emails).toHaveLength(1);
    expect(harness.emails[0].to).toBe(BUYER.email);
    expect(harness.emails[0].subject).toMatch(/^Reimbursement processed/);
  });

  it("never claims the money went back to their card", async () => {
    const { orderId } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: 50 });

    const email = harness.emails[0];
    for (const lie of [/original payment method/i, /back to your card/i, /5.10 business days/i]) {
      expect(email.html).not.toMatch(lie);
      expect(email.text).not.toMatch(lie);
    }
  });

  it("names no payment processor and no payment handle", async () => {
    const { orderId } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: 50, reimbursementMethod: "zelle", note: "internal only" });

    const email = harness.emails[0];
    const everything = `${email.html}${email.text}`;
    expect(everything).not.toMatch(/veyra/i);
    expect(everything).not.toMatch(/zelle/i);
    expect(everything).not.toMatch(/cash app/i);
    // The internal note is for the audit trail, not for the customer.
    expect(everything).not.toContain("internal only");
  });

  it("leaks no cost, margin or private origin", async () => {
    const { orderId } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: 50 });

    const everything = `${harness.emails[0].html}${harness.emails[0].text}`;
    expect(everything).not.toContain("1 Synthetic Origin Way");
    // Internal money words, not CSS: the layout legitimately contains
    // `margin:0`, so match the accounting sense rather than the substring.
    expect(everything).not.toMatch(/\bCOGS\b|profit|gross margin|unit cost|postage cost/i);
  });

  it("queues the email for retry when the provider is down, and still records the money", async () => {
    const { orderId } = await deliveredOrder();
    harness.emailFailures = 1;

    const { status } = await reimburse(orderId, { refundAmount: 50 });

    expect(status).toBe(200);
    expect(Number(order(orderId)?.refund_amount)).toBeCloseTo(50, 2);
    expect(harness.db.rows("pending_emails")).toHaveLength(1);
  });
});

// ===========================================================================
describe("only the right people can record one", () => {
  it("refuses an anonymous caller", async () => {
    const { orderId } = await deliveredOrder();
    session.mockResolvedValue(null);

    const { status } = await reimburse(orderId, { refundAmount: 50 });

    expect(status).toBe(401);
    expect(Number(order(orderId)?.refund_amount ?? 0)).toBe(0);
    expect(harness.emails).toHaveLength(0);
  });

  it("refuses a staff account — this changes the books", async () => {
    const { orderId } = await deliveredOrder();
    session.mockResolvedValue({ username: "packer", role: "staff" });

    const { status } = await reimburse(orderId, { refundAmount: 50 });

    expect(status).toBe(403);
    expect(Number(order(orderId)?.refund_amount ?? 0)).toBe(0);
  });

  it("allows a manager", async () => {
    const { orderId } = await deliveredOrder();
    session.mockResolvedValue({ username: "manager", role: "manager" });

    const { status } = await reimburse(orderId, { refundAmount: 50 });

    expect(status).toBe(200);
  });

  // The two guards below sit on the same route and the same role check, and
  // both move real money — a replacement ships free goods, and a payment-status
  // override rewrites what the books say was collected. Neither had a test: a
  // sabotage sweep removed each authorization check in turn and the whole suite
  // stayed green, so the guards were correct but unproven.
  it("refuses a staff account sending a REPLACEMENT — this ships free goods", async () => {
    const { orderId } = await deliveredOrder();
    session.mockResolvedValue({ username: "packer", role: "staff" });

    const { PATCH } = await import("@/app/api/admin/orders/[orderId]/route");
    const response = await PATCH(new Request(`https://vantalabsresearch.test/api/admin/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "send_replacement", replacementReason: "damaged", idempotencyKey: "rp-staff-1" }),
    }), { params: Promise.resolve({ orderId }) });

    expect(response.status).toBe(403);
    // and no replacement order materialised
    expect(harness.db.rows("orders").filter((row) => String(row.order_id).includes("-rp-"))).toHaveLength(0);
  });

  it("allows a manager to send a replacement", async () => {
    const { orderId } = await deliveredOrder();
    session.mockResolvedValue({ username: "manager", role: "manager" });

    const { PATCH } = await import("@/app/api/admin/orders/[orderId]/route");
    const response = await PATCH(new Request(`https://vantalabsresearch.test/api/admin/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "send_replacement", replacementReason: "damaged", idempotencyKey: "rp-mgr-1" }),
    }), { params: Promise.resolve({ orderId }) });

    // Not a 403 is the point — whatever else this route decides is elsewhere's
    // business, but it must not be refused for authorization.
    expect(response.status).not.toBe(403);
  });

  it("refuses a staff account OVERRIDING payment status — this rewrites the books", async () => {
    const { orderId } = await deliveredOrder();
    session.mockResolvedValue({ username: "packer", role: "staff" });
    const before = order(orderId)?.payment_status;

    const { PATCH } = await import("@/app/api/admin/orders/[orderId]/route");
    const response = await PATCH(new Request(`https://vantalabsresearch.test/api/admin/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // A NON-money status on purpose: "paid"/"refunded"/"partially_refunded"
      // are rejected for EVERY role by a second guard below the role check, so
      // using one of those could not tell an authorization failure from that
      // blanket rejection.
      body: JSON.stringify({ action: "update_status", paymentStatus: "pending" }),
    }), { params: Promise.resolve({ orderId }) });

    expect(response.status).toBe(403);
    expect(order(orderId)?.payment_status).toBe(before);
  });

  it("allows a manager to change a non-money payment status", async () => {
    const { orderId } = await deliveredOrder();
    session.mockResolvedValue({ username: "manager", role: "manager" });

    const { PATCH } = await import("@/app/api/admin/orders/[orderId]/route");
    const response = await PATCH(new Request(`https://vantalabsresearch.test/api/admin/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update_status", paymentStatus: "pending" }),
    }), { params: Promise.resolve({ orderId }) });

    expect(response.status).not.toBe(403);
  });

  it("NOBODY may set a money status here, not even a super admin", async () => {
    // Defence in depth behind the role gate: these transitions must run their
    // dedicated flows (commissions, points, emails), so the column may never be
    // written directly regardless of who is asking.
    for (const status of ["paid", "refunded", "partially_refunded"]) {
      const { orderId } = await deliveredOrder();
      session.mockResolvedValue({ username: "owner", role: "super_admin" });
      const before = order(orderId)?.payment_status;

      const { PATCH } = await import("@/app/api/admin/orders/[orderId]/route");
      const response = await PATCH(new Request(`https://vantalabsresearch.test/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "update_status", paymentStatus: status }),
      }), { params: Promise.resolve({ orderId }) });

      expect(response.status, `${status} must be refused`).toBe(400);
      expect(order(orderId)?.payment_status).toBe(before);
    }
  });
});

// ===========================================================================
describe("the books", () => {
  it("deducts the reimbursement from revenue and leaves the costs incurred", async () => {
    const { orderId } = await deliveredOrder();
    const { getOrderProfit } = await import("@/lib/admin-profit");
    const before = await getOrderProfit(orderId);

    await reimburse(orderId, { refundAmount: 50 });
    const after = await getOrderProfit(orderId);

    // Revenue drops by exactly the reimbursement...
    expect(after!.revenue).toBeCloseTo(before!.revenue - 50, 2);
    // ...and the money already spent on the parcel is still spent.
    expect(after!.cogs).toBeCloseTo(before!.cogs, 2);
    expect(after!.processingFee).toBeCloseTo(before!.processingFee, 2);
    expect(after!.shippingCost).toBeCloseTo(before!.shippingCost, 2);
    expect(after!.profit).toBeCloseTo(before!.profit - 50, 2);
  });

  it("preserves the original sale — nothing is overwritten", async () => {
    const { orderId, amount } = await deliveredOrder();
    const original = order(orderId);

    await reimburse(orderId, { refundAmount: amount });

    const row = order(orderId);
    expect(Number(row?.amount_paid)).toBeCloseTo(Number(original?.amount_paid), 2);
    expect(Number(row?.subtotal)).toBeCloseTo(Number(original?.subtotal), 2);
    expect(row?.paid_at).toBe(original?.paid_at);
    // The reimbursement is recorded ALONGSIDE it, never in place of it.
    expect(Number(row?.refund_amount)).toBeCloseTo(amount, 2);
  });

  it("reconciles a $150-style order to the cent after a partial reimbursement", async () => {
    const { orderId } = await deliveredOrder();
    const { getOrderProfit } = await import("@/lib/admin-profit");

    await reimburse(orderId, { refundAmount: 100 });
    const profit = await getOrderProfit(orderId);

    // Independently: paid 143.35, reimbursed 100.00 -> revenue 43.35.
    // Costs unchanged: COGS 36.00, postage estimate 6.00, fee 8% of 143.35.
    // 43.35 - 36.00 - 6.00 - 11.47 = -10.12
    expect(profit!.revenue).toBeCloseTo(43.35, 2);
    expect(profit!.cogs).toBeCloseTo(36, 2);
    expect(profit!.shippingCost).toBeCloseTo(6, 2);
    expect(profit!.processingFee).toBeCloseTo(11.47, 2);
    expect(profit!.profit).toBeCloseTo(-10.12, 2);
  });
});

// ===========================================================================
describe("the ambassador's commission follows the money back", () => {
  /** A paid referral order with a pending commission already recorded. */
  async function referralOrder() {
    const { orderId, amount } = await deliveredOrder();
    harness.db.table("orders").find((o) => o.order_id === orderId)!.ambassador_id = "amb-1";
    // subtotal 124.17, no discount -> commission base 124.17 at 10% = 12.42
    harness.db.seed("referral_orders", [{
      id: "ref-1",
      order_id: orderId,
      ambassador_id: "amb-1",
      payment_status: "pending",
      commission_percent: 10,
      commission_amount: 12.42,
      amount_paid: 124.17,
    }]);
    return { orderId, amount };
  }

  function commission(orderId: string) {
    return harness.db.findOne("referral_orders", "order_id", orderId);
  }

  it("reverses the commission in full when the whole order is reimbursed", async () => {
    const { orderId, amount } = await referralOrder();

    await reimburse(orderId, { refundAmount: amount });

    const row = commission(orderId);
    // Paying an ambassador on merchandise that came back and was reimbursed is
    // money out twice for one sale.
    expect(String(row?.payment_status)).toMatch(/revers|void|cancel/i);
    expect(row?.reversed_at).toBeTruthy();
  });

  it("reverses PROPORTIONALLY when only part of the order is reimbursed", async () => {
    const { orderId } = await referralOrder();

    // Half the merchandise base (124.17) returned.
    await reimburse(orderId, { refundAmount: 62.09 });

    const row = commission(orderId);
    // Roughly half of 12.42 retained; the exact figure is the pricing engine's,
    // so this asserts the DIRECTION and that it actually moved.
    const retained = Number(row?.commission_amount);
    expect(retained).toBeLessThan(12.42);
    expect(retained).toBeGreaterThan(0);
  });

  it("does not claw back commission for a shipping-only reimbursement", async () => {
    const { orderId } = await referralOrder();

    // $15 shipping refunded — merchandise untouched, so the ambassador keeps
    // what they earned on merchandise that was never returned.
    await reimburse(orderId, { refundAmount: 15 });

    const retained = Number(commission(orderId)?.commission_amount);
    expect(retained).toBeGreaterThan(10.5);
  });

  it("leaves a non-referral order's books alone", async () => {
    const { orderId, amount } = await deliveredOrder();
    await reimburse(orderId, { refundAmount: amount });
    expect(harness.db.rows("referral_orders")).toHaveLength(0);
  });
});

// ===========================================================================
// F-11 — THE ONE LANE WHERE A SWALLOWED FAILURE IS PERMANENT.
//
// Four refund side-effects here were wrapped in bare `catch {}` — no log, no
// alert, nobody told. The reimbursement claim above is single-use, so a
// swallowed failure is not retried by this route ever again. Wave 3 converted
// several previously-silent returns inside those functions into throws, which
// only moved MORE failure modes into a catch that told nobody. And
// revokeMembershipForRefund is not covered by any sweep at all, so a refunded
// member silently keeps member pricing, free shipping and their points
// multiplier.
// ===========================================================================
describe("a refund side-effect that fails is not silent", () => {
  function alerts() {
    return harness.db.table("system_alerts").filter((row) => row.type === "admin_refund_effect_failed");
  }

  it("records the money and STILL alerts when store credit cannot be returned", async () => {
    const { orderId, amount } = await deliveredOrder();
    effectFailure.storeCredit = true;

    const { status } = await reimburse(orderId, { refundAmount: amount });

    // Non-blocking: the reimbursement was already sent by hand and recorded.
    expect(status).toBe(200);
    expect(Number(order(orderId)?.refund_amount)).toBeCloseTo(amount, 2);
    const raised = alerts();
    expect(raised).toHaveLength(1);
    expect(raised[0].context).toMatchObject({ effect: "store_credit_refund", retriedAutomatically: true });
    expect(String(raised[0].severity)).toBe("critical");
  });

  it("says NOTHING RETRIES IT for the membership revocation, which no sweep covers", async () => {
    const { orderId, amount } = await deliveredOrder();
    const row = harness.db.table("orders").find((o) => o.order_id === orderId)!;
    row.order_type = "membership";
    row.customer_user_id = "user-member-1";
    effectFailure.membershipRevocation = true;

    await reimburse(orderId, { refundAmount: amount });

    const raised = alerts();
    expect(raised.map((entry) => (entry.context as { effect: string }).effect)).toContain("membership_revocation");
    const revocation = raised.find((entry) => (entry.context as { effect: string }).effect === "membership_revocation")!;
    expect(revocation.context).toMatchObject({ retriedAutomatically: false });
    expect(String(revocation.message)).toContain("NOTHING retries this one");
  });

  it("stays quiet when every effect succeeds", async () => {
    const { orderId, amount } = await deliveredOrder();

    await reimburse(orderId, { refundAmount: amount });

    expect(alerts()).toHaveLength(0);
  });
});

// ===========================================================================
// AN ORDER THE CUSTOMER SETTLED ENTIRELY IN STORE CREDIT.
//
// `remaining = max(0, amount_paid - refund_amount)` and a `remaining <= 0`
// rejection meant an order that collected NO CASH could never be refunded at
// all: the admin got "This order has already been fully refunded" on an order
// nothing had been refunded on, and the customer's credit stayed spent. With
// store credit a real tender, that is a customer who cannot be made whole.
//
// The money rules this must not break while fixing it:
//   - no cash is recorded as returned, because none was collected. refund_amount
//     stays 0, so `revenue === cash` still holds on this order.
//   - the customer is NOT emailed that a reimbursement was sent, because none
//     was. A "$0.00 reimbursement processed" email is a false statement.
//   - the ambassador's commission is reversed IN FULL. The refunded fraction
//     was measured against `newRefundTotal` — capped at the CASH amount_paid —
//     while the base is `subtotal - discount`, so a fully returned credit-settled
//     order reversed 0% of the commission (money-recert finding 12, adjacent).
// ===========================================================================
describe("an order settled entirely in store credit", () => {
  const CREDIT_USER = "user-credit-1";

  /** The delivered order, restated as one paid entirely with store credit. */
  async function creditOnlyOrder() {
    const { orderId, amount } = await deliveredOrder();
    const row = harness.db.table("orders").find((o) => o.order_id === orderId)!;
    const creditCents = Math.round(amount * 100);
    row.amount_paid = 0;
    // `refund_amount numeric not null default 0` in production, so 0 — NOT
    // null. It matters: with NULL, the compare-and-set discriminates on the
    // null->0 transition and the payment_status half of the claim is never
    // exercised. Zero is the state a real order is in.
    row.refund_amount = 0;
    row.store_credit_redeemed_cents = creditCents;
    row.customer_user_id = CREDIT_USER;
    harness.db.table("store_credit_ledger").push({
      id: "scl-redemption-1",
      user_id: CREDIT_USER,
      order_id: orderId,
      reason: "membership_redemption",
      amount_cents: -creditCents,
      created_at: new Date().toISOString(),
    });
    return { orderId, amount, creditCents };
  }

  function creditReturns(orderId: string) {
    return harness.db.rows("store_credit_ledger")
      .filter((r) => r.order_id === orderId && r.reason === "membership_redemption_refund");
  }

  it("can be refunded at all", async () => {
    const { orderId } = await creditOnlyOrder();

    const { status, body } = await reimburse(orderId);

    // Was 400 "This order has already been fully refunded" — on an order that
    // had never been refunded and had a full balance of credit to return.
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(order(orderId)?.payment_status).toBe("refunded");
  });

  it("returns the store credit to the customer", async () => {
    const { orderId, creditCents } = await creditOnlyOrder();

    await reimburse(orderId);

    const returned = creditReturns(orderId);
    expect(returned).toHaveLength(1);
    expect(Number(returned[0].amount_cents)).toBe(creditCents);
    expect(String(returned[0].user_id)).toBe(CREDIT_USER);
  });

  it("records NO cash refund, so revenue still equals cash on this order", async () => {
    const { orderId } = await creditOnlyOrder();

    const { body } = await reimburse(orderId);

    // amount_paid is 0 and refund_amount stays 0. Writing the credit's dollar
    // value into refund_amount would make netOrderRevenue report -$134 of
    // revenue on an order that collected nothing.
    expect(Number(order(orderId)?.refund_amount ?? 0)).toBe(0);
    expect(body.refundAmount).toBe(0);
    expect(body.isFullRefund).toBe(true);
  });

  it("does not email the customer that a payment was sent, because none was", async () => {
    const { orderId } = await creditOnlyOrder();

    const { body } = await reimburse(orderId);

    expect(harness.emails.filter((e) => /reimbursement/i.test(e.subject))).toHaveLength(0);
    expect(body.customerNotified).toBe(false);
    expect(String(body.message)).toMatch(/store credit/i);
  });

  it("reverses the ambassador's commission IN FULL", async () => {
    const { orderId } = await creditOnlyOrder();
    const row = harness.db.table("orders").find((o) => o.order_id === orderId)!;
    harness.db.table("referral_orders").push({
      id: "ro-credit-1",
      order_id: orderId,
      ambassador_id: "amb-credit-1",
      referral_code: "CREDIT15",
      commission_percent: 15,
      commission_amount: 20.25,
      amount_paid: Number(row.subtotal ?? 0) - Number(row.discount_amount ?? 0),
      payment_status: "pending",
    });

    await reimburse(orderId);

    // Was "pending" with the full commission intact: the refunded fraction was
    // measured against $0 of cash, so nothing was reversed on an order that was
    // returned in its entirety.
    const commission = harness.db.findOne("referral_orders", "order_id", orderId);
    expect(String(commission?.payment_status)).toBe("reversed");
  });

  it("refuses a second attempt rather than returning the credit twice", async () => {
    const { orderId } = await creditOnlyOrder();

    expect((await reimburse(orderId)).status).toBe(200);
    const second = await reimburse(orderId);

    expect(second.status).toBe(400);
    expect(creditReturns(orderId)).toHaveLength(1);
  });

  it("refuses a cash amount on an order that collected no cash", async () => {
    const { orderId } = await creditOnlyOrder();

    const { status, body } = await reimburse(orderId, { refundAmount: 25 });

    // Recording $25 of cash returned on an order that took $0 would overstate
    // refunds and drive reported revenue negative.
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/no cash/i);
    expect(order(orderId)?.payment_status).not.toBe("refunded");
  });

  it("lets exactly ONE of two simultaneous refunds through", async () => {
    // THE CLAIM HAS TO HOLD UNDER CONCURRENCY, NOT ONLY IN SEQUENCE. The
    // sequential guard above passes on the `payment_status === "refunded"` check
    // at the top of the handler, which two requests that both read the order
    // BEFORE either writes will both sail past. The compare-and-set is what
    // actually decides it — and on a credit-settled order refund_amount is 0
    // before and after, so the status is the only thing in the claim that
    // changes. Without it in the filter, both requests win.
    const { orderId } = await creditOnlyOrder();

    const [first, second] = await Promise.all([reimburse(orderId), reimburse(orderId)]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(creditReturns(orderId)).toHaveLength(1);
    expect(harness.db.rows("admin_audit_logs").filter((row) => row.action === "order_refund")).toHaveLength(1);
  });

  it("leaves a normal cash order behaving exactly as before", async () => {
    // The regression guard: none of the above may change the ordinary lane.
    const { orderId, amount } = await deliveredOrder();

    const { status } = await reimburse(orderId, { refundAmount: amount });

    expect(status).toBe(200);
    expect(Number(order(orderId)?.refund_amount)).toBeCloseTo(amount, 2);
    expect(order(orderId)?.payment_status).toBe("refunded");
    expect(harness.emails.filter((e) => /reimbursement/i.test(e.subject))).toHaveLength(1);
  });
});
