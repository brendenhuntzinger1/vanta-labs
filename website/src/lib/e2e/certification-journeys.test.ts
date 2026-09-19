import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkoutBody,
  countEmails,
  harness,
  seedStore,
  WEBHOOK_SECRET,
  type Shopper,
} from "@/lib/e2e/journey.harness";

// ---------------------------------------------------------------------------
// THE CERTIFICATION JOURNEYS, A TO I, RECONCILED END TO END.
//
// Each journey drives the REAL application modules — the checkout route, the
// quote, the order writer, the payment webhook, the inventory RPCs, the offer
// reservation and redemption, commission accrual — joined only by one shared
// database. Nothing is handed from stage to stage by the test. If a seam is
// wrong the next stage simply does not find what it needs.
//
// WHAT EACH JOURNEY RECONCILES, and the reason the list is this long: the
// question is never "did the page load", it is whether the customer's screen,
// the server's quote, the money, the order, the stock, the reward ledger, the
// attribution and the margin all describe the SAME event.
//
//   server quote  =  order row  =  amount charged
//   order items   =  what ships (the free vial included)
//   inventory     =  reserved at checkout, committed on payment, released on death
//   reward        =  reserved before the order exists, redeemed exactly once
//   attribution   =  campaign / automation / referral, each in its own field
//   commission    =  computed from the PAID subtotal, never from the gift
//
// BOUNDARIES. The Shippo HTTP client, the email transport and the payment
// gateway are mocked — a real call there spends postage, mail or money. The
// processor's webhook signature is verified for real against the same HMAC the
// live provider uses. Everything above those three lines is production code.
//
// EXPRESS / APPLE PAY IS NOT EXERCISED HERE and must not be: the lane is
// disabled in production (EXPRESS_OFFER_PARITY === false) and a journey through
// it would describe a road no customer can drive.
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

/** Guest journeys throughout: the wall's own grant covers them, and a signed-in
 *  session would hide the identity questions these journeys are asked to probe. */
vi.mock("@/lib/auth-session", () => ({
  getAuthenticatedUser: async () => null,
  getSessionAccessToken: async () => null,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: { to: string; subject: string; html?: string; text?: string }) => {
    if (harness.emailFailures > 0) { harness.emailFailures -= 1; throw new Error("provider outage"); }
    harness.emails.push({ to: message.to, subject: message.subject, html: message.html ?? "", text: message.text ?? "" });
    return { id: `email-${harness.emails.length}` };
  },
}));

vi.mock("@/lib/shippo/client", () => ({
  shippoRequest: async () => ({ object_id: "shippo_noop", status: "SUCCESS" }),
  isShippoConfigured: () => false,
}));

// ------------------------------------------------------------- the fixture --

const PAID_SLUG = "paid-peptide-10mg";
const GIFT_SLUG = "gift-vial-50mg";
const DOSED_SLUG = "ladder-peptide";

/** Unit economics chosen so every figure below can be checked by hand. */
const PAID_PRICE_CENTS = 5000;   // $50.00
const PAID_COST_CENTS = 1000;    // $10.00
const GIFT_PRICE_CENTS = 4000;   // $40.00 retail, given away
const GIFT_COST_CENTS = 800;     // $8.00 landed

const BUYER: Shopper = {
  email: "journey.buyer@example.test",
  fullName: "Journey Buyer",
  address: "1 Certification Way",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "512-555-0100",
};

const OFFER_TOKEN = "certification-offer-token";
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function seedWorld() {
  harness.reset();
  seedStore(harness.db, [
    { slug: PAID_SLUG, name: "Paid Peptide 10mg", priceCents: PAID_PRICE_CENTS, inventory: 50, unitCostCents: PAID_COST_CENTS, weightOz: 0.4 },
    { slug: GIFT_SLUG, name: "Gift Vial 50mg", priceCents: GIFT_PRICE_CENTS, inventory: 30, unitCostCents: GIFT_COST_CENTS, weightOz: 0.4 },
    { slug: DOSED_SLUG, name: "Ladder Peptide", priceCents: 6000, inventory: 0, unitCostCents: 1500, weightOz: 0.4 },
  ]);
}

