import { describe, expect, it } from "vitest";
import { buildLifecycleFunnel, CART_RECOVERY_BENCHMARK, MIN_READABLE_SENDS } from "@/lib/email/lifecycle-funnel";

/**
 * ONE FUNNEL, EVERY FLOW, THE WAY THE MONEY IS MADE.
 *
 * eligible → sent → delivered → human open → human click → restored →
 * checkout → paid → revenue → gross profit, per flow and per stage, with the
 * benchmark-style figures (any open, 5-day open-or-click attribution) kept
 * beside the strict ones and never summed into them.
 */

const T0 = Date.parse("2026-09-10T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GMAIL = "Mozilla/5.0 (via ggpht.com GoogleImageProxy)";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

function fixture() {
  return {
    now: T0 + 7 * DAY,
    windowDays: 30,
    isInternal: (email: string | null | undefined) => String(email ?? "").endsWith("@vantalabsresearch.com"),
    sends: [
      // cart-1: delivered, prefetch then a real open, a real click, restore, checkout, strict paid order.
      { campaignType: "cart_recovery_t30m", referenceId: "cart-1", recipientEmail: "a@x.io", sentAt: iso(0), providerMessageId: "m1", status: "sent" },
      // cart-2: delivered, prefetch only.
      { campaignType: "cart_recovery_t30m", referenceId: "cart-2", recipientEmail: "b@x.io", sentAt: iso(0), providerMessageId: "m2", status: "sent" },
      // cart-3: no provider id (delivery unknown); a real open, then an organic order two days on → benchmark credit only.
      { campaignType: "cart_recovery_t24h", referenceId: "cart-3", recipientEmail: "c@x.io", sentAt: iso(0), providerMessageId: null, status: "sent" },
      // cart-4: delivered, never touched; an organic order a day on → self-serve inside the window.
      { campaignType: "cart_recovery_t12h", referenceId: "cart-4", recipientEmail: "d@x.io", sentAt: iso(0), providerMessageId: "m4", status: "sent" },
      // welcome: delivered, a scanner click.
      { campaignType: "automation:welcome_intro", referenceId: "e@x.io", recipientEmail: "e@x.io", sentAt: iso(0), providerMessageId: "m5", status: "sent" },
      // internal address: excluded from everything.
      { campaignType: "cart_recovery_t30m", referenceId: "cart-int", recipientEmail: "support@vantalabsresearch.com", sentAt: iso(0), providerMessageId: "m6", status: "sent" },
      // hard bounce.
      { campaignType: "cart_recovery_t30m", referenceId: "cart-6", recipientEmail: "f@x.io", sentAt: iso(0), providerMessageId: "m7", status: "sent" },
      // a failed send is attempted, not sent.
      { campaignType: "cart_recovery_t30m", referenceId: "cart-7", recipientEmail: "g@x.io", sentAt: iso(0), providerMessageId: null, status: "failed" },
      // auth mail is not a marketing flow and must not appear.
      { campaignType: "auth:signup_confirmation", referenceId: "h@x.io", recipientEmail: "h@x.io", sentAt: iso(0), providerMessageId: "m8", status: "sent" },
    ],
    deliveries: [
      { providerMessageId: "m1", kind: "delivered", receivedAt: iso(5_000) },
      { providerMessageId: "m2", kind: "delivered", receivedAt: iso(5_000) },
      { providerMessageId: "m4", kind: "delivered", receivedAt: iso(5_000) },
      { providerMessageId: "m5", kind: "delivered", receivedAt: iso(5_000) },
      { providerMessageId: "m6", kind: "delivered", receivedAt: iso(5_000) },
      { providerMessageId: "m7", kind: "hard_bounce", receivedAt: iso(5_000) },
    ],
    engagements: [
      { campaignType: "cart_recovery_t30m", referenceId: "cart-1", recipientEmail: null, kind: "opened" as const, at: iso(8_000), userAgent: GMAIL },
      { campaignType: "cart_recovery_t30m", referenceId: "cart-1", recipientEmail: null, kind: "opened" as const, at: iso(20 * MIN), userAgent: GMAIL },
      { campaignType: "cart_recovery_t30m", referenceId: "cart-1", recipientEmail: null, kind: "clicked" as const, at: iso(21 * MIN), userAgent: PHONE },
      { campaignType: "cart_recovery_t30m", referenceId: "cart-2", recipientEmail: null, kind: "opened" as const, at: iso(8_000), userAgent: "Mozilla/5.0" },
      { campaignType: "cart_recovery_t24h", referenceId: "cart-3", recipientEmail: null, kind: "opened" as const, at: iso(1 * HOUR), userAgent: GMAIL },
      { campaignType: "automation:welcome_intro", referenceId: "e@x.io", recipientEmail: "e@x.io", kind: "clicked" as const, at: iso(2 * HOUR), userAgent: "Mozilla/5.0 (compatible; Barracuda Sentinel)" },
    ],
    carts: [
      { id: "cart-1", email: "a@x.io", firstSeenAt: iso(-2 * HOUR), restoredAt: iso(22 * MIN), checkoutStartedAt: iso(25 * MIN) },
      { id: "cart-2", email: "b@x.io", firstSeenAt: iso(-2 * HOUR), restoredAt: null, checkoutStartedAt: null },
      { id: "cart-3", email: "c@x.io", firstSeenAt: iso(-26 * HOUR), restoredAt: null, checkoutStartedAt: null },
      { id: "cart-4", email: "d@x.io", firstSeenAt: iso(-14 * HOUR), restoredAt: null, checkoutStartedAt: null },
      { id: "cart-5", email: "i@x.io", firstSeenAt: iso(-1 * HOUR), restoredAt: null, checkoutStartedAt: null },
      { id: "cart-int", email: "support@vantalabsresearch.com", firstSeenAt: iso(-2 * HOUR), restoredAt: iso(10 * MIN), checkoutStartedAt: null },
    ],
    orders: [
      { orderId: "o1", email: "a@x.io", paidAt: iso(40 * MIN), amountPaid: 100, refundAmount: 0, discountAmount: 0, marketingSourceKind: "cart_recovery", marketingSourceRef: "cart-1", paymentStatus: "paid", orderType: "product", replacementOf: null },
      { orderId: "o2", email: "c@x.io", paidAt: iso(2 * DAY), amountPaid: 80, refundAmount: 0, discountAmount: 0, marketingSourceKind: "organic", marketingSourceRef: null, paymentStatus: "paid", orderType: "product", replacementOf: null },
      { orderId: "o3", email: "d@x.io", paidAt: iso(1 * DAY), amountPaid: 60, refundAmount: 0, discountAmount: 0, marketingSourceKind: "organic", marketingSourceRef: null, paymentStatus: "paid", orderType: "product", replacementOf: null },
      // A membership renewal from a mailed address is not a recovered sale.
      { orderId: "o4", email: "b@x.io", paidAt: iso(1 * DAY), amountPaid: 49, refundAmount: 0, discountAmount: 0, marketingSourceKind: "cart_recovery", marketingSourceRef: "cart-2", paymentStatus: "paid", orderType: "membership", replacementOf: null },
    ],
    orderItems: [
      { orderId: "o1", unitCostCents: 1500, quantity: 2 },
    ],
  };
}

describe("buildLifecycleFunnel", () => {
  it("reports each cart stage on the strict and the benchmark axes without mixing them", () => {
    const report = buildLifecycleFunnel(fixture());
    const t30m = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "t30m")!;
    expect(t30m).toMatchObject({
      sent: 3, attempted: 4, delivered: 2, bounced: 1, deliveryUnknown: 0,
      openedAny: 2, openedHuman: 1, clickedAny: 1, clickedHuman: 1,
      restored: 1, checkoutAfterRestore: 1,
      paidStrict: 1, paidBenchmark: 1, selfServeInWindow: 0,
      revenueCents: 10_000, cogsCents: 3_000, incentiveCents: 0, grossProfitCents: 7_000,
    });
    const t24h = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "t24h")!;
    expect(t24h).toMatchObject({ sent: 1, delivered: 0, deliveryUnknown: 1, openedHuman: 1, paidStrict: 0, paidBenchmark: 1, selfServeInWindow: 0, revenueCents: 0 });
    const t12h = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "t12h")!;
    expect(t12h).toMatchObject({ sent: 1, delivered: 1, openedAny: 0, paidStrict: 0, paidBenchmark: 0, selfServeInWindow: 1 });
  });

  it("gives the cart flow a total row with eligibility, and carries the benchmark floor and target", () => {
    const report = buildLifecycleFunnel(fixture());
    const total = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "all")!;
    // Five real carts entered the window; the internal one is not counted.
    expect(total.eligible).toBe(5);
    expect(total.sent).toBe(5);
    expect(total.paidStrict).toBe(1);
    expect(total.benchmark).toEqual(CART_RECOVERY_BENCHMARK);
    expect(total.readable).toBe(false);
    expect(MIN_READABLE_SENDS).toBe(150);
  });

  it("classifies a scanner click on a welcome send as a click but not a human one, and has no eligibility for automations", () => {
    const report = buildLifecycleFunnel(fixture());
    const welcome = report.rows.find((r) => r.flow === "automation:welcome_intro" && r.stage === "all")!;
    expect(welcome).toMatchObject({ sent: 1, delivered: 1, clickedAny: 1, clickedHuman: 0, paidStrict: 0, eligible: null, benchmark: null });
  });

  it("computes rates against delivered when there is one, and says which denominator it used", () => {
    const report = buildLifecycleFunnel(fixture());
    const t30m = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "t30m")!;
    expect(t30m.denominator).toBe("delivered");
    expect(t30m.rates.clickHuman).toBeCloseTo(0.5);
    expect(t30m.rates.paidStrict).toBeCloseTo(0.5);
    const t24h = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "t24h")!;
    expect(t24h.denominator).toBe("sent");
  });

  it("never lists auth mail, internal recipients or a membership charge as recovered revenue", () => {
    const report = buildLifecycleFunnel(fixture());
    expect(report.rows.some((r) => r.flow.startsWith("auth"))).toBe(false);
    const t30m = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "t30m")!;
    expect(t30m.restored).toBe(1); // the internal cart's restore is not counted
    expect(report.rows.reduce((s, r) => s + (r.stage === "all" ? r.revenueCents : 0), 0)).toBe(10_000);
  });
});
