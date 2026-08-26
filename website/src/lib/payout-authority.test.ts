import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// WHO IS ALLOWED TO SEND AN AMBASSADOR MONEY.
//
// Two files in this repo have names that claim payout coverage —
// ambassador-payout.test.ts and final-invariants.test.ts "INVARIANT 10" — and
// between them they test one thing: the isValidPayoutMethod string enum. No
// test anywhere imported PATCH from
// src/app/api/admin/partners/[partnerId]/route.ts, and no test ever exercised
// the two guards inside markCommissionsPaid.
//
// A sabotage sweep confirmed it. Each of these was applied in turn and the
// FULL suite — 3,620 tests — stayed green every time:
//
//   1. delete `if (!canManageRefunds(session.role))` from the route
//   2. hardcode `confirmedTransferred: true` instead of reading the body
//   3. hardcode `overrideMinimumThreshold: true` instead of reading the body
//   4. delete the minimum-payout-threshold check in partner-portal
//   5. delete the `partnerStatus !== "approved"` check in partner-portal
//
// Every one of those moves real money to a real person. (4) pays out a balance
// the owner set a floor for; (5) releases the held balance of an ambassador who
// was disabled or suspended for fraud; (1) hands all of it to a packer.
//
// The guards are correct. They were simply unproven, which is not the same
// thing — nothing would have told anyone if a refactor removed one.
//
// This drives the REAL route handler and the REAL markCommissionsPaid against
// a stateful fake database that models conditional-UPDATE row counts, so the
// atomic claim behaves as it does in Postgres.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));

vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return db.current.client; },
  createServerClient: () => db.current.client,
}));

const session = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: () => session(),
  getRequestIpAddress: () => "203.0.113.9",
  getRequestUserAgent: () => "test-agent",
}));

const sentEmails = vi.hoisted(() => [] as Array<{ to: string; subject: string }>);
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string }) => {
    sentEmails.push({ to: input.to, subject: input.subject });
    return { success: true };
  },
}));

const settings = vi.hoisted(() => ({ minimumPayoutThreshold: 100, minimumQualifyingOrder: 100, commissionHoldDays: 14 }));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => settings,
  setAmbassadorProgramSetting: async () => {},
}));

const PARTNER = "11111111-1111-1111-1111-111111111111";

/**
 * An ambassador with `pending` dollars sitting in approved_for_payout, ready to
 * be released. `status` is what the disabled/suspended guard reads.
 */
function seedAmbassador(options: { status: string; commissions: number[] }) {
  db.current = createFakeDb();
  db.current.table("partners").push({
    id: PARTNER, name: "Jaeley Reynolds", email: "amb@example.test",
    referral_code: "JAELEY", status: options.status,
    payout_method: "paypal", payout_handle: "amb@example.test",
  });
  db.current.table("ambassadors").push({
    id: PARTNER, name: "Jaeley Reynolds", email: "amb@example.test",
    referral_code: "JAELEY", status: options.status,
    payout_method: "paypal", payout_handle: "amb@example.test",
  });
  options.commissions.forEach((amount, index) => {
    db.current.table("referral_orders").push({
      id: `ro-${index}`, order_id: `order-${index}`, ambassador_id: PARTNER,
      commission_amount: amount, payment_status: "approved_for_payout",
    });
  });
}

function payouts() {
  return db.current.table("partner_payouts");
}

function paidCommissions() {
  return db.current.table("referral_orders").filter((row) => row.payment_status === "paid");
}

