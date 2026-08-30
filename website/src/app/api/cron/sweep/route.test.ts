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
const commissionAccrualRepair = sentinel("commissionAccrualRepair");
const reservations = sentinel("reservations");
const emails = sentinel("emails");
const paymentReconcile = sentinel("paymentReconcile");
const expressIntents = sentinel("expressIntents");
const shippoSync = sentinel("shippoSync");
const shipmentRepair = sentinel("shipmentRepair");
const emailCampaigns = sentinel("emailCampaigns");
const emailAutomations = sentinel("emailAutomations");
const shippingCostRepair = sentinel("shippingCostRepair");
const refundEffectRepair = sentinel("refundEffectRepair");
const tenderHolds = sentinel("tenderHolds");
const signupConfirmations = sentinel("signupConfirmations");
const partnerAccess = sentinel("partnerAccess");
const birthdayBonus = sentinel("birthdayBonus");
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
vi.mock("@/lib/membership", () => ({ runBirthdayBonusSweep: () => birthdayBonus() }));
vi.mock("@/lib/cart-recovery", () => ({ runAbandonedCartSweep: () => cartRecovery() }));
vi.mock("@/lib/partner-portal", () => ({ autoApproveEligibleCommissions: () => commissions() }));
vi.mock("@/lib/commission-accrual-repair", () => ({ repairMissingCommissionAccruals: () => commissionAccrualRepair() }));
vi.mock("@/lib/inventory-reservation", () => ({
  expireStaleReservations: () => reservations(),
  // The REAL predicate, not a stub: the retry it gates is the behaviour under
  // test, and a stub that always said false (or always true) would make the
  // retry cases pass for the wrong reason.
  isTransientAuthRejection: (error: unknown) => {
    const message = error instanceof Error
      ? error.message
      : String((error as { message?: unknown } | null)?.message ?? "");
    return /\bjwt\b/i.test(message);
  },
}));
vi.mock("@/lib/tender-reservation", () => ({ releaseAbandonedTenderHolds: () => tenderHolds() }));
vi.mock("@/lib/email/retry-queue", () => ({ retryPendingEmails: () => emails() }));
vi.mock("@/lib/express-reconcile", () => ({
  reconcileVeyraPendingPayments: () => paymentReconcile(),
  expireStaleExpressIntents: () => expressIntents(),
}));
vi.mock("@/lib/shippo/order-sync", () => ({
  sweepUnsyncedOrders: () => shippoSync(),
  sweepMissingShipments: () => shipmentRepair(),
}));
vi.mock("@/lib/email/campaign-sender", () => ({ runCampaignSweep: () => emailCampaigns() }));
vi.mock("@/lib/email/automations", () => ({ runAutomationSweep: () => emailAutomations() }));
vi.mock("@/lib/shipping-cost-repair", () => ({ repairMissingShippingCosts: () => shippingCostRepair() }));
vi.mock("@/lib/refund-effect-repair", () => ({ repairIncompleteRefunds: () => refundEffectRepair() }));
vi.mock("@/lib/auth-health", () => ({
  alertOnStalledSignups: () => signupConfirmations(),
  alertOnPartnersLockedOut: () => partnerAccess(),
}));
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
    expect(body.tenderHoldsReleased).toEqual({ job: "tenderHolds" });
    expect(body.emailRetry).toEqual({ job: "emails" });
    expect(body.paymentReconcile).toEqual({ job: "paymentReconcile" });
    // The two that were crossed.
    expect(body.shippoSync).toEqual({ job: "shippoSync" });
    expect(body.expressIntentsExpired).toEqual({ job: "expressIntents" });
    expect(body.shipmentRepair).toEqual({ job: "shipmentRepair" });
    expect(body.shippingCostRepair).toEqual({ job: "shippingCostRepair" });
    expect(body.refundEffectRepair).toEqual({ job: "refundEffectRepair" });
    expect(body.signupConfirmations).toEqual({ job: "signupConfirmations" });
    expect(body.partnerAccess).toEqual({ job: "partnerAccess" });
  });

  it("runs every job exactly once", async () => {
    await callSweep();

    for (const job of [membership, storeCredit, cartRecovery, commissions, reservations, tenderHolds, emails, paymentReconcile, expressIntents, shippoSync, shipmentRepair, shippingCostRepair, refundEffectRepair, signupConfirmations, partnerAccess]) {
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

  // THE ALERT MUST SAY WHY, NOT JUST WHICH.
  //
  // On 2026-08-28 this alert fired for commission_accrual_repair — the affiliate
  // money path — carrying `{ commission_accrual_repair: "[object Object]" }`.
  // The route returns 200 even when a job rejects, deliberately, so nothing
  // reached the runtime error log either: the reason existed, was handed to the
  // alert, and was destroyed on the way in by `String(reason)`.
  //
  // It is destroyed for the errors this codebase actually throws. A Supabase /
  // PostgREST failure is a plain `{ code, message, details, hint }` object, not
  // an Error, and `String()` on a plain object is that literal text.
  it("carries the REASON a job failed, not [object Object]", async () => {
    // Exactly the shape supabase-js rejects with.
    const postgrestError = {
      code: "42501",
      message: "permission denied for table referral_orders",
      details: null,
      hint: "grant SELECT to service_role",
    };
    commissionAccrualRepair.mockRejectedValueOnce(postgrestError);

    const response = await callSweep();
    const body = await response.json();

    const alert = recordSystemAlert.mock.calls[0][0];
    const reason = String((alert.context as Record<string, unknown>).commission_accrual_repair);

    // What the operator needs in order to act.
    expect(reason).toContain("42501");
    expect(reason).toContain("permission denied for table referral_orders");

    // The regression, stated rather than implied.
    expect(String(postgrestError)).toBe("[object Object]");
    expect(reason).not.toBe("[object Object]");

    // The response body took the same path and had the same bug.
    expect(String(body.commissionAccrualRepair.error)).toContain("42501");
    expect(String(body.commissionAccrualRepair.error)).not.toBe("[object Object]");
  });

  // A MOMENTARY AUTH REFUSAL MUST NOT COST A WHOLE JOB FOR THIRTY MINUTES.
  //
  // PGRST303 "JWT issued at future" is a clock skew between the Vercel lambda
  // and Supabase. Production raised three on 2026-08-28, each killing a
  // DIFFERENT job (commission_accrual_repair, tender_hold_release,
  // store_credit), plus two the day before on expire_stale_reservations. A
  // different job each time is an infrastructure blip hitting whatever was
  // running — not a bug in any one job.
  //
  // inventory-reservation.ts already retried this exact failure, but only for
  // its own three RPCs; every other job was unprotected.
  describe("a momentary auth refusal", () => {
    it("is retried once and the job then succeeds, with no alert", async () => {
      storeCredit.mockRejectedValueOnce({ code: "PGRST303", message: "JWT issued at future" });

      const response = await callSweep();
      const body = await response.json();

      // Ran twice: the refusal, then the retry that worked.
      expect(storeCredit).toHaveBeenCalledTimes(2);
      expect(body.storeCredit).toEqual({ job: "storeCredit" });
      // Nothing to tell the operator — it recovered on its own.
      expect(recordSystemAlert).not.toHaveBeenCalled();
    });

    it("still alerts when the refusal persists, rather than hiding an outage", async () => {
      const refusal = { code: "PGRST303", message: "JWT issued at future" };
      storeCredit.mockRejectedValueOnce(refusal).mockRejectedValueOnce(refusal);

      await callSweep();

      expect(storeCredit).toHaveBeenCalledTimes(2);
      expect(recordSystemAlert).toHaveBeenCalledTimes(1);
      const alert = recordSystemAlert.mock.calls[0][0];
      expect(alert.message).toContain("store_credit");
      // And it says WHY, which is how this was diagnosed in the first place.
      expect(String((alert.context as Record<string, unknown>).store_credit)).toContain("PGRST303");
    });

    it("does NOT retry an ordinary failure — one retry is for auth, not for bugs", async () => {
      // A logic error must fail fast and loudly. Retrying it would double every
      // side effect the job had already performed before throwing.
      cartRecovery.mockRejectedValueOnce(new Error("cannot read property of undefined"));

      await callSweep();

      expect(cartRecovery).toHaveBeenCalledTimes(1);
      expect(recordSystemAlert).toHaveBeenCalledTimes(1);
    });
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

  it("registers the financial repair sweeps", async () => {
    const route = await import("@/app/api/cron/sweep/route");
    // The JOBS registry is keyed, not positional; asserting on the key is
    // asserting on the response contract an operator reads.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/api/cron/sweep/route.ts", "utf8"),
    );
    expect(source).toContain("shippingCostRepair");
    expect(source).toContain("refundEffectRepair");
    expect(route.GET).toBeTypeOf("function");
  });
});

// ---------------------------------------------------------------------------
// CRON-04: THE ONE FAILURE THAT COULD NEVER REPORT ITSELF.
//
// maxDuration is 60 and every alert in the route is written AFTER the jobs
// settle. So when the sweep ran out of time, the platform killed the function
// before a single line of alerting code executed: no system_alerts row, no
// operator email, and the HTTP response nobody reads never arrived either. A
// sweep that times out on every tick was indistinguishable, from every screen
// in the application, from a sweep that was never scheduled.
//
// The watchdog gives up INSIDE the budget so there is still time to say so.
// ---------------------------------------------------------------------------
describe("a sweep that runs out of time", () => {
  it("raises a critical alert naming the jobs that were still running", async () => {
    vi.useFakeTimers();
    // Never settles: exactly what a job blocked on a slow provider looks like.
    // Once, so the hang does not leak into the next test.
    membership.mockImplementationOnce(() => new Promise(() => {}));

    const { GET } = await import("./route");
    const response = GET(new Request("https://vantalabsresearch.com/api/cron/sweep", {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    const body = (await (await response).json()) as Record<string, unknown>;
    vi.useRealTimers();

    expect(recordSystemAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cron_sweep_timeout", severity: "critical" }),
    );
    const [alert] = recordSystemAlert.mock.calls[0] as unknown as [
      { message: string; context: { stalled: string[] }; dedupeWindowMs?: number },
    ];
    expect(alert.context.stalled).toEqual(["membership_billing"]);
    expect(alert.message).toContain("membership_billing");
    expect(body.timedOut).toBe(true);
  });

  it("still reports every job that DID finish", async () => {
    vi.useFakeTimers();
    // Once, so the hang does not leak into the next test.
    membership.mockImplementationOnce(() => new Promise(() => {}));

    const { GET } = await import("./route");
    const response = GET(new Request("https://vantalabsresearch.com/api/cron/sweep", {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    const body = (await (await response).json()) as Record<string, { job?: string; error?: string }>;
    vi.useRealTimers();

    // A partial sweep is still information. The one that hung is named as such
    // rather than silently reported as an empty result.
    expect(body.shippoSync).toEqual({ job: "shippoSync" });
    expect(body.membershipBilling).toEqual({ error: "did not finish before the sweep deadline" });
  });

  it("collapses the repeat, because a sweep that overruns overruns every tick", async () => {
    vi.useFakeTimers();
    // Once, so the hang does not leak into the next test.
    membership.mockImplementationOnce(() => new Promise(() => {}));

    const { GET } = await import("./route");
    const response = GET(new Request("https://vantalabsresearch.com/api/cron/sweep", {
      headers: { authorization: `Bearer ${SECRET}` },
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    await response;
    vi.useRealTimers();

    // 48 criticals and 48 emails a day for one unchanging fact is the storm
    // that buried the real criticals on /admin/status in the first place.
    const [alert] = recordSystemAlert.mock.calls[0] as unknown as [{ dedupeWindowMs?: number }];
    expect(alert.dedupeWindowMs).toBeGreaterThan(0);
  });

  it("says nothing about a timeout when the sweep finishes in time", async () => {
    const body = (await (await callSweep()).json()) as Record<string, unknown>;

    expect(body.timedOut).toBe(false);
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });
});
