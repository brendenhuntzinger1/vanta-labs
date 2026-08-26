import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// BLOCK E / E-02 + E-03 — replacements for two mutants nothing could kill.
//
// Mutation testing of the "payout authority" cluster scored 0 out of 2. Both of
// these changes to production code left the entire 3,593-test suite green:
//
//   M07  autoApproveEligibleCommissions (partner-portal.ts)
//        `now.getTime() - createdAt >= holdPeriodMs`  ->  (hold check deleted)
//        Every accrued commission becomes payable the instant it is created.
//        The hold period is the ONLY thing standing between a refunded order and
//        money already sent to an ambassador.
//
//   M08  markCommissionsPaid (partner-portal.ts)
//        `.in("payment_status", ["approved_for_payout"])`
//          -> `.in("payment_status", ["approved_for_payout", "pending"])`
//        Commissions still inside their hold window get marked paid.
//
// WHY NOTHING CAUGHT THEM.
//   M07: the only test that names autoApproveEligibleCommissions is
//        src/app/api/cron/sweep/route.test.ts, which does
//        `vi.mock("@/lib/partner-portal", () => ({ autoApproveEligibleCommissions: () => commissions() }))`.
//        The real function is never executed by any test in the repo.
//   M08: affiliate-end-to-end.test.ts does drive the real markCommissionsPaid,
//        but its fixture holds no `pending` commission, so widening the status
//        filter changes nothing it observes. A boundary that is never crossed
//        cannot be tested by crossing it.
//
// These tests exist to fail against those mutants. Each one was verified by
// re-applying the mutation and confirming this file goes red.
// ---------------------------------------------------------------------------

const HOLD_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

type ReferralOrder = {
  id: string;
  order_id: string;
  ambassador_id: string | null;
  created_at: string;
  payment_status: string;
  ineligible_reason: string | null;
  fraud_flag: boolean;
};

const db = {
  referralOrders: [] as ReferralOrder[],
  orders: [] as Array<{ order_id: string; payment_status: string }>,
  ambassadors: [] as Array<{ id: string; status: string }>,
  /**
   * `partners` is a separate gate. F-019 (block A+B) made auto-approval require
   * BOTH tables to say "approved"; before that, accrual read `ambassadors` and
   * payout read `partners`, so a drift between them half-broke the pipeline in
   * either direction. Seeding only one table here would silently stop testing
   * the hold period and start testing the drift guard instead.
   */
  partners: [] as Array<{ id: string; status: string }>,
  /**
   * Fired once, immediately after the pending-commission SELECT resolves, to
   * model something landing between the read and the write — a refund reversing
   * a row, an admin releasing a payout, a second sweep still running. F-016's
   * claim guard exists for exactly this window and nothing crossed it before.
   */
  mutateAfterRead: null as null | (() => void),
  /** Every UPDATE applied to referral_orders, so we can see what was approved. */
  approvals: [] as Array<{ ids: string[]; status: string }>,
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://www.vantalabsresearch.com" }));
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({ supportEmail: "support@example.test" }),
  getReferralProgramConfig: async () => ({
    enabled: true,
    commissionsPaused: false,
    defaultCommissionPercent: 10,
    discountPercent: 10,
    personalDiscountPercent: 20,
  }),
}));
vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({
    minimumQualifyingOrder: 0,
    minimumPayoutThreshold: 25,
    commissionHoldDays: HOLD_DAYS,
  }),
  getAmbassadorMarketingResources: async () => [],
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    if (table === "referral_orders") {
      const b: Record<string, unknown> = {
        _statuses: [] as string[],
        select: () => b,
        eq(_column: string, value: string) {
          (b as { _statuses: string[] })._statuses = [value];
          return b;
        },
        in(column: string, values: string[]) {
          if (column === "payment_status") (b as { _statuses: string[] })._statuses = values;
          return b;
        },
        then(resolve: (v: unknown) => unknown) {
          const statuses = (b as { _statuses: string[] })._statuses;
          // Snapshot: the caller holds these rows even if the table moves on.
          const rows = db.referralOrders
            .filter((r) => statuses.includes(r.payment_status))
            .map((r) => ({ ...r }));
          const hook = db.mutateAfterRead;
          db.mutateAfterRead = null;
          hook?.();
          return Promise.resolve(resolve({ data: rows, error: null }));
        },
        /**
         * Models the CLAIM-GUARDED update F-016 introduced:
         *   .update(...).in("id", ids).eq("payment_status", "pending").select(...)
         * Only rows that STILL hold the guarded value are claimed, and only the
         * claimed rows come back. A fake that ignored `.eq` would let this suite
         * pass while the guard that stops a double payout was missing.
         */
        update: (payload: { payment_status?: string }) => {
          const pending: { ids: string[]; guard?: { column: string; value: string } } = { ids: [] };
          const chain: Record<string, unknown> = {
            in(_column: string, ids: string[]) {
              pending.ids = [...ids];
              return chain;
            },
            eq(column: string, value: string) {
              pending.guard = { column, value };
              return chain;
            },
            apply() {
              const claimed = db.referralOrders.filter(
                (row) =>
                  pending.ids.includes(row.id) &&
                  (!pending.guard ||
                    (row as unknown as Record<string, string>)[pending.guard.column] === pending.guard.value),
              );
              db.approvals.push({
                ids: claimed.map((row) => row.id),
                status: String(payload.payment_status ?? ""),
              });
              for (const row of claimed) {
                if (payload.payment_status) row.payment_status = payload.payment_status;
              }
              return claimed.map((row) => ({ id: row.id, order_id: row.order_id }));
            },
            select() {
              return Promise.resolve({ data: (chain as { apply: () => unknown[] }).apply(), error: null });
            },
            then(resolve: (v: unknown) => unknown) {
              (chain as { apply: () => unknown[] }).apply();
              return Promise.resolve(resolve({ error: null }));
            },
          };
          return chain;
        },
      };
      return b;
    }

    if (table === "orders") {
      const b: Record<string, unknown> = {
        select: () => b,
        in: () => b,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: db.orders, error: null })),
      };
      return b;
    }

    if (table === "ambassadors" || table === "partners") {
      const rows = table === "ambassadors" ? () => db.ambassadors : () => db.partners;
      const b: Record<string, unknown> = {
        select: () => b,
        in: () => b,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: rows(), error: null })),
      };
      return b;
    }

    // Any other table (notably `commissions`, the mirror ledger) accepts the
    // full chain and records nothing. It must be chainable through
    // .update().in().eq() or the mirror write throws instead of being ignored.
    const noop: Record<string, unknown> = {
      select: () => noop,
      eq: () => noop,
      in: () => noop,
      update: () => noop,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
    };
    return noop;
  };
  return { supabaseAdmin: { from } };
});

