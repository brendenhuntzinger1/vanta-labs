import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// RECORDING A PAYOUT THE OWNER ALREADY MADE.
//
// The owner pays ambassadors by hand — Zelle, Cash App, cash at the counter —
// and comes back here to write it down. Two things stopped that from being
// possible for a real payout on 2026-09-14:
//
//   1. The commission was still inside its 30-day hold, so it sat in `pending`
//      and markCommissionsPaid, which only ever claimed approved_for_payout,
//      answered "No approved commissions are pending payout". The money had
//      left the owner's account; the books could not say so.
//   2. The money went by Zelle, which the ambassador-facing method list does
//      not offer. The payout row and the "we've sent your payout" email were
//      stamped with the ambassador's PROFILE method instead of the one the
//      money actually travelled by.
//
// `includeHeld` releases hold-period commissions early, under the same
// eligibility rule the nightly sweep applies (order paid, not fraud-flagged,
// not marked ineligible) minus the wait. `paidVia` / `paidTo` record the real
// channel. Both drive the REAL route and the REAL markCommissionsPaid against
// the stateful fake database.
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

const sentEmails = vi.hoisted(() => [] as Array<{ to: string; subject: string; text?: string }>);
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string; text?: string }) => {
    sentEmails.push({ to: input.to, subject: input.subject, text: input.text });
    return { success: true };
  },
}));

const settings = vi.hoisted(() => ({ minimumPayoutThreshold: 100, minimumQualifyingOrder: 0, commissionHoldDays: 30 }));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => settings,
  setAmbassadorProgramSetting: async () => {},
}));

const PARTNER = "af0b3dd9-0000-4000-8000-000000000001";

type Commission = {
  id: string;
  amount: number;
  status: "approved_for_payout" | "pending";
  orderPaid?: boolean;
  fraud?: boolean;
  ineligible?: string | null;
};

function seed(options: { status?: string; payoutMethod?: string | null; payoutHandle?: string | null; commissions: Commission[] }) {
  db.current = createFakeDb();
  const status = options.status ?? "approved";
  const profile = {
    id: PARTNER, name: "Flavia Rossetti", email: "flavia@example.test",
    referral_code: "FLAVIA", status,
    payout_method: options.payoutMethod === undefined ? "cashapp" : options.payoutMethod,
    payout_handle: options.payoutHandle === undefined ? "$flavia" : options.payoutHandle,
  };
  db.current.table("partners").push({ ...profile });
  db.current.table("ambassadors").push({ ...profile });
  for (const c of options.commissions) {
    db.current.table("referral_orders").push({
      id: c.id, order_id: `order-${c.id}`, ambassador_id: PARTNER,
      commission_amount: c.amount, payment_status: c.status,
      fraud_flag: c.fraud ?? false, ineligible_reason: c.ineligible ?? null,
    });
    db.current.table("commissions").push({
      id: `c-${c.id}`, order_id: `order-${c.id}`, partner_id: PARTNER,
      amount: c.amount, status: c.status,
    });
    db.current.table("orders").push({
      order_id: `order-${c.id}`, ambassador_id: PARTNER,
      payment_status: c.orderPaid === false ? "pending" : "paid",
    });
  }
}

function payouts() { return db.current.table("partner_payouts"); }
function referral(id: string) { return db.current.table("referral_orders").find((r) => r.id === id)!; }
function commissionMirror(id: string) { return db.current.table("commissions").find((r) => r.order_id === `order-${id}`)!; }
function audit() { return db.current.table("admin_audit_logs").filter((r) => r.action === "partner_commission_paid"); }

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
  session.mockResolvedValue({ username: "owner", role: "super_admin" });
});