async function patch(body: Record<string, unknown>) {
  const { PATCH } = await import("@/app/api/admin/partners/[partnerId]/route");
  const response = await PATCH(
    new Request(`http://localhost/api/admin/partners/${PARTNER}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ partnerId: PARTNER }) },
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

const MARK_PAID = { action: "mark_paid", confirmedTransferred: true, overrideMinimumThreshold: true };

beforeEach(() => {
  vi.resetModules();
  sentEmails.length = 0;
  settings.minimumPayoutThreshold = 100;
  session.mockResolvedValue({ username: "owner", role: "super_admin" });
  seedAmbassador({ status: "approved", commissions: [120] });
});

describe("only the right people can release a payout", () => {
  it("refuses an anonymous caller, and moves nothing", async () => {
    session.mockResolvedValue(null);
    const { status } = await patch(MARK_PAID);

    expect(status).toBe(401);
    expect(payouts()).toHaveLength(0);
    expect(paidCommissions()).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("refuses a staff account — this sends money to a person", async () => {
    session.mockResolvedValue({ username: "packer", role: "staff" });
    const { status } = await patch(MARK_PAID);

    expect(status).toBe(403);
    expect(payouts()).toHaveLength(0);
    expect(paidCommissions()).toHaveLength(0);
  });

  it("allows a manager", async () => {
    session.mockResolvedValue({ username: "manager", role: "manager" });
    const { status } = await patch(MARK_PAID);

    expect(status).toBe(200);
    expect(payouts()).toHaveLength(1);
  });

  it("allows the owner", async () => {
    const { status } = await patch(MARK_PAID);
    expect(status).toBe(200);
    expect(payouts()).toHaveLength(1);
    expect(Number(payouts()[0].amount)).toBe(120);
  });
});

describe("the two flags that move money are read from the request, not assumed", () => {
  it("refuses to record a payout the admin never confirmed sending", async () => {
    // The money leaves Vanta by hand (Zelle / PayPal). Recording a payout the
    // owner did not actually send flips the commissions to "paid" and the
    // ambassador is never paid — there is no processor record to reconcile
    // against afterwards.
    const { status, body } = await patch({ action: "mark_paid", overrideMinimumThreshold: true });

    expect(status).toBe(400);
    // The refusal must name the reason. A generic 400 is indistinguishable
    // from a malformed request, and this one is the difference between an
    // ambassador being paid and the books saying they were.
    expect(String(body?.error)).toMatch(/confirm/i);
    expect(payouts()).toHaveLength(0);
    expect(paidCommissions()).toHaveLength(0);
  });

  it("refuses a balance below the owner's minimum unless the threshold is overridden", async () => {
    seedAmbassador({ status: "approved", commissions: [25.5] });
    const { status, body } = await patch({ action: "mark_paid", confirmedTransferred: true });

    expect(status).toBe(400);
    expect(String(body?.error)).toMatch(/minimum payout threshold/i);
    // $25.50 against a $100 floor — and it names both figures, so the operator
    // can see how far short it is.
    expect(String(body?.error)).toContain("25.50");
    expect(String(body?.error)).toContain("100.00");
    expect(payouts()).toHaveLength(0);
    expect(paidCommissions()).toHaveLength(0);
  });

  it("pays that same small balance when the threshold IS explicitly overridden", async () => {
    // The negative control for the test above: the guard must be a threshold,
    // not a blanket refusal.
    seedAmbassador({ status: "approved", commissions: [25.5] });
    const { status } = await patch({ action: "mark_paid", confirmedTransferred: true, overrideMinimumThreshold: true });

    expect(status).toBe(200);
    expect(Number(payouts()[0].amount)).toBe(25.5);
  });

  it("a truthy-but-not-true confirmation is not a confirmation", async () => {
    // `=== true` rather than a truthy check: "false", 1 and "yes" all arrive as
    // JSON from a hand-rolled client and none of them is a human confirming
    // they sent the money.
    for (const value of ["true", 1, "yes", {}]) {
      seedAmbassador({ status: "approved", commissions: [120] });
      const { status } = await patch({ action: "mark_paid", confirmedTransferred: value, overrideMinimumThreshold: true });
      expect(status).toBe(400);
      expect(payouts()).toHaveLength(0);
    }
  });
});

describe("a suspended ambassador's balance stays held", () => {
  for (const status of ["disabled", "pending", "rejected", "suspended"]) {
    it(`refuses to pay an ambassador whose status is "${status}"`, async () => {
      // This guard is what holds the balance of someone disabled for fraud.
      // Deleting it left the entire suite green.
      seedAmbassador({ status, commissions: [120] });
      const response = await patch(MARK_PAID);

      expect(response.status).toBe(400);
      // Names the status, so the operator knows to re-approve rather than
      // assuming the payout system is broken.
      expect(String(response.body?.error)).toMatch(/not currently approved/i);
      expect(String(response.body?.error)).toContain(status);
      expect(payouts()).toHaveLength(0);
      expect(paidCommissions()).toHaveLength(0);
      expect(sentEmails).toHaveLength(0);
    });
  }

  it("pays the same balance once they are approved again", async () => {
    // The negative control: the guard must key on the status, not refuse
    // everything.
    seedAmbassador({ status: "approved", commissions: [120] });
    const { status } = await patch(MARK_PAID);
    expect(status).toBe(200);
    expect(payouts()).toHaveLength(1);
  });
});
