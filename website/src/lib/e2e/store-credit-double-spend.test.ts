import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutBody, harness, seedStore, WEBHOOK_SECRET, type Shopper } from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// VL-11 / MPC-01, AT THE SEAM WHERE IT COSTS MONEY.
//
// One member, $50 of store credit, two checkouts. The unit tests in
// tender-reservation.test.ts prove the hold itself; this one proves the
// CHECKOUT takes it — the real route, the real quote, the real order writer,
// against one shared database.
//
// The old behaviour, exactly: quoteOrder READ the balance and nothing claimed
// it, so both orders were written with $50 off and both cards were charged the
// reduced total. Settlement then debited the ledger once (redeemStoreCredit
// clamps to the live balance), which is why nothing ever looked wrong — the
// balance never went negative and no alert fired. The store had simply given
// away $100 of discount against $50 of liability.
//
// So the assertion here is on DISCOUNT GRANTED, not on ledger rows. A test that
// checked the ledger passes on the broken code, which is how this survived.
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

const MEMBER_ID = "member-9999";

// The shopper is signed in — store credit is an account balance, so the guest
// path this defect does not apply to is not the one under test.
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => ({ id: MEMBER_ID, email: "member@example.test", role: "customer" }),
  getSessionAccessToken: async () => null,
}));

// The ONE boundary this suite draws, and it is deliberately narrow: which TIER
// a member is on. Everything about the balance itself stays real — the perks
// below read the live ledger through the shipping code, so a hold taken by the
// first checkout is visible to the second exactly as in production.
vi.mock("@/lib/membership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/membership")>();
  return {
    ...actual,
    getMembershipPerks: async (userId: string) => {
      const { getStoreCreditBalanceCents } = await import("@/lib/store-credit");
      return {
        isActiveMember: true,
        tierSlug: "elite",
        memberDiscountPercent: 0,
        freeShipping: false,
        pointsPerDollar: 1,
        storeCreditBalanceCents: await getStoreCreditBalanceCents(userId),
        storeCreditMinOrderCents: 0,
      };
    },
    getActivePointsPerDollar: async () => 1,
    getActivePointsMultiplier: async () => ({ multiplier: 1, eventName: null }),
  };
});

vi.mock("@/lib/email/send", () => ({
  sendEmail: async () => ({ success: true }),
}));

const MEMBER: Shopper = {
  email: "member@example.test",
  fullName: "Mem Ber",
  address: "10 Credit Street",
  city: "Creditville",
  state: "TX",
  postalCode: "75001",
  country: "US",
  phone: "555-0333",
};

const SLUG = "alpha-peptide-10mg";
const PRODUCTS = [
  { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 4499, inventory: 40, unitCostCents: 1200, weightOz: 0.4 },
];

const CREDIT_CENTS = 5000;

async function postCheckout() {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const request = new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(checkoutBody(MEMBER, [{ productId: SLUG, quantity: 3 }])),
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Every cent of store credit this store has actually given away, across all orders. */
function discountGrantedCents(): number {
  return harness.db.rows("orders")
    .filter((row) => String(row.payment_status ?? "") !== "canceled")
    .reduce((sum, row) => sum + Number(row.store_credit_redeemed_cents ?? 0), 0);
}

beforeEach(() => {
  harness.reset();
  seedStore(harness.db, PRODUCTS);
  // The free tier every account falls back to; the member's own tier is
  // supplied by the perks boundary above.
  harness.db.seed("membership_tiers", [{
    id: "tier-free",
    slug: "free",
    name: "Research Member",
    monthly_price_cents: 0,
    annual_price_cents: 0,
    points_per_dollar: 1,
    member_discount_percent: 0,
    monthly_store_credit_cents: 0,
    store_credit_min_order_cents: 0,
    is_active: true,
    position: 0,
  }]);
  harness.db.seed("store_credit_ledger", [{
    id: "grant-1",
    user_id: MEMBER_ID,
    amount_cents: CREDIT_CENTS,
    reason: "membership_monthly_grant",
    created_at: new Date().toISOString(),
  }]);
  vi.clearAllMocks();
});

describe("one store-credit balance, two checkouts", () => {
  it("spends it once when the checkouts run back to back", async () => {
    const first = await postCheckout();
    const second = await postCheckout();

    expect(first.status).toBe(200);
    // The second checkout is not blocked — it is simply priced against what is
    // left, which is nothing. The shopper still gets their order.
    expect(second.status).toBe(200);
    expect(discountGrantedCents()).toBe(CREDIT_CENTS);
  });

  it("spends it once when the checkouts race", async () => {
    // Two tabs, submitted together: the case the balance read at quote time
    // cannot see, and the reason a claim has to be atomic rather than checked.
    await Promise.all([postCheckout(), postCheckout()]);

    expect(discountGrantedCents()).toBe(CREDIT_CENTS);
  });

  it("gives the first checkout the full discount it was quoted", async () => {
    // The fix must not solve the double-spend by quietly under-applying credit:
    // one order carries the whole balance.
    await postCheckout();

    const applied = harness.db.rows("orders").map((row) => Number(row.store_credit_redeemed_cents ?? 0));
    expect(applied).toEqual([CREDIT_CENTS]);
  });

  it("leaves no order or stock hold behind when the balance cannot be claimed", async () => {
    // Same contract the processor-failure path has (G-03): the shopper is told
    // no order was placed, so there must not be one — nor a hold on the stock
    // it would have shipped.
    harness.db.injectFailure({ table: "store_credit_ledger", op: "insert", times: 1 });

    const { status } = await postCheckout();

    expect(status).toBe(400);
    const statuses = harness.db.rows("orders").map((row) => String(row.payment_status));
    expect(statuses).toEqual(["canceled"]);
    expect(Number(harness.db.findOne("products", "slug", SLUG)?.reserved_quantity ?? 0)).toBe(0);
  });

  it("leaves the balance spent, not merely promised, after the first checkout", async () => {
    const { getStoreCreditBalanceCents } = await import("@/lib/store-credit");

    await postCheckout();

    // The hold IS the debit, so the balance a second quote reads is already 0.
    expect(await getStoreCreditBalanceCents(MEMBER_ID)).toBe(0);
  });
});
