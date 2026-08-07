import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The sweep fans nine jobs into Promise.allSettled and destructures the results
// positionally. Nothing keys a name to its promise, so inserting a job in the
// middle shifts every result after it onto the wrong variable -- and the code
// still compiles, still runs, and still returns 200.
//
// That had already happened: the Shippo push was being reported (and alerted)
// as the express-intent job, and the express-intent job was reported as Shippo.
// These tests give every job a distinct return value so a swap cannot pass.
// ---------------------------------------------------------------------------

const sentinel = (name: string) => vi.fn(async () => ({ job: name }));

const membership = sentinel("membership");
const storeCredit = sentinel("storeCredit");
const cartRecovery = sentinel("cartRecovery");
const commissions = sentinel("commissions");
const reservations = sentinel("reservations");
const emails = sentinel("emails");
const paymentReconcile = sentinel("paymentReconcile");
const expressIntents = sentinel("expressIntents");
const shippoSync = sentinel("shippoSync");
interface SystemAlert {
  type: string;
  severity: string;
  message: string;
  context: Record<string, string>;
}
const recordSystemAlert = vi.fn(async (_alert: SystemAlert) => {});

vi.mock("@/lib/membership-billing", () => ({
  runMembershipBillingSweep: () => membership(),
  grantMonthlyStoreCreditSweep: () => storeCredit(),
}));
vi.mock("@/lib/cart-recovery", () => ({ runAbandonedCartSweep: () => cartRecovery() }));
vi.mock("@/lib/partner-portal", () => ({ autoApproveEligibleCommissions: () => commissions() }));
vi.mock("@/lib/inventory-reservation", () => ({ expireStaleReservations: () => reservations() }));
vi.mock("@/lib/email/retry-queue", () => ({ retryPendingEmails: () => emails() }));
vi.mock("@/lib/express-reconcile", () => ({
  reconcileVeyraPendingPayments: () => paymentReconcile(),
  expireStaleExpressIntents: () => expressIntents(),
}));
vi.mock("@/lib/shippo/order-sync", () => ({ sweepUnsyncedOrders: () => shippoSync() }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: (alert: SystemAlert) => recordSystemAlert(alert) }));

const SECRET = "test-cron-secret";

async function callSweep(authorization = `Bearer ${SECRET}`) {
  const { GET } = await import("./route");
  return GET(new Request("https://vantalabsresearch.com/api/cron/sweep", { headers: { authorization } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env.CRON_SECRET = SECRET;
});

describe("the scheduled sweep", () => {
  it("reports every job under its own name", async () => {
    const body = (await (await callSweep()).json()) as Record<string, { job?: string }>;

    expect(body.membershipBilling).toEqual({ job: "membership" });
    expect(body.cartRecovery).toEqual({ job: "cartRecovery" });
    expect(body.storeCredit).toEqual({ job: "storeCredit" });
    expect(body.commissionApproval).toEqual({ job: "commissions" });
    expect(body.reservationsExpired).toEqual({ job: "reservations" });
    expect(body.emailRetry).toEqual({ job: "emails" });
    expect(body.paymentReconcile).toEqual({ job: "paymentReconcile" });
    // The two that were crossed.
    expect(body.shippoSync).toEqual({ job: "shippoSync" });
    expect(body.expressIntentsExpired).toEqual({ job: "expressIntents" });
  });

  it("runs every job exactly once", async () => {
    await callSweep();

    for (const job of [membership, storeCredit, cartRecovery, commissions, reservations, emails, paymentReconcile, expressIntents, shippoSync]) {
      expect(job).toHaveBeenCalledTimes(1);
    }
  });

  // The point of the alert is that the operator can tell WHICH job broke without
  // reading the code. A mislabelled alert sends them to the wrong system during
  // the one moment the label matters.
  it("names the failing job correctly when Shippo cannot be reached", async () => {
    shippoSync.mockRejectedValueOnce(new Error("shippo unreachable"));

    await callSweep();

    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
    const alert = recordSystemAlert.mock.calls[0][0];
    expect(alert.message).toContain("shippo_sync");
    expect(alert.message).not.toContain("express_intent");
    expect(Object.keys(alert.context)).toEqual(["shippo_sync"]);
  });

  it("alerts on express-intent expiry too, rather than dropping it silently", async () => {
    expressIntents.mockRejectedValueOnce(new Error("nope"));

    await callSweep();

    const alert = recordSystemAlert.mock.calls[0][0];
    expect(alert.message).toContain("express_intent_expiry");
    expect(alert.message).not.toContain("shippo_sync");
  });

  // One job failing must not abandon the other eight -- that is the whole
  // reason this uses allSettled rather than all.
  it("still runs and reports the other jobs when one throws", async () => {
    reservations.mockRejectedValueOnce(new Error("db down"));

    const body = (await (await callSweep()).json()) as Record<string, unknown>;

    expect(body.success).toBe(true);
    expect(shippoSync).toHaveBeenCalledTimes(1);
    expect(body.membershipBilling).toEqual({ job: "membership" });
  });

  it("stays quiet when everything succeeds", async () => {
    await callSweep();

    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("refuses a request without the secret", async () => {
    const response = await callSweep("Bearer wrong-secret");

    expect(response.status).toBe(401);
    expect(shippoSync).not.toHaveBeenCalled();
  });
});