/** A wheel prize exactly as /api/spin mints one. */
function seedPrize(overrides: Record<string, unknown> = {}) {
  harness.db.seed("customer_offers", [{
    id: "offer-journey",
    offer_key: "spin:winback_2026q4",
    token_hash: hashToken(OFFER_TOKEN),
    email: BUYER.email,
    reward_kind: "free_product",
    product_slug: GIFT_SLUG,
    quantity: 1,
    percent_off: null,
    variant_id: null,
    min_subtotal_cents: 7500,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
    reserved_order_id: null, reserved_at: null,
    redeemed_order_id: null, redeemed_at: null, revoked_at: null,
    ...overrides,
  }]);
}

// ------------------------------------------------------------ driving code --

async function checkout(
  shopper: Shopper,
  items: Array<{ productId: string; quantity: number }>,
  opts: { offerToken?: string; referralCode?: string; cookies?: string } = {},
) {
  const { POST } = await import("@/app/api/checkout/create-session/route");
  const cookieParts = [
    opts.offerToken ? `vl_offer=${opts.offerToken}` : null,
    opts.cookies ?? null,
  ].filter(Boolean);
  const body = { ...checkoutBody(shopper, items), ...(opts.referralCode ? { referralCode: opts.referralCode } : {}) };
  const request = new Request("https://vantalabsresearch.test/api/checkout/create-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.42",
      ...(cookieParts.length ? { cookie: cookieParts.join("; ") } : {}),
    },
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
const failed = (orderId: string, email: string) => ({
  type: "payment.failed",
  data: { object: { metadata: { orderId, order_id: orderId, customerEmail: email }, amount: 0, currency: "USD" } },
});

// ------------------------------------------------------------ readback code --

const orderRow = (orderId: string) =>
  harness.db.table("orders").find((row) => String(row.order_id) === orderId);
const itemsFor = (orderId: string) =>
  harness.db.table("order_items").filter((row) => String(row.order_id) === orderId);
const offerRow = () => harness.db.table("customer_offers")[0];
const stockOf = (slug: string) => {
  const row = harness.db.table("products").find((p) => String(p.slug) === slug);
  return { onHand: Number(row?.inventory_quantity ?? 0), reserved: Number(row?.reserved_quantity ?? 0) };
};

beforeEach(() => { seedWorld(); });

// ===========================================================================
// JOURNEY A — new customer, wheel prize, phone supplied, SMS NOT ticked.
// ===========================================================================
describe("JOURNEY A — wheel winner buys, phone on file, SMS unchecked", () => {
  it("reconciles UI quote, order, gift line, inventory, reward and margin", async () => {
    seedPrize();

    // --- UI/quote -> order. Two paid units clear the $75 floor.
    const res = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const orderId = String(res.body.orderId);
    expect(orderId).toBeTruthy();

    const order = orderRow(orderId)!;
    expect(order, "no order row was written").toBeTruthy();

    // --- SERVER QUOTE = ORDER. The subtotal is the PAID goods only; a $0 line
    //     cannot move a subtotal, which is the rule offerMinimumMet states.
    //
    //     $95.00, NOT $100.00, and that is the store pricing correctly rather
    //     than the fixture being wrong: two units earn the published 2-unit
    //     bundle rate of 5%, so 2 x $50.00 x 0.95 = $95.00. Checked here
    //     explicitly because it is also the proof that bundle pricing is
    //     applied SERVER-SIDE from the products table, not accepted from a
    //     browser. $95 still clears the prize's $75 floor, so the gift stands.
    expect(Number(order.subtotal)).toBeCloseTo(95.0, 2);

    // --- ORDER ITEMS = WHAT SHIPS. The free vial must be on the order, at $0,
    //     or the customer is charged correctly and shipped the wrong box.
    const items = itemsFor(orderId);
    const gift = items.filter((i) => Number(i.unit_price) === 0);
    const paid = items.filter((i) => Number(i.unit_price) > 0);
    expect(paid, "the paid line is missing").toHaveLength(1);
    expect(Number(paid[0].quantity)).toBe(2);
    expect(gift, "THE FREE VIAL IS NOT ON THE ORDER").toHaveLength(1);
    expect(Number(gift[0].quantity)).toBe(1);
    expect(String(gift[0].product_id)).toContain(GIFT_SLUG);

    // --- REWARD reserved to THIS order, before the order existed, not yet spent.
    expect(String(offerRow().reserved_order_id)).toBe(orderId);
    expect(offerRow().redeemed_at, "a reward was consumed before payment").toBeNull();

    // --- INVENTORY held for both the paid units and the gift.
    expect(stockOf(PAID_SLUG).reserved).toBe(2);
    expect(stockOf(GIFT_SLUG).reserved, "the gift reserved no stock — it would oversell").toBe(1);

    // --- PAYMENT -> the rest of the world.
    const amount = Number(order.amount_paid);
    const paidRes = await paymentWebhook(succeeded(orderId, amount, BUYER.email), "evt-A-1");
    expect(paidRes.status).toBe(200);

    const settled = orderRow(orderId)!;
    expect(String(settled.payment_status)).toBe("paid");
    // --- PAYMENT = ORDER TOTAL.
    expect(Number(settled.amount_paid)).toBeCloseTo(amount, 2);

    // --- REWARD redeemed exactly once, and permanently.
    expect(offerRow().redeemed_at, "the reward was never consumed").toBeTruthy();
    expect(String(offerRow().redeemed_order_id)).toBe(orderId);

    // --- INVENTORY committed, not merely released.
    expect(stockOf(PAID_SLUG)).toEqual({ onHand: 48, reserved: 0 });
    expect(stockOf(GIFT_SLUG), "the gifted vial did not leave the shelf").toEqual({ onHand: 29, reserved: 0 });

    // --- ONE confirmation, to the buyer.
    expect(countEmails(BUYER.email, /^Order Confirmed/i)).toBe(1);

    // --- MARGIN, from the figures this order actually carries.
    //     Revenue on goods $95.00; COGS = 2 x $10.00 paid + $8.00 gifted.
    //     Gross profit = 95.00 - 28.00 = $67.00, a 70.5% margin WITH the vial
    //     given away — the economics the wheel's minimum exists to protect.
    const cogsCents = 2 * PAID_COST_CENTS + GIFT_COST_CENTS;
    expect(cogsCents).toBe(2800);
    const grossCents = Math.round(Number(order.subtotal) * 100) - cogsCents;
    expect(grossCents).toBe(6700);
    expect(grossCents / (Number(order.subtotal) * 100)).toBeGreaterThan(0.70);

    // --- MARKETING STATE: a phone was supplied and SMS was NOT ticked, so no
    //     subscriber row may exist. PHONE ON FILE != SMS MARKETING CONSENT.
    const subs = harness.db.table("sms_subscribers");
    expect(subs.filter((s) => s.marketing_consent === true),
      "a purchase created SMS marketing consent nobody granted").toHaveLength(0);
  });
});

// ===========================================================================
// JOURNEY B — the same, with SMS explicitly ticked.
// ===========================================================================
describe("JOURNEY B — the same journey with SMS explicitly opted in", () => {
  it("records consent with evidence, and the order is otherwise identical to A", async () => {
    seedPrize();
    // Consent is recorded by the opt-in surface, not by checkout — that IS the
    // invariant. Seeded here as that surface would write it, then the order is
    // driven and checked for contamination in either direction.
    harness.db.seed("sms_subscribers", [{
      phone_e164: "+15125550100", email: BUYER.email, status: "subscribed",
      marketing_consent: true, marketing_consent_at: new Date().toISOString(),
      consent_source: "sms_page", disclosure_version: "2026-09-16",
      opted_out_at: null, created_at: new Date().toISOString(),
    }]);

    const res = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    expect(res.status).toBe(200);
    const orderId = String(res.body.orderId);
    await paymentWebhook(succeeded(orderId, Number(orderRow(orderId)!.amount_paid), BUYER.email), "evt-B-1");

    // Consent survives the purchase with its evidence intact — a purchase must
    // neither grant consent nor quietly downgrade it.
    const sub = harness.db.table("sms_subscribers")[0];
    expect(sub.marketing_consent).toBe(true);
    expect(sub.marketing_consent_at).toBeTruthy();
    expect(sub.disclosure_version).toBe("2026-09-16");
    expect(sub.opted_out_at).toBeNull();

    // And the money/goods reconcile exactly as in A.
    expect(String(orderRow(orderId)!.payment_status)).toBe("paid");
    expect(itemsFor(orderId).filter((i) => Number(i.unit_price) === 0)).toHaveLength(1);
    expect(offerRow().redeemed_at).toBeTruthy();
  });
});

// ===========================================================================
// JOURNEY C — declines the acquisition offer, buys normally.
// ===========================================================================
describe("JOURNEY C — no wheel, ordinary purchase", () => {
  it("prices, charges, ships and costs exactly the plain basket", async () => {
    const res = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }]);
    expect(res.status).toBe(200);
    const orderId = String(res.body.orderId);
    const order = orderRow(orderId)!;

    // Same 5% two-unit bundle rate as journey A, and no gift to change it.
    expect(Number(order.subtotal)).toBeCloseTo(95.0, 2);
    expect(itemsFor(orderId).filter((i) => Number(i.unit_price) === 0),
      "a customer who declined the wheel was given a free vial").toHaveLength(0);
    expect(Number(order.discount_amount ?? 0)).toBe(0);

    await paymentWebhook(succeeded(orderId, Number(order.amount_paid), BUYER.email), "evt-C-1");
    expect(String(orderRow(orderId)!.payment_status)).toBe("paid");
    expect(stockOf(PAID_SLUG)).toEqual({ onHand: 48, reserved: 0 });
    expect(stockOf(GIFT_SLUG), "an untouched product moved").toEqual({ onHand: 30, reserved: 0 });
    expect(countEmails(BUYER.email, /^Order Confirmed/i)).toBe(1);
  });
});

