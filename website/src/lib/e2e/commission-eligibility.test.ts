import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness, seedStore, checkoutBody, WEBHOOK_SECRET, type Shopper } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// COMMISSION ELIGIBILITY — BEHAVIOUR, NOT SOURCE TEXT.
//
// Why this file exists. A sabotage sweep flipped the live guards in
// ensureCommissionRecord to `false`:
//
//     } else if (!ambassadorApproved) {      ->  } else if (false) {
//     } else if (referralProgram.commissionsPaused) { -> } else if (false) {
//
// which pays commission to a deactivated ambassador and pays it while the
// owner has commissions paused. The suite stayed GREEN. The reason is that the
// existing assertions read the FILE:
//
//     expect(webhook).toContain('"Ambassador is not active."')
//
// The sabotage removed the condition and left the string, so a money guard
// that had been deleted still looked protected. The guards themselves are
// correct — what was missing was any test that could tell.
//
// So these drive the REAL payment webhook against the shared in-memory
// database and read the commission that actually lands in referral_orders.
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

vi.unmock("@/lib/coupons");
vi.unmock("@/lib/admin-control");
vi.unmock("@/lib/catalog");
vi.unmock("@/lib/cart-recovery");
vi.unmock("@/lib/membership");

const SLUG = "alpha-peptide-10mg";
const PRODUCTS = [
  { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 12000, inventory: 40, unitCostCents: 1200, weightOz: 0.4 },
];

const BUYER: Shopper = {
  email: "commission.buyer@example.test",
  fullName: "Commission Buyer",
  address: "10 Commission Street",
  city: "Commissionville",
  state: "TX",
  postalCode: "75001",
  country: "US",
  phone: "555-0111",
};

const AMBASSADOR_ID = "amb-0001";
const CODE = "VANTATEST";

/** Put an ambassador in the database at a given status. */
function seedAmbassador(status: string) {
  harness.db.seed("ambassadors", [
    { id: AMBASSADOR_ID, status, customer_discount_percent: null, referral_code: CODE },
  ]);
}

/** Write a Control Center referral setting the way the admin UI does. */
function seedReferralControl(entries: Array<[string, unknown]>) {
  const existing = harness.db.tables.get("admin_audit_logs") ?? [];
  harness.db.seed("admin_audit_logs", [
    ...existing,
    ...entries.map(([key, value], index) => ({
      id: `control-referral-${key}`,
      action: "admin_control_upsert",
      target_table: "referral",
      target_id: key,
      metadata: { value },
      created_at: new Date(Date.now() + index).toISOString(),
    })),
  ]);
}

/** A paid order carrying an ambassador, created through the real checkout. */
async function paidReferredOrder() {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const created = await POST(new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(checkoutBody(BUYER, [{ productId: SLUG, quantity: 2 }])),
  }));
  const body = await created.json() as { orderId?: string; success?: boolean; total?: number };
  expect(created.status, `checkout failed: ${JSON.stringify(body)}`).toBe(200);
  const orderId = String(body.orderId);

  // Attach the attribution to the authoritative order row — the same place the
  // webhook reads it from, and the same columns checkout writes when a code is
  // accepted. Doing it here keeps this file about ELIGIBILITY rather than about
  // re-testing code entry, which quote-order covers.
  const rows = harness.db.tables.get("orders") ?? [];
  const order = rows.find((r) => String(r.order_id) === orderId)!;
  order.ambassador_id = AMBASSADOR_ID;
  order.referral_code = CODE;
  return { orderId, total: Number(body.total ?? 0) };
}

async function payWebhook(orderId: string, eventId: string, amount: number) {
  const { signWebhookPayload } = await import("@/lib/payment-provider");
  const { POST } = await import("@/app/api/webhooks/payment/route");
  const payload = JSON.stringify({
    type: "payment.succeeded",
    data: { object: { metadata: { orderId, order_id: orderId, customerEmail: BUYER.email }, amount, currency: "USD" } },
  });
  const response = await POST(new Request("https://vantalabsresearch.test/api/webhooks/payment", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payment-signature": signWebhookPayload(payload, WEBHOOK_SECRET),
      "x-event-id": eventId,
    },
    body: payload,
  }));
  return response.status;
}