describe("paying a commission that is still in its hold period", () => {
  it("is refused by default — the hold is the rule, early release is the exception", async () => {
    seed({ commissions: [{ id: "held", amount: 31.5, status: "pending" }] });

    const { status, body } = await patch(MARK_PAID);

    expect(status).toBe(400);
    expect(String(body?.error)).toMatch(/no approved commissions/i);
    expect(referral("held").payment_status).toBe("pending");
    expect(payouts()).toHaveLength(0);
  });

  it("records the payout when the admin explicitly includes the held balance", async () => {
    // Flavia's exact situation: one referred order, paid, two days old, and
    // the owner has already sent the $31.50.
    seed({ commissions: [{ id: "held", amount: 31.5, status: "pending" }] });

    const { status, body } = await patch({ ...MARK_PAID, includeHeld: true });

    expect(status).toBe(200);
    expect(body?.payout?.amount).toBe(31.5);
    expect(body?.payout?.orderCount).toBe(1);
    expect(referral("held").payment_status).toBe("paid");
    expect(referral("held").commission_paid_at).toBeTruthy();
    expect(commissionMirror("held").status).toBe("paid");
    expect(payouts()).toHaveLength(1);
    expect(Number(payouts()[0].amount)).toBe(31.5);
  });

  it("pays the ready balance and the held balance together, as one payout", async () => {
    seed({ commissions: [
      { id: "ready", amount: 60, status: "approved_for_payout" },
      { id: "held", amount: 31.5, status: "pending" },
    ] });

    const { status, body } = await patch({ ...MARK_PAID, includeHeld: true });

    expect(status).toBe(200);
    expect(body?.payout?.amount).toBe(91.5);
    expect(body?.payout?.orderCount).toBe(2);
    expect(payouts()).toHaveLength(1);
    expect(referral("ready").payout_id).toBe(payouts()[0].id);
    expect(referral("held").payout_id).toBe(payouts()[0].id);
  });

  it("never releases a held commission the sweep itself would refuse", async () => {
    // Early release skips the WAIT, not the eligibility rule. A fraud-flagged
    // commission, one marked ineligible, or one whose order was never paid
    // stays exactly where it is — the same three gates
    // autoApproveEligibleCommissions applies.
    seed({ commissions: [
      { id: "held", amount: 31.5, status: "pending" },
      { id: "fraud", amount: 40, status: "pending", fraud: true },
      { id: "ineligible", amount: 12, status: "pending", ineligible: "below_minimum_order" },
      { id: "unpaid", amount: 25, status: "pending", orderPaid: false },
    ] });

    const { status, body } = await patch({ ...MARK_PAID, includeHeld: true });

    expect(status).toBe(200);
    expect(body?.payout?.amount).toBe(31.5);
    expect(referral("held").payment_status).toBe("paid");
    expect(referral("fraud").payment_status).toBe("pending");
    expect(referral("ineligible").payment_status).toBe("pending");
    expect(referral("unpaid").payment_status).toBe("pending");
    expect(commissionMirror("fraud").status).toBe("pending");
  });

  it("still refuses an ambassador who is not currently approved", async () => {
    // Andrew's situation: money in the hold, but his application is still in
    // info_requested. Early release must not become a way around the status
    // gate that holds a suspended ambassador's balance.
    seed({ status: "info_requested", commissions: [{ id: "held", amount: 24, status: "pending" }] });

    const { status, body } = await patch({ ...MARK_PAID, includeHeld: true });

    expect(status).toBe(400);
    expect(String(body?.error)).toMatch(/not currently approved/i);
    expect(referral("held").payment_status).toBe("pending");
    expect(payouts()).toHaveLength(0);
  });

  it("a truthy-but-not-true includeHeld does not release anything", async () => {
    for (const value of ["true", 1, "yes", {}]) {
      seed({ commissions: [{ id: "held", amount: 31.5, status: "pending" }] });
      const { status } = await patch({ ...MARK_PAID, includeHeld: value });
      expect(status).toBe(400);
      expect(referral("held").payment_status).toBe("pending");
    }
  });

  it("writes what was released early into the audit trail", async () => {
    seed({ commissions: [
      { id: "ready", amount: 60, status: "approved_for_payout" },
      { id: "held", amount: 31.5, status: "pending" },
    ] });

    await patch({ ...MARK_PAID, includeHeld: true });

    const [entry] = audit();
    const meta = entry.metadata as Record<string, unknown>;
    expect(meta.heldOrderCount).toBe(1);
    expect(meta.heldAmount).toBe(31.5);
  });
});

describe("recording how the money was actually sent", () => {
  it("stamps the channel the admin used on the payout, not the ambassador's profile method", async () => {
    // Profile says Cash App; the owner paid by Zelle. The record must say Zelle,
    // or nothing in the books matches the bank statement.
    seed({ commissions: [{ id: "ready", amount: 120, status: "approved_for_payout" }] });

    const { status } = await patch({ ...MARK_PAID, paidVia: "zelle", paidTo: "407-555-0100" });

    expect(status).toBe(200);
    expect(payouts()[0].payout_method).toBe("zelle");
    expect(payouts()[0].payout_handle).toBe("407-555-0100");
    // The mirror table carries the same answer.
    expect(db.current.table("payouts")[0].payout_method).toBe("zelle");
    expect(db.current.table("payouts")[0].payout_handle).toBe("407-555-0100");
  });

  it("tells the ambassador the channel that was used", async () => {
    seed({ commissions: [{ id: "ready", amount: 120, status: "approved_for_payout" }] });

    await patch({ ...MARK_PAID, paidVia: "zelle" });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].text).toMatch(/Method: Zelle/);
    // A channel with no handle typed does not inherit the profile's Cash App
    // tag — that would tell the ambassador to look in the wrong app.
    expect(sentEmails[0].text).not.toContain("$flavia");
  });

  it("falls back to the ambassador's profile method when no channel is given", async () => {
    seed({ commissions: [{ id: "ready", amount: 120, status: "approved_for_payout" }] });

    await patch(MARK_PAID);

    expect(payouts()[0].payout_method).toBe("cashapp");
    expect(payouts()[0].payout_handle).toBe("$flavia");
    expect(sentEmails[0].text).toMatch(/Method: Cash App \(\$flavia\)/);
  });

  it("refuses a channel it does not know, and moves nothing", async () => {
    seed({ commissions: [{ id: "ready", amount: 120, status: "approved_for_payout" }] });

    const { status, body } = await patch({ ...MARK_PAID, paidVia: "bitcoin" });

    expect(status).toBe(400);
    expect(String(body?.error)).toMatch(/how the money was sent/i);
    expect(referral("ready").payment_status).toBe("approved_for_payout");
    expect(payouts()).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("keeps the channel and reference in the audit trail", async () => {
    seed({ commissions: [{ id: "ready", amount: 120, status: "approved_for_payout" }] });

    await patch({ ...MARK_PAID, paidVia: "zelle", paidTo: "407-555-0100", transactionReference: "ZL-1234" });

    const meta = audit()[0].metadata as Record<string, unknown>;
    expect(meta.paidVia).toBe("zelle");
    expect(meta.paidTo).toBe("407-555-0100");
    expect(meta.transactionReference).toBe("ZL-1234");
  });
});