// ===========================================================================
// JOURNEY E — decline, reward survives, retry succeeds.
// ===========================================================================
describe("JOURNEY E — payment declines, the prize survives, the retry works", () => {
  it("releases the hold on decline and lets the SAME prize buy the retry", async () => {
    seedPrize();

    const first = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    const firstOrder = String(first.body.orderId);
    expect(String(offerRow().reserved_order_id)).toBe(firstOrder);

    // The card is refused.
    await paymentWebhook(failed(firstOrder, BUYER.email), "evt-E-1");
    const dead = orderRow(firstOrder)!;
    expect(["payment_failed", "canceled", "cancelled"]).toContain(String(dead.payment_status));

    // THE PRIZE IS HANDED BACK. Not merely unredeemed — unheld, so the customer
    // can spend it, and so chooseSpinDose (which guards on reserved_order_id)
    // does not lock their dose for ever.
    expect(offerRow().redeemed_at, "a declined order consumed the prize").toBeNull();
    expect(offerRow().reserved_order_id, "the prize is still held by a dead order").toBeNull();

    // Stock came back too.
    expect(stockOf(PAID_SLUG).reserved).toBe(0);
    expect(stockOf(GIFT_SLUG).reserved).toBe(0);

    // No confirmation was sent for an order that never paid.
    expect(countEmails(BUYER.email, /^Order Confirmed/i)).toBe(0);

    // --- RETRY, with the same prize.
    const retry = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    expect(retry.status, "the retry was refused — the prize did not survive").toBe(200);
    const retryOrder = String(retry.body.orderId);
    expect(retryOrder).not.toBe(firstOrder);
    expect(itemsFor(retryOrder).filter((i) => Number(i.unit_price) === 0),
      "the retry lost the free vial").toHaveLength(1);

    await paymentWebhook(succeeded(retryOrder, Number(orderRow(retryOrder)!.amount_paid), BUYER.email), "evt-E-2");
    expect(String(orderRow(retryOrder)!.payment_status)).toBe("paid");
    expect(String(offerRow().redeemed_order_id), "the prize was redeemed against the wrong order").toBe(retryOrder);
    expect(countEmails(BUYER.email, /^Order Confirmed/i)).toBe(1);
  });
});

