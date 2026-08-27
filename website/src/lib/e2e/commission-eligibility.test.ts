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

/**
 * Put an ambassador in the database at a given status.
 *
 * BOTH TABLES, because production has both: `ambassadors` and `partners` are
 * mirrors keyed by the same id (verified read-only against live Postgres — 9
 * ambassadors, 9 partners, 0 ambassadors without a partners row). The mirror
 * matters to money: `commissions.partner_id` is
 * `not null references partners(id)`, so seeding only `ambassadors` describes a
 * database that cannot exist and would let a commission accrue that production
 * would refuse.
 */
function seedAmbassador(status: string) {
  harness.db.seed("ambassadors", [
    { id: AMBASSADOR_ID, status, customer_discount_percent: null, referral_code: CODE },
  ]);
  harness.db.seed("partners", [
    { id: AMBASSADOR_ID, status, name: "Ambassador", email: "ambassador@example.test", referral_code: CODE },
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

  // THE PRE-DISCOUNT GATE, TESTED BY BEHAVIOUR.
  //
  // The minimum is measured against the subtotal BEFORE the customer's discount.
  // If it were measured after, the ambassador's own discount would be what
  // disqualifies her from the commission — the bigger her rate, the more often
  // she earns nothing. $105 qualifies; the 10% she gives away leaves $94.50
  // commissionable, which does not.
  //
  // This replaces a source-text assertion in ambassador-regression.test.ts that
  // could only see whether the line had moved.
  it("a discount that drops the commissionable subtotal below the minimum still earns", async () => {
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 10500, inventory: 40, unitCostCents: 1000, weightOz: 0.4 },
    ]);
    seedAmbassador("approved");

    const { POST } = await import("@/app/api/checkout/create-session/route");
    const body = checkoutBody(BUYER, [{ productId: SLUG, quantity: 1 }]) as Record<string, unknown>;
    body.referralCode = CODE;
    const created = await POST(new Request("https://vantalabsresearch.test/api/checkout/create-session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(body),
    }));
    const createdBody = await created.json() as { orderId?: string; total?: number };
    expect(created.status, JSON.stringify(createdBody)).toBe(200);

    const order = (harness.db.tables.get("orders") ?? []).find((r) => String(r.order_id) === String(createdBody.orderId))!;
    // $105.00 merchandise, $10.50 given away -> $94.50 commissionable.
    expect(Number(order.subtotal)).toBe(105);
    expect(Number(order.discount_amount)).toBe(10.5);

    expect(await payWebhook(String(createdBody.orderId), "evt-pre-discount-gate", Number(createdBody.total ?? 0))).toBe(200);

    const row = commissionRow();
    expect(row, "no commission row written").not.toBeNull();
    expect(row!.ineligible_reason).toBeNull();
    expect(Number(row!.commission_amount)).toBeGreaterThan(0);
  });

  it("an ambassador who vanishes from the table entirely earns NOTHING — and NOTHING IS WRITTEN", async () => {
    // No seedAmbassador call: both mirror rows are missing, not merely inactive.
    //
    // This used to write a $0 `ineligible_reason: "Ambassador is not active."`
    // row into referral_orders and then attempt the commissions mirror with
    // `partner_id = <a partner that does not exist>`. In production that upsert
    // raises 23503 AFTER the ledger row has committed, and nothing ever
    // reconciles the two: the repair sweep keys on the ledger row's ABSENCE,
    // which the half-written row has just destroyed.
    //
    // ensureCommissionRecord now refuses BEFORE its first write. Nothing is
    // recorded, the order stays visible to the repair sweep, and the sweep
    // raises its critical alert every tick until a human restores the partners
    // row or clears the order's attribution. Loud and recoverable, rather than
    // quiet and permanent.
    const { orderId, total } = await paidReferredOrder();
    // The webhook still settles the payment: accrual failures are caught and
    // logged there (payment-webhook.ts) precisely so a commission problem can
    // never cost the shopper their order.
    expect(await payWebhook(orderId, "evt-missing", total)).toBe(200);

    expect(commissionRow()).toBeNull();
    expect((harness.db.tables.get("commissions") ?? []).length).toBe(0);
  });

  it("an ambassador present in `ambassadors` but MISSING from `partners` writes nothing either", async () => {
    // The latent identity split, stated on its own: the accrual reads
    // eligibility from `ambassadors` but the commissions mirror is FK'd to
    // `partners`. Seed only the first and the two ledgers cannot both be
    // written, so neither is.
    harness.db.seed("ambassadors", [
      { id: AMBASSADOR_ID, status: "approved", customer_discount_percent: null, referral_code: CODE },
    ]);
    const { orderId, total } = await paidReferredOrder();
    expect(await payWebhook(orderId, "evt-no-partner", total)).toBe(200);

    expect(commissionRow()).toBeNull();
    expect((harness.db.tables.get("commissions") ?? []).length).toBe(0);
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

  // BELOW THE MINIMUM IS NOT AN ERROR.
  //
  // This used to assert HTTP 400 and zero orders. That was the defect, not the
  // guarantee: a customer who followed an ambassador's link with a small basket
  // was told in the cart that they had a discount, given none, and then STOPPED
  // at the pay button by a minimum nobody had mentioned. Production carried 75
  // referral clicks and 0 referral orders.
  //
  // The invariant that matters is the one the stale-code case states two
  // paragraphs down — "no undeserved discount is given" — not "the order is
  // refused". Attribution is kept so the ambassador can see the conversion she
  // sent; payment-webhook.ts records it with an ineligible_reason and zero
  // commission, which is what that code was already built to do.
  it("allows a cart below the minimum, at full price, and keeps the attribution", async () => {
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 9999, inventory: 40, unitCostCents: 1000, weightOz: 0.4 },
    ]);
    seedAmbassador("approved");

    const result = await checkoutWithCode(CODE, 1);

    // The sale goes through.
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const orders = harness.db.tables.get("orders") ?? [];
    expect(orders).toHaveLength(1);

    // No undeserved discount — $99.99 does not earn the $100 rate.
    expect(Number(orders[0].discount_amount)).toBe(0);

    // The ambassador still gets credit for sending the customer.
    expect(String(orders[0].referral_code)).toBe(CODE);
  });

  // THE PROFIT GUARD MUST NOT BE CHARGED FOR A COMMISSION THAT WILL NEVER BE PAID.
  //
  // A below-minimum referral earns the ambassador nothing, so reserving her
  // commission against the break-even floor makes the floor strictly harsher
  // than reality — and it fails CLOSED, refusing the order outright with
  // "Promotion unavailable on this order." on any thin-margin cart.
  //
  // The margin here is deliberately thin, and the window was measured rather
  // than guessed. With the guard correctly gated, a $99.99 cart is refused only
  // once unit cost passes $105. With the guard charged for a commission that
  // will never be paid, the refusal starts at $80 — so every below-minimum
  // referred cart costing between $80 and $105 was refused outright, while the
  // identical cart WITHOUT a code went through.
  //
  // MUTATION CONTROL: reverting BOTH gates in quote-order.ts — the guard's
  // `referralAccepted: referralQualifiesForDiscount` back to `Boolean(referral)`
  // AND `if (referral && referralQualifiesForDiscount)` back to `if (referral)` —
  // turns this test red with exactly "Promotion unavailable on this order."
  // Either gate alone suppresses the phantom commission (profit-engine.ts:244
  // multiplies the rate by referralAccepted), which is why reverting only one
  // survived the whole 241-test checkout suite.
  it("does not charge the profit guard for a commission a below-minimum cart cannot earn", async () => {
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 9999, inventory: 40, unitCostCents: 9500, weightOz: 0.4 },
    ]);
    seedAmbassador("approved");

    const result = await checkoutWithCode(CODE, 1);

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(String(result.body.error ?? "")).not.toMatch(/promotion unavailable/i);
    expect(harness.db.tables.get("orders") ?? []).toHaveLength(1);
  });

  it("applies the discount on a cart exactly ON the minimum", async () => {
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 10000, inventory: 40, unitCostCents: 1000, weightOz: 0.4 },
    ]);
    seedAmbassador("approved");

    const result = await checkoutWithCode(CODE, 1);
    expect(result.status, JSON.stringify(result.body)).toBe(200);

    const orders = harness.db.tables.get("orders") ?? [];
    expect(orders).toHaveLength(1);
    // "at least $100" means $100.00 earns.
    expect(Number(orders[0].discount_amount)).toBeGreaterThan(0);
    expect(String(orders[0].referral_code)).toBe(CODE);
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

