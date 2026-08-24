import { beforeEach, describe, expect, it, vi } from "vitest";

import { harness, seedStore, checkoutBody, WEBHOOK_SECRET, type Shopper } from "@/lib/e2e/journey.harness";
import { REQUIRED_CONFIRMATIONS } from "@/lib/checkout-confirmations";

// ---------------------------------------------------------------------------
// SERVER-SIDE proof of the acknowledgement gate.
//
// Button state proves nothing: anyone can POST to the checkout API directly.
// This file drives the REAL /api/checkout/create-session handler against the
// shared in-memory database and asserts the server itself refuses.
//
// It also pins the defect that shipped in 32d97c8 and was fixed in f57a3e5:
// the card lane sent three acknowledgements while the server required four, so
// every card order was rejected with a 400 before anything else ran. The
// "pre-fix payload" case below is that exact request; if it ever stops being a
// 400 the gate has been weakened, and if the current payload ever becomes a
// 400 the lanes have drifted apart again.
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
vi.mock("@/lib/payment-provider", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payment-provider")>("@/lib/payment-provider");
  return {
    ...actual,
    getPaymentProvider: () => ({
      createCheckoutSession: async () => ({ paymentId: "pay_1", hostedCheckoutUrl: "https://example.test/pay" }),
      verifyWebhookSignature: actual.verifyWebhookSignatureImpl,
      processWebhookEvent: async () => {},
      refundPayment: async () => {},
      retrievePaymentStatus: async () => "succeeded" as const,
    }),
  };
});

vi.unmock("@/lib/coupons");
vi.unmock("@/lib/admin-control");
vi.unmock("@/lib/catalog");
vi.unmock("@/lib/cart-recovery");
vi.unmock("@/lib/membership");

const SLUG = "alpha-peptide-10mg";
const PRODUCTS = [
  { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 4499, inventory: 40, unitCostCents: 1200, weightOz: 0.4 },
];

const BUYER: Shopper = {
  email: "gate.buyer@example.test",
  fullName: "Gate Buyer",
  address: "10 Gate Street",
  city: "Gateville",
  state: "TX",
  postalCode: "75001",
  country: "US",
  phone: "555-0111",
};

/** Drive the real route with a caller-controlled acknowledgement object. */
async function checkout(acknowledgements: unknown) {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const body = checkoutBody(BUYER, [{ productId: SLUG, quantity: 1 }]) as Record<string, unknown>;
  body.complianceAcknowledgements = acknowledgements;
  const response = await POST(new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const ALL_KEYS = REQUIRED_CONFIRMATIONS.map((item) => item.key);
const ALL_TRUE = Object.fromEntries(ALL_KEYS.map((k) => [k, true]));

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, PRODUCTS);
  vi.clearAllMocks();
});

describe("the server is the authority on the acknowledgements", () => {
  it("accepts a checkout when every statement the UI renders is ticked", async () => {
    const result = await checkout(ALL_TRUE);
    // The point is that it is NOT refused for acknowledgements. Anything else
    // this route decides (stock, pricing) is another suite's business.
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(String(result.body.error ?? "")).not.toMatch(/acknowledgement/i);
  });

  it("REGRESSION f57a3e5: the retired three-key payload is refused", async () => {
    // Exactly what /checkout posted between 32d97c8 and f57a3e5, and now also
    // what a stale client cached before the 4->2 consolidation would send.
    // Either way it omits the returns statement, so it must not buy anything.
    const result = await checkout({
      researchResponsibility: true,
      researchCompliance: true,
      ageLegalConfirmation: true,
    });
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toMatch(/acknowledgements must be accepted/i);
  });

  it("refuses when ANY single statement is unticked", async () => {
    for (const key of ALL_KEYS) {
      const result = await checkout({ ...ALL_TRUE, [key]: false });
      expect(result.status, `unticking "${key}" must be refused`).toBe(400);
      expect(String(result.body.error)).toMatch(/acknowledgements must be accepted/i);
    }
  });

  it("refuses when ANY single statement is missing entirely", async () => {
    for (const key of ALL_KEYS) {
      const partial = { ...ALL_TRUE };
      delete (partial as Record<string, unknown>)[key];
      const result = await checkout(partial);
      expect(result.status, `omitting "${key}" must be refused`).toBe(400);
    }
  });

  it("refuses a truthy stand-in for ANY statement — only a real tick counts", async () => {
    // A crafted request could send "1", "yes", or 1. This is a legal consent
    // record; nothing but boolean true may satisfy it. Checked for EVERY key:
    // testing one key let a sabotage that weakened a different key stay green.
    for (const key of ALL_KEYS) {
      for (const impostor of ["true", "yes", "1", 1, {}, []]) {
        const result = await checkout({ ...ALL_TRUE, [key]: impostor });
        expect(
          result.status,
          `${key}=${JSON.stringify(impostor)} must not pass for a tick`,
        ).toBe(400);
      }
    }
  });

  it("refuses an absent, null or non-object acknowledgement block", async () => {
    for (const nothing of [undefined, null, "", 0, false, "all"]) {
      const result = await checkout(nothing);
      expect(result.status).toBe(400);
    }
  });

  it("refuses before it touches stock — a refused checkout reserves nothing", async () => {
    // `tables` is a Map. Reading it as a plain object silently yields
    // undefined on both sides and the assertion passes without comparing
    // anything, so snapshot through the Map API and assert it is non-empty.
    const snapshot = () => {
      const doses = harness.db.tables.get("product_doses") ?? [];
      const rows = doses.length > 0 ? doses : harness.db.tables.get("products") ?? [];
      expect(rows.length, "nothing to compare — the seed did not land").toBeGreaterThan(0);
      return JSON.stringify(rows);
    };

    const before = snapshot();
    const refused = await checkout({ ...ALL_TRUE, returnsPolicy: false });
    expect(refused.status).toBe(400);
    expect(snapshot()).toBe(before);
    expect(harness.db.tables.get("orders") ?? []).toHaveLength(0);
  });

  it("refuses without sending any email", async () => {
    await checkout({ ...ALL_TRUE, researchCompliance: false });
    expect(harness.emails).toHaveLength(0);
  });
});