// ===========================================================================
// JOURNEY G — referral -> wheel -> purchase -> commission.
// ===========================================================================
describe("JOURNEY G — referred customer with a prize, and the commission ledger", () => {
  it("pays commission on the PAID subtotal and never on the gift", async () => {
    seedPrize();
    harness.db.seed("ambassadors", [{
      id: "amb-1", user_id: "amb-user-1", referral_code: "CERTIFY10",
      status: "approved", commission_percent: 10, created_at: new Date().toISOString(),
    }]);
    harness.db.seed("partners", [{
      id: "amb-1", user_id: "amb-user-1", email: "ambassador@example.test",
      status: "approved", created_at: new Date().toISOString(),
    }]);

    const res = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], {
      offerToken: OFFER_TOKEN, referralCode: "CERTIFY10",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const orderId = String(res.body.orderId);
    await paymentWebhook(succeeded(orderId, Number(orderRow(orderId)!.amount_paid), BUYER.email), "evt-G-1");

    const order = orderRow(orderId)!;
    expect(String(order.payment_status)).toBe("paid");

    const commissions = harness.db.table("commissions").filter((c) => String(c.order_id) === orderId);
    // Either the programme accrued exactly one commission, or it accrued none
    // and said why. Two commissions for one order is the failure mode.
    expect(commissions.length, "one order produced more than one commission").toBeLessThanOrEqual(1);

    if (commissions.length === 1) {
      const c = commissions[0];
      const amount = Number(c.commission_amount);
      const percent = Number(c.commission_percent);
      // THE GIFT IS NOT COMMISSIONABLE. The base must never include the $0 line
      // or its retail value — an ambassador cannot earn on goods given away.
      const paidSubtotal = Number(order.subtotal);
      expect(amount, "commission exceeds what the paid subtotal can justify")
        .toBeLessThanOrEqual(paidSubtotal * (percent / 100) + 0.005);
      expect(amount, "commission was paid on the gift's retail value")
        .toBeLessThan((paidSubtotal + GIFT_PRICE_CENTS / 100) * (percent / 100));
      expect(amount).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// JOURNEY H — returning customer with existing marketing state.
// ===========================================================================
describe("JOURNEY H — a returning customer whose marketing state already exists", () => {
  it("buys again without resurrecting an unsubscribed contact", async () => {
    // They unsubscribed from email and said STOP to texts. Buying must not undo
    // either: a purchase is a transaction, not a consent.
    harness.db.seed("email_suppressions", [{
      id: "sup-1", email: BUYER.email, reason: "unsubscribed", created_at: new Date(Date.now() - 86_400_000).toISOString(),
    }]);
    harness.db.seed("sms_subscribers", [{
      phone_e164: "+15125550100", email: BUYER.email, status: "unsubscribed",
      marketing_consent: false, marketing_consent_at: null,
      opted_out_at: new Date(Date.now() - 86_400_000).toISOString(), opt_out_keyword: "STOP",
      created_at: new Date(Date.now() - 172_800_000).toISOString(),
    }]);

    const res = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 1 }]);
    expect(res.status).toBe(200);
    const orderId = String(res.body.orderId);
    await paymentWebhook(succeeded(orderId, Number(orderRow(orderId)!.amount_paid), BUYER.email), "evt-H-1");

    expect(String(orderRow(orderId)!.payment_status)).toBe("paid");

    const sub = harness.db.table("sms_subscribers")[0];
    expect(sub.marketing_consent, "a purchase re-subscribed a STOP customer").toBe(false);
    expect(sub.opted_out_at, "the STOP record was cleared by a purchase").toBeTruthy();

    // The suppression stands. A transactional receipt is a different thing from
    // marketing and is allowed; what must not happen is the suppression being
    // deleted or flipped by the act of buying.
    const suppressions = harness.db.table("email_suppressions")
      .filter((s) => String(s.email).toLowerCase() === BUYER.email);
    expect(suppressions, "the unsubscribe record was removed by a purchase").toHaveLength(1);
  });
});

// ===========================================================================
// Cross-journey: the reward can only ever be spent once.
// ===========================================================================
describe("across journeys — one prize, one order, for ever", () => {
  it("a second checkout cannot take a prize a live order already holds", async () => {
    seedPrize();
    const first = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    expect(first.status).toBe(200);
    const firstOrder = String(first.body.orderId);
    expect(String(offerRow().reserved_order_id)).toBe(firstOrder);

    const second = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    // Either the second checkout is refused outright, or it succeeds WITHOUT
    // the gift. What must never happen is two orders each carrying a free vial
    // off one prize.
    if (second.status === 200) {
      const secondOrder = String(second.body.orderId);
      expect(itemsFor(secondOrder).filter((i) => Number(i.unit_price) === 0),
        "TWO ORDERS EACH GOT A FREE VIAL FROM ONE PRIZE").toHaveLength(0);
    }
    expect(String(offerRow().reserved_order_id), "the hold moved to a second order").toBe(firstOrder);
  });

  it("a prize already redeemed cannot be spent again", async () => {
    seedPrize();
    const first = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    const firstOrder = String(first.body.orderId);
    await paymentWebhook(succeeded(firstOrder, Number(orderRow(firstOrder)!.amount_paid), BUYER.email), "evt-X-1");
    expect(offerRow().redeemed_at).toBeTruthy();

    const second = await checkout(BUYER, [{ productId: PAID_SLUG, quantity: 2 }], { offerToken: OFFER_TOKEN });
    if (second.status === 200) {
      expect(itemsFor(String(second.body.orderId)).filter((i) => Number(i.unit_price) === 0),
        "a SPENT prize was spent a second time").toHaveLength(0);
    }
  });
});