// ---------------------------------------------------------------------------
// AN INERT REFERRAL MUST NOT COST THE SHOPPER ANYTHING.
//
// Store credit and points never stack with a referral DISCOUNT — that rule is
// correct and stays. But `quote-order.ts` expressed it as "a referral CODE is
// attached", and until this change that was the same thing: a below-minimum
// referral could not reach those lines, because quoteOrder threw two hundred
// lines earlier.
//
// Removing the throw made the state reachable, and the two sides stopped
// agreeing. cart-context and the checkout panel suppress credit and points on
// `referralMeetsMinimum` — the basket actually earning the discount — while the
// server still suppressed on `referral` being non-null. So a signed-in shopper
// who clicked an ambassador link with a small basket had the points slider
// enabled, watched the deduction come off the displayed total, and then had
// `create-session` refuse the order outright: the client's expectedTotal is
// below the server's, which is exactly the underpayment guard's trigger. The
// message tells her to refresh the page, and refreshing changes nothing.
//
// The rule the code has to express is the one it always meant: nothing stacks
// with a referral discount that is actually being GIVEN.
// ---------------------------------------------------------------------------
describe("store credit and points against a referral that gives nothing", () => {
  const USER_ID = "user-points-0001";

  /** A signed-in shopper with a points balance and an approved ambassador live. */
  function seedShopperWithPoints(points: number) {
    seedAmbassador("approved");
    // A signed-in quote resolves the shopper's membership, and every store has
    // a free tier — getCustomerMembership throws without one.
    harness.db.seed("membership_tiers", [
      {
        id: "tier-free",
        slug: "free",
        name: "Free",
        is_active: true,
        position: 0,
        points_per_dollar: 1,
        member_discount_percent: 0,
        monthly_store_credit_cents: 0,
        store_credit_min_order_cents: 0,
      },
    ]);
    harness.db.seed("points_ledger", [
      { id: "pl-1", user_id: USER_ID, amount: points, reason: "seed", created_at: new Date().toISOString() },
    ]);
  }

  async function quote(quantity: number, pointsToRedeem: number) {
    const { quoteOrder } = await import("@/lib/quote-order");
    return quoteOrder({
      items: [{ id: SLUG, quantity }],
      customer: { ...BUYER },
      referralCode: CODE,
      customerUserId: USER_ID,
      pointsToRedeem,
      mode: "full",
    });
  }

  it("redeems points on a below-minimum referred order, because no discount was given", async () => {
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 6000, inventory: 40, unitCostCents: 1000, weightOz: 0.4 },
    ]);
    seedShopperWithPoints(500);

    const quoted = await quote(1, 500);

    // The referral gave nothing — that part is already settled elsewhere.
    expect(quoted.discountAmount).toBe(0);
    // ...so the points the shopper already owns are hers to spend.
    expect(quoted.pointsRedeemed).toBeGreaterThan(0);
    expect(quoted.pointsDiscountAmount).toBeGreaterThan(0);
  });

  // THE EXCLUSIVITY RULE ITSELF IS UNCHANGED. Without this, "fix" the divergence
  // by deleting the gate entirely and both tests still pass.
  it("still refuses to stack points on a referral that IS being discounted", async () => {
    harness.reset();
    seedStore(harness.db, [
      { slug: SLUG, name: "Alpha Peptide 10mg", priceCents: 12000, inventory: 40, unitCostCents: 1000, weightOz: 0.4 },
    ]);
    seedShopperWithPoints(500);

    const quoted = await quote(1, 500);

    expect(quoted.discountAmount).toBeGreaterThan(0);
    expect(quoted.pointsRedeemed).toBe(0);
    expect(quoted.pointsDiscountAmount).toBe(0);
  });
});
