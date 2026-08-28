import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeDb, type FakeDb } from "@/lib/e2e/fake-db";

// ---------------------------------------------------------------------------
// VL-21 / F-A-5 — A REVERSAL THAT FAILED HALFWAY REPORTED SUCCESS AND LOCKED
// ITSELF OUT.
//
// reversePayout moves money in three places: the referral_orders rows the
// payout paid, the commissions ledger that mirrors them, and the two payout
// tables that record the reversal. Every one of those writes discarded its
// error — `const { data: reset } = await ...` — and the payout was stamped
// `reversed_at` at the end regardless.
//
// So a single failed statement produced: two ledgers disagreeing about real
// money, a return value of `reversedCommissions: 0` that reads exactly like a
// payout which had paid nothing, and — because `reversed_at` is also this
// function's re-entry guard — an admin whose only repair tool now answers
// "This payout has already been reversed."
//
// Worse, the write that used to go FIRST is the one that destroys the evidence:
// resetting referral_orders nulls `payout_id`, the only link from a commission
// back to the payout that paid it. A commissions row still reading `paid` after
// that is unreachable by payout id from anywhere.
//
// These tests fail one statement at a time and assert the two properties that
// make the operation recoverable: nothing is ever reported as reversed unless
// it was, and re-running the reversal finishes the job.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const db = vi.hoisted(() => ({ current: null as unknown as FakeDb }));
vi.mock("@/lib/supabase-server", () => ({
  get supabaseAdmin() { return db.current.client; },
  createServerClient: () => db.current.client,
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));

const PAYOUT = "payout-1111";
const AMBASSADOR = "amb-2222";

function seed() {
  db.current = createFakeDb();
  db.current.seed("partner_payouts", [
    { id: PAYOUT, ambassador_id: AMBASSADOR, amount: 240, reversed_at: null },
  ]);
  db.current.seed("payouts", [
    { id: PAYOUT, partner_id: AMBASSADOR, amount: 240, reversed_at: null },
  ]);
  db.current.seed("referral_orders", [
    { id: "ro-1", order_id: "order-1", ambassador_id: AMBASSADOR, payout_id: PAYOUT, payment_status: "paid", commission_amount: 140, commission_paid_at: "2026-08-01T00:00:00.000Z" },
    { id: "ro-2", order_id: "order-2", ambassador_id: AMBASSADOR, payout_id: PAYOUT, payment_status: "paid", commission_amount: 100, commission_paid_at: "2026-08-01T00:00:00.000Z" },
  ]);
  db.current.seed("commissions", [
    { id: "c-1", order_id: "order-1", partner_id: AMBASSADOR, status: "paid", amount: 140 },
    { id: "c-2", order_id: "order-2", partner_id: AMBASSADOR, status: "paid", amount: 100 },
  ]);
}

async function reverse() {
  const { reversePayout } = await import("@/lib/partner-portal");
  return reversePayout({ payoutId: PAYOUT, actorUsername: "owner", reason: "paid twice" });
}

/** What every ledger says about this payout right now. */
function state() {
  return {
    referralStatuses: db.current.rows("referral_orders").map((row) => String(row.payment_status)).sort(),
    commissionStatuses: db.current.rows("commissions").map((row) => String(row.status)).sort(),
    stamped: Boolean(db.current.rows("partner_payouts")[0].reversed_at),
    mirrorStamped: Boolean(db.current.rows("payouts")[0].reversed_at),
  };
}

beforeEach(() => {
  vi.resetModules();
  seed();
});

describe("a payout reversal that completes", () => {
  it("resets both ledgers and stamps both payout records", async () => {
    expect(await reverse()).toEqual({ reversedCommissions: 2, amount: 240 });
    expect(state()).toEqual({
      referralStatuses: ["approved_for_payout", "approved_for_payout"],
      commissionStatuses: ["approved_for_payout", "approved_for_payout"],
      stamped: true,
      mirrorStamped: true,
    });
  });

  it("refuses a second reversal of the same payout", async () => {
    await reverse();
    await expect(reverse()).rejects.toThrow(/already been reversed/i);
  });
});

describe("a payout reversal that fails partway", () => {
  for (const [label, failure] of [
    ["the commissions mirror", { table: "commissions", op: "update" }],
    ["the referral_orders reset", { table: "referral_orders", op: "update" }],
    ["the payouts stamp", { table: "payouts", op: "update" }],
    ["the partner_payouts stamp", { table: "partner_payouts", op: "update" }],
  ] as const) {
    it(`throws instead of reporting a reversal when ${label} fails`, async () => {
      db.current.injectFailure({ ...failure, times: 1 });
      await expect(reverse()).rejects.toThrow();
    });

    it(`leaves the payout reversible after ${label} fails`, async () => {
      // The property that matters: the admin can run the reversal again and the
      // books end up exactly where a clean run would have left them.
      db.current.injectFailure({ ...failure, times: 1 });
      await expect(reverse()).rejects.toThrow();

      await reverse();
      expect(state()).toEqual({
        referralStatuses: ["approved_for_payout", "approved_for_payout"],
        commissionStatuses: ["approved_for_payout", "approved_for_payout"],
        stamped: true,
        mirrorStamped: true,
      });
    });
  }

  it("never strands a commissions row as paid with its payout link gone", async () => {
    // The unrecoverable shape, stated directly. If referral_orders is reset
    // before the commissions mirror lands, `payout_id` is null and a paid
    // commission can no longer be found by the payout that paid it.
    db.current.injectFailure({ table: "commissions", op: "update", times: 1 });
    await expect(reverse()).rejects.toThrow();

    const orphaned = db.current.rows("commissions").filter((row) => String(row.status) === "paid");
    const stillLinked = db.current.rows("referral_orders").filter((row) => row.payout_id === PAYOUT);
    expect(orphaned.length).toBeGreaterThan(0);
    expect(stillLinked.length).toBe(orphaned.length);
  });
});