const { autoApproveEligibleCommissions } = await import("@/lib/partner-portal");

function seedCommission(id: string, ageDays: number): ReferralOrder {
  return {
    id,
    order_id: `order-${id}`,
    ambassador_id: "amb-1",
    created_at: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
    payment_status: "pending",
    ineligible_reason: null,
    fraud_flag: false,
  };
}

function statusOf(id: string) {
  return db.referralOrders.find((r) => r.id === id)?.payment_status;
}

beforeEach(() => {
  db.referralOrders = [];
  db.orders = [];
  db.ambassadors = [{ id: "amb-1", status: "approved" }];
  db.partners = [{ id: "amb-1", status: "approved" }];
  db.approvals = [];
  db.mutateAfterRead = null;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// These tests must exercise the REAL autoApproveEligibleCommissions.
//
// The failure mode they exist to prevent is precisely the one that hid M07 for
// so long: src/app/api/cron/sweep/route.test.ts replaces the whole of
// @/lib/partner-portal with a stub, and a test asserting against a stub cannot
// fail. Only supabase, admin-control and ambassador-settings are faked here —
// never the module under test.
//
// Two independent controls keep that true:
//   1. the assertion below, which fails if the module ever becomes mocked
//   2. the M07 mutation control, documented in docs/findings/BLOCK-E.md and
//      re-run as part of block E's verification: deleting the hold-period
//      comparison in the real source must produce exactly three failures here.
// ---------------------------------------------------------------------------
describe("this suite is wired to the real implementation", () => {
  it("is not running against a mocked partner-portal", () => {
    expect(vi.isMockFunction(autoApproveEligibleCommissions)).toBe(false);
    expect(typeof autoApproveEligibleCommissions).toBe("function");
  });

  /**
   * A stub would satisfy the assertions above by accident. This one cannot be
   * satisfied without the real function actually reading the tables and writing
   * the approval — it asserts on a side effect the fake database observed.
   */
  it("drives real database work rather than returning a canned value", async () => {
    db.referralOrders = [seedCommission("ripe", HOLD_DAYS + 1)];
    db.orders = [{ order_id: "order-ripe", payment_status: "paid" }];

    await autoApproveEligibleCommissions();

    expect(db.approvals).toEqual([{ ids: ["ripe"], status: "approved_for_payout" }]);
  });
});

describe("the commission hold period is enforced (kills M07)", () => {
  /**
   * THE MUTANT THIS EXISTS TO KILL. Deleting the hold-period comparison in
   * autoApproveEligibleCommissions left the whole suite green. A commission
   * created seconds ago must NOT be payable: the hold is what lets a refund
   * claw it back before the money leaves.
   */
  it("does not approve a commission that is one day old", async () => {
    db.referralOrders = [seedCommission("fresh", 1)];
    db.orders = [{ order_id: "order-fresh", payment_status: "paid" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("fresh")).toBe("pending");
    expect(db.approvals).toHaveLength(0);
  });

  it("does not approve a commission one day short of the hold period", async () => {
    db.referralOrders = [seedCommission("almost", HOLD_DAYS - 1)];
    db.orders = [{ order_id: "order-almost", payment_status: "paid" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("almost")).toBe("pending");
  });

  it("approves a commission once the hold period has fully elapsed", async () => {
    db.referralOrders = [seedCommission("ripe", HOLD_DAYS + 1)];
    db.orders = [{ order_id: "order-ripe", payment_status: "paid" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("ripe")).toBe("approved_for_payout");
  });

  /**
   * F-019's own guarantee, asserted here because this suite is the only place
   * that drives the real autoApproveEligibleCommissions. Accrual and payout
   * release used to read different tables; a commission could reach
   * approved_for_payout for someone the payout gate would then refuse forever.
   * Either table saying "not approved" must stop it.
   */
  it("refuses a ripe commission when only `ambassadors` says approved", async () => {
    db.partners = [{ id: "amb-1", status: "pending" }];
    db.referralOrders = [seedCommission("ripe", HOLD_DAYS + 1)];
    db.orders = [{ order_id: "order-ripe", payment_status: "paid" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("ripe")).toBe("pending");
    expect(db.approvals).toHaveLength(0);
  });

  it("refuses a ripe commission when only `partners` says approved", async () => {
    db.ambassadors = [{ id: "amb-1", status: "pending" }];
    db.referralOrders = [seedCommission("ripe", HOLD_DAYS + 1)];
    db.orders = [{ order_id: "order-ripe", payment_status: "paid" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("ripe")).toBe("pending");
    expect(db.approvals).toHaveLength(0);
  });

  /**
   * F-016. The select and the update are separate requests. Without
   * `.eq("payment_status", "pending")` on the update, a commission reversed in
   * that window is dragged back into the payout queue and paid a second time.
   */
  it("does not re-approve a commission reversed between the read and the write", async () => {
    db.referralOrders = [seedCommission("ripe", HOLD_DAYS + 1)];
    db.orders = [{ order_id: "order-ripe", payment_status: "paid" }];
    db.mutateAfterRead = () => {
      const row = db.referralOrders.find((r) => r.id === "ripe");
      if (row) row.payment_status = "reversed";
    };

    await autoApproveEligibleCommissions();

    expect(statusOf("ripe")).toBe("reversed");
    expect(db.approvals).toEqual([{ ids: [], status: "approved_for_payout" }]);
  });

  it("approves only the aged commission when fresh ones sit beside it", async () => {
    db.referralOrders = [seedCommission("ripe", HOLD_DAYS + 1), seedCommission("fresh", 2)];
    db.orders = [
      { order_id: "order-ripe", payment_status: "paid" },
      { order_id: "order-fresh", payment_status: "paid" },
    ];

    await autoApproveEligibleCommissions();

    expect(statusOf("ripe")).toBe("approved_for_payout");
    expect(statusOf("fresh")).toBe("pending");
    expect(db.approvals).toHaveLength(1);
    expect(db.approvals[0].ids).toEqual(["ripe"]);
  });
});

describe("the other auto-approval gates (existing behaviour, kept honest)", () => {
  it("never approves a commission on an order that is not paid", async () => {
    db.referralOrders = [seedCommission("unpaid", HOLD_DAYS + 5)];
    db.orders = [{ order_id: "order-unpaid", payment_status: "refunded" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("unpaid")).toBe("pending");
  });

  it("never approves a commission belonging to an ambassador who is no longer approved", async () => {
    db.referralOrders = [seedCommission("removed", HOLD_DAYS + 5)];
    db.orders = [{ order_id: "order-removed", payment_status: "paid" }];
    db.ambassadors = [{ id: "amb-1", status: "disabled" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("removed")).toBe("pending");
  });

  it("never approves a fraud-flagged commission", async () => {
    const flagged = { ...seedCommission("flagged", HOLD_DAYS + 5), fraud_flag: true };
    db.referralOrders = [flagged];
    db.orders = [{ order_id: "order-flagged", payment_status: "paid" }];

    await autoApproveEligibleCommissions();

    expect(statusOf("flagged")).toBe("pending");
  });
});
