import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { createFakeDb, type FakeDb, type Row } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// MEMBERSHIP MONEY EMAILS LEAVE A RECORD AND CANNOT GO OUT TWICE.
//
// The signup receipt, the sweep's renewal receipt, the reminders and the
// payment-failed notice were plain `sendEmail` calls whose result was thrown
// away: a provider refusal at the moment a card was charged left the member
// with money gone and no receipt, no queue row, no log line, no alert. And
// nothing but the caller's discipline stopped a second copy.
//
// Order emails already have both halves — order_email_log's partial unique
// index makes a duplicate impossible, the row records the outcome, and a
// failed send is queued for the retry sweep. Membership receipts now claim a
// slot on the membership ORDER each charge lane books; everything without an
// order goes through sendMembershipEmail, which queues a refusal.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.unmock("@/lib/membership-billing");

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() {
    const client = db.current.client as unknown as Record<string, unknown>;
    client.auth = {
      admin: { getUserById: async () => ({ data: { user: { email: "member@example.test", user_metadata: { full_name: "Test Member" } } }, error: null }) },
    };
    return client;
  },
  createServerClient: () => db.current.client,
}));

const charge = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing-provider", () => ({ getBillingProvider: () => ({ chargeCard: charge }) }));
vi.mock("@/lib/veyra-membership", () => ({
  startVeyraMembership: vi.fn(async () => ({ ok: true, membershipId: "veyra_sub_1" })),
  cancelVeyraMembership: vi.fn(async () => ({ ok: true })),
  skipVeyraMembershipCycle: vi.fn(async () => ({ ok: true })),
  updateVeyraMembershipCard: vi.fn(async () => ({ ok: true })),
  changeVeyraMembershipPlan: vi.fn(async () => ({ ok: true })),
  resumeVeyraMembership: vi.fn(async () => ({ ok: true })),
}));

const provider = vi.hoisted(() => ({
  refuse: false,
  sent: [] as Array<{ to: string; subject: string; idempotencyKey?: string }>,
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string; idempotencyKey?: string }) => {
    if (provider.refuse) return { success: false, error: "provider 503" };
    provider.sent.push(input);
    return { success: true, provider: "test", providerMessageId: `msg-${provider.sent.length}` };
  },
}));
vi.mock("@/lib/email/marketing", () => ({ sendMarketingEmail: async () => ({ success: true }) }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: async () => {} }));
vi.mock("@/lib/store-credit", () => ({
  grantMonthlyStoreCredit: async () => {},
  reconcileMonthlyStoreCredit: async () => {},
}));

const USER = "99999999-9999-9999-9999-999999999999";
const TIER = "tier-pro";
const VEYRA_ID = "veyra_sub_1";
const DAY = 24 * 60 * 60 * 1000;

function seedTier() {
  db.current.table("membership_tiers").push({ id: TIER, slug: "pro", name: "Pro", monthly_price_cents: 2900, annual_price_cents: 29000, intro_price_cents: 0, intro_duration_days: 0, intro_offer_enabled: false, monthly_store_credit_cents: 0 });
}

function emailLog(): Row[] {
  return db.current.table("order_email_log");
}

function queued(): Row[] {
  return db.current.table("pending_emails");
}

function receipts() {
  return provider.sent.filter((e) => /receipt/i.test(e.subject));
}

beforeEach(() => {
  vi.resetModules();
  provider.refuse = false;
  provider.sent.length = 0;
  charge.mockReset();
  charge.mockResolvedValue({ success: true, providerChargeId: "ch_1" });
  db.current = createFakeDb();
  seedTier();
});

describe("the signup receipt", () => {
  it("is recorded against the signup order, sent once, with a provider idempotency key", async () => {
    const { startMembershipSignup } = await import("@/lib/membership-billing");

    await startMembershipSignup({ userId: USER, tierId: TIER, billingCycle: "monthly", tokenIntentId: "ti_1" });

    const order = db.current.table("orders").find((row) => row.order_type === "membership")!;
    expect(order).toBeDefined();
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0].idempotencyKey).toBe(`membership_signup_receipt:${order.order_id}`);
    expect(emailLog()).toHaveLength(1);
    expect(emailLog()[0]).toMatchObject({ order_id: order.order_id, kind: "membership_signup_receipt", status: "sent" });
    expect(String(emailLog()[0].recipient_masked)).not.toContain("member@");
  });

  it("cannot be sent twice for the same charge", async () => {
    const { startMembershipSignup, sendMembershipReceiptOnce } = await import("@/lib/membership-billing");
    await startMembershipSignup({ userId: USER, tierId: TIER, billingCycle: "monthly", tokenIntentId: "ti_1" });
    const order = db.current.table("orders").find((row) => row.order_type === "membership")!;

    // A second caller — a replay, a retry, a future code path — asks again.
    const again = await sendMembershipReceiptOnce({
      orderId: String(order.order_id),
      kind: "membership_signup_receipt",
      to: "member@example.test",
      template: { subject: "Your Pro membership receipt", html: "<p>x</p>", text: "x" },
    });

    expect(again).toBe(true);
    expect(receipts()).toHaveLength(1);
    expect(emailLog()).toHaveLength(1);
  });

  it("records the refusal, queues the receipt for retry, and releases the slot when the provider refuses", async () => {
    provider.refuse = true;
    const { startMembershipSignup } = await import("@/lib/membership-billing");

    const result = await startMembershipSignup({ userId: USER, tierId: TIER, billingCycle: "monthly", tokenIntentId: "ti_1" });

    // The charge stands regardless of the receipt.
    expect(result.success).toBe(true);
    const order = db.current.table("orders").find((row) => row.order_type === "membership")!;
    expect(emailLog()[0]).toMatchObject({ order_id: order.order_id, kind: "membership_signup_receipt", status: "failed" });
    expect(String(emailLog()[0].error)).toContain("provider 503");
    const retry = queued().find((row) => /receipt/i.test(String(row.subject)));
    expect(retry).toBeDefined();
    expect(retry).toMatchObject({ order_id: order.order_id, email_kind: "membership_signup_receipt", status: "pending" });
  });
});