function commissionRow() {
  return (harness.db.tables.get("referral_orders") ?? [])
    .find((r) => String(r.ambassador_id) === AMBASSADOR_ID) ?? null;
}

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, PRODUCTS);
  vi.clearAllMocks();
});

describe("a commission only accrues when the ambassador and the program are live", () => {
  it("BASELINE: an approved ambassador on a live program EARNS", async () => {
    // Without this the whole file could pass by never recording a commission
    // at all, which would make every "is zero" assertion below meaningless.
    seedAmbassador("approved");
    const { orderId, total } = await paidReferredOrder();
    expect(await payWebhook(orderId, "evt-baseline", total)).toBe(200);

    const row = commissionRow();
    expect(row, "no commission row was written — the rest of this file proves nothing").not.toBeNull();
    expect(Number(row!.commission_amount)).toBeGreaterThan(0);
    expect(Number(row!.commission_percent)).toBe(10);
    expect(row!.ineligible_reason).toBeNull();
  });

  for (const status of ["pending", "disabled", "rejected", "info_requested"]) {
    it(`an ambassador whose status is "${status}" earns NOTHING`, async () => {
      seedAmbassador(status);
      const { orderId, total } = await paidReferredOrder();
      expect(await payWebhook(orderId, `evt-${status}`, total)).toBe(200);

      const row = commissionRow();
      expect(row).not.toBeNull();
      expect(Number(row!.commission_amount)).toBe(0);
      expect(Number(row!.commission_percent)).toBe(0);
      expect(String(row!.ineligible_reason)).toMatch(/not active/i);
    });
  }

  it("an ambassador who vanishes from the table entirely earns NOTHING", async () => {
    // No seedAmbassador call: the row is missing, not merely inactive.
    const { orderId, total } = await paidReferredOrder();
    expect(await payWebhook(orderId, "evt-missing", total)).toBe(200);

    const row = commissionRow();
    expect(row).not.toBeNull();
    expect(Number(row!.commission_amount)).toBe(0);
    expect(String(row!.ineligible_reason)).toMatch(/not active/i);
  });

  it("PAUSED commissions earn NOTHING even for an approved ambassador", async () => {
    seedAmbassador("approved");
    seedReferralControl([["commissions_paused", true]]);
    const { orderId, total } = await paidReferredOrder();
    expect(await payWebhook(orderId, "evt-paused", total)).toBe(200);

    const row = commissionRow();
    expect(row).not.toBeNull();
    expect(Number(row!.commission_amount)).toBe(0);
    expect(String(row!.ineligible_reason)).toMatch(/paused/i);
  });

  it("a DISABLED referral program earns NOTHING", async () => {
    seedAmbassador("approved");
    seedReferralControl([["enabled", false]]);
    const { orderId, total } = await paidReferredOrder();
    expect(await payWebhook(orderId, "evt-off", total)).toBe(200);

    const row = commissionRow();
    expect(row).not.toBeNull();
    expect(Number(row!.commission_amount)).toBe(0);
    expect(String(row!.ineligible_reason)).toMatch(/disabled/i);
  });

  it("the Control Center commission rate is what actually gets paid", async () => {
    seedAmbassador("approved");
    seedReferralControl([["default_commission_percent", 12]]);
    const { orderId, total } = await paidReferredOrder();
    expect(await payWebhook(orderId, "evt-rate", total)).toBe(200);

    const row = commissionRow();
    expect(Number(row!.commission_percent)).toBe(12);
  });

  it("an order below the minimum qualifying subtotal earns NOTHING", async () => {
    // The seeded minimum is 100; one $120 unit clears it, so drop to a cart
    // that cannot. Uses its own cheap product so the rest of the file is
    // unaffected.
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 1000, inventory: 40, unitCostCents: 200, weightOz: 0.4 },
    ]);
    seedAmbassador("approved");
    const { orderId, total } = await paidReferredOrder();
    expect(await payWebhook(orderId, "evt-min", total)).toBe(200);

    const row = commissionRow();
    expect(row).not.toBeNull();
    expect(Number(row!.commission_amount)).toBe(0);
    expect(String(row!.ineligible_reason)).toMatch(/minimum qualifying order/i);
  });
});