describe("the renewal receipt from the processor webhook", () => {
  function seedVeyraMember() {
    db.current.table("customer_memberships").push({
      user_id: USER, tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: VEYRA_ID,
      cancel_at_period_end: false, next_billing_at: new Date(Date.now() + 30 * DAY).toISOString(),
    });
  }

  it("goes out once even when the same renewal is delivered twice", async () => {
    seedVeyraMember();
    const { handleMembershipEvent } = await import("@/lib/membership-webhook");
    const period = new Date(Date.now() + 30 * DAY).toISOString();

    await handleMembershipEvent("membership.renewed", { membership_id: VEYRA_ID, amount_charged_cents: 2900, next_renewal_at: period });
    await handleMembershipEvent("membership.renewed", { membership_id: VEYRA_ID, amount_charged_cents: 2900, next_renewal_at: period });

    expect(db.current.table("orders").filter((row) => row.order_type === "membership")).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
    expect(emailLog()).toHaveLength(1);
    expect(emailLog()[0]).toMatchObject({ kind: "membership_renewal_receipt", status: "sent" });
  });

  it("still sends a receipt for the NEXT period", async () => {
    seedVeyraMember();
    const { handleMembershipEvent } = await import("@/lib/membership-webhook");

    await handleMembershipEvent("membership.renewed", { membership_id: VEYRA_ID, amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString() });
    await handleMembershipEvent("membership.renewed", { membership_id: VEYRA_ID, amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 60 * DAY).toISOString() });

    expect(receipts()).toHaveLength(2);
  });

  it("queues the receipt when the provider refuses, without failing the webhook", async () => {
    seedVeyraMember();
    provider.refuse = true;
    const { handleMembershipEvent } = await import("@/lib/membership-webhook");

    const result = await handleMembershipEvent("membership.renewed", { membership_id: VEYRA_ID, amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString() });

    expect(result.handled).toBe(true);
    expect(queued().some((row) => row.email_kind === "membership_renewal_receipt")).toBe(true);
  });

  it("still sends the receipt when the order row could not be written", async () => {
    // No order means no slot to claim; the member is still owed a receipt.
    seedVeyraMember();
    db.current.injectFailure({ table: "orders", op: "insert", times: 1 });
    const { handleMembershipEvent } = await import("@/lib/membership-webhook");

    await handleMembershipEvent("membership.renewed", { membership_id: VEYRA_ID, amount_charged_cents: 2900, next_renewal_at: new Date(Date.now() + 30 * DAY).toISOString() });

    expect(receipts()).toHaveLength(1);
    expect(emailLog()).toHaveLength(0);
  });
});

describe("the sweep's renewal receipt", () => {
  it("claims a slot on the renewal order it books", async () => {
    db.current.table("customer_memberships").push({
      user_id: USER, tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: null,
      cancel_at_period_end: false, intro_status: "converted", renewal_reminder_sent_at: null,
      next_billing_amount_cents: 2900, next_billing_at: new Date(Date.now() - DAY).toISOString(),
    });
    const { runMembershipBillingSweep } = await import("@/lib/membership-billing");

    await runMembershipBillingSweep();

    const order = db.current.table("orders").find((row) => row.order_type === "membership")!;
    expect(receipts()).toHaveLength(1);
    expect(emailLog()[0]).toMatchObject({ order_id: order.order_id, kind: "membership_renewal_receipt", status: "sent" });
  });
});

describe("emails with no order behind them", () => {
  it("queues the renewal reminder when the provider refuses, so the spent claim does not lose it", async () => {
    db.current.table("customer_memberships").push({
      user_id: USER, tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: null,
      cancel_at_period_end: false, intro_status: "converted", renewal_reminder_sent_at: null,
      next_billing_amount_cents: 2900, next_billing_at: new Date(Date.now() + 2 * DAY).toISOString(),
    });
    provider.refuse = true;
    const { runMembershipBillingSweep } = await import("@/lib/membership-billing");

    const result = await runMembershipBillingSweep();

    expect(result.renewalRemindersSent).toBe(1);
    expect(queued().some((row) => /renew/i.test(String(row.subject)))).toBe(true);
  });

  it("queues the payment-failed notice when the provider refuses", async () => {
    db.current.table("customer_memberships").push({
      user_id: USER, tier_id: TIER, status: "active", billing_cycle: "monthly", veyra_membership_id: null,
      cancel_at_period_end: false, intro_status: "converted", renewal_reminder_sent_at: null,
      next_billing_amount_cents: 2900, next_billing_at: new Date(Date.now() - DAY).toISOString(),
    });
    charge.mockResolvedValue({ success: false, error: "declined" });
    provider.refuse = true;
    const { runMembershipBillingSweep } = await import("@/lib/membership-billing");

    await runMembershipBillingSweep();

    expect(queued().some((row) => /payment didn't go through/i.test(String(row.subject)))).toBe(true);
  });
});

describe("no membership email is fire-and-forget any more", () => {
  it("membership-billing.ts calls the raw sender in exactly one place — the helper that records a refusal", () => {
    const code = readFileSync("src/lib/membership-billing.ts", "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code.match(/await sendEmail\(/g)).toHaveLength(1);
  });

  it("the webhook lane sends nothing raw either", () => {
    const source = readFileSync("src/lib/membership-webhook.ts", "utf8");
    expect(source).not.toMatch(/\bsendEmail\(/);
  });
});