// ===========================================================================
// The CHECKOUT-side referral guards. The webhook guards above decide what the
// ambassador is paid; these decide what the CUSTOMER pays, so an unqualifying
// cart getting 10% off is a straight loss even when no commission accrues.
// Sabotaging the minimum-order check in quote-order left the suite green, so
// none of this was covered by behaviour either.
describe("checkout refuses a referral code that should not apply", () => {
  async function checkoutWithCode(code: string, quantity: number) {
    const { POST } = await import("@/app/api/checkout/create-session/route");
    const body = checkoutBody(BUYER, [{ productId: SLUG, quantity }]) as Record<string, unknown>;
    body.referralCode = code;
    const response = await POST(new Request("https://vantalabsresearch.test/api/checkout/create-session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("BASELINE: a qualifying cart with a live code is accepted and discounted", async () => {
    seedAmbassador("approved");
    const result = await checkoutWithCode(CODE, 2);
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const order = (harness.db.tables.get("orders") ?? [])[0];
    expect(Number(order.discount_amount)).toBeGreaterThan(0);
    expect(String(order.referral_code)).toBe(CODE);
  });

  it("refuses a cart below the minimum qualifying subtotal", async () => {
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 1000, inventory: 40, unitCostCents: 200, weightOz: 0.4 },
    ]);
    seedAmbassador("approved");

    const result = await checkoutWithCode(CODE, 1);
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toMatch(/minimum merchandise subtotal/i);
    // and nothing was created at a discount it did not qualify for
    expect(harness.db.tables.get("orders") ?? []).toHaveLength(0);
  });

  // A stale or unknown code is DROPPED, not rejected: quote-order swallows the
  // lookup error deliberately so a code that went bad after the shopper applied
  // it cannot hard-block a legitimate sale. The invariant that matters is
  // therefore not "the order is refused" but "no undeserved discount is given
  // and no attribution is recorded".
  for (const [label, status] of [
    ["not approved", "disabled"],
    ["still pending", "pending"],
    ["rejected", "rejected"],
  ]) {
    it(`drops a code whose ambassador is ${label} — sale completes at FULL price`, async () => {
      seedAmbassador(status);
      const result = await checkoutWithCode(CODE, 2);
      expect(result.status).toBe(200);

      const order = (harness.db.tables.get("orders") ?? [])[0];
      expect(Number(order.discount_amount ?? 0)).toBe(0);
      expect(order.referral_code ?? null).toBeNull();
      expect(order.ambassador_id ?? null).toBeNull();
    });
  }

  it("drops a code that does not exist — sale completes at FULL price", async () => {
    seedAmbassador("approved");
    const result = await checkoutWithCode("NOSUCHCODE", 2);
    expect(result.status).toBe(200);

    const order = (harness.db.tables.get("orders") ?? [])[0];
    expect(Number(order.discount_amount ?? 0)).toBe(0);
    expect(order.referral_code ?? null).toBeNull();
    expect(order.ambassador_id ?? null).toBeNull();
  });

  it("refuses the ambassador's own code on their own order", async () => {
    harness.db.seed("ambassadors", [
      { id: AMBASSADOR_ID, status: "approved", customer_discount_percent: null, referral_code: CODE, email: BUYER.email },
    ]);
    const result = await checkoutWithCode(CODE, 2);
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toMatch(/your own referral code/i);
  });
});
