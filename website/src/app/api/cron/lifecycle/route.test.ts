import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// LIFECYCLE MAIL RUNS ON ITS OWN SCHEDULE, AND ON EXACTLY ONE.
//
// Every time-based job used to share a single 30-minute function with a
// 60-second ceiling — 28 of them. Production recorded a `cron_sweep_timeout`
// on 2026-09-08 with four `cron_sweep_failed` criticals beside it, and the
// timeout alert de-duplicates, so consecutive missed ticks hide behind one
// notification.
//
// That is worse for recovery mail than for anything else in the sweep. A stage
// is due inside a WINDOW (STAGE_WINDOWS), and a window that closes during an
// outage is not sent late — it is skipped permanently. Payment reconciliation
// catches up on its next run; a t72h that was due while the function was being
// killed at sixty seconds never goes at all.
//
// Two failures are worth guarding against, and they pull in opposite
// directions: a job in NEITHER route (silently never runs) and a job in BOTH
// (silently runs twice, and for mail that means two copies of the same
// message). The sweep's own suite asserts the absence; this asserts the
// presence, and the two together make the partition checkable.
// ---------------------------------------------------------------------------

const sentinel = (name: string) => vi.fn(async () => ({ job: name }));

const cartRecovery = sentinel("cartRecovery");
const emailAutomations = sentinel("emailAutomations");
const emailCampaigns = sentinel("emailCampaigns");
const marketingQueue = sentinel("marketingQueue");
const emailRetry = sentinel("emailRetry");
const orderEmailReaper = sentinel("orderEmailReaper");

interface SystemAlert {
  type: string;
  severity: string;
  message: string;
  context: Record<string, unknown>;
}
const recordSystemAlert = vi.fn(async (_alert: SystemAlert) => {});

vi.mock("@/lib/cart-recovery", () => ({ runAbandonedCartSweep: () => cartRecovery() }));
vi.mock("@/lib/email/automations", () => ({ runAutomationSweep: () => emailAutomations() }));
vi.mock("@/lib/email/campaign-sender", () => ({ runCampaignSweep: () => emailCampaigns() }));
vi.mock("@/lib/email/marketing-queue", () => ({ drainMarketingSendQueue: () => marketingQueue() }));
vi.mock("@/lib/email/retry-queue", () => ({ retryPendingEmails: () => emailRetry() }));
vi.mock("@/lib/email/order-email-reaper", () => ({ reapStrandedOrderEmails: () => orderEmailReaper() }));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: (alert: SystemAlert) => recordSystemAlert(alert) }));
vi.mock("@/lib/operator-error", () => ({ describeError: (error: unknown) => String((error as Error)?.message ?? error) }));
vi.mock("@/lib/inventory-reservation", () => ({
  // The REAL shape of the predicate, so the once-only auth retry is exercised
  // rather than stubbed into always-or-never.
  isTransientAuthRejection: (error: unknown) => {
    const message = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? "");
    return message.includes("PGRST303");
  },
}));

const SECRET = "lifecycle-test-secret";

async function callLifecycle(authorization = `Bearer ${SECRET}`) {
  const { GET } = await import("@/app/api/cron/lifecycle/route");
  return GET(new Request("https://example.test/api/cron/lifecycle", { headers: { authorization } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
});

describe("the lifecycle schedule", () => {
  it("runs every customer-facing mail job, exactly once", async () => {
    await callLifecycle();

    for (const job of [cartRecovery, emailAutomations, emailCampaigns, marketingQueue, emailRetry, orderEmailReaper]) {
      expect(job).toHaveBeenCalledTimes(1);
    }
  });

  it("reports every job under its own name, so an alert cannot name the wrong one", async () => {
    const body = (await (await callLifecycle()).json()) as Record<string, { job?: string }>;

    expect(body.cartRecovery).toEqual({ job: "cartRecovery" });
    expect(body.emailAutomations).toEqual({ job: "emailAutomations" });
    expect(body.emailCampaigns).toEqual({ job: "emailCampaigns" });
    expect(body.marketingQueue).toEqual({ job: "marketingQueue" });
    expect(body.emailRetry).toEqual({ job: "emailRetry" });
    expect(body.orderEmailReaper).toEqual({ job: "orderEmailReaper" });
  });

  it("refuses a request that does not carry the scheduler's secret", async () => {
    const response = await callLifecycle("Bearer wrong");

    expect(response.status).toBe(401);
    expect(cartRecovery).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request outright", async () => {
    const response = await callLifecycle("");

    expect(response.status).toBe(401);
    expect(cartRecovery).not.toHaveBeenCalled();
  });

  it("keeps going when one job fails, and raises it under its own label", async () => {
    // A failing win-back must not stop the recovery ladder: these are
    // independent flows that happen to share a schedule.
    emailAutomations.mockRejectedValueOnce(new Error("automations exploded"));

    const body = (await (await callLifecycle()).json()) as Record<string, unknown>;

    expect(cartRecovery).toHaveBeenCalledTimes(1);
    expect(body.cartRecovery).toEqual({ job: "cartRecovery" });
    expect(body.emailAutomations).toEqual({ error: "automations exploded" });

    expect(recordSystemAlert).toHaveBeenCalledTimes(1);
    const alert = recordSystemAlert.mock.calls[0][0];
    expect(alert.type).toBe("cron_lifecycle_failed");
    expect(alert.severity).toBe("critical");
    expect(alert.message).toContain("email_automations");
  });

  it("retries once after a transient auth refusal, which is infrastructure rather than a bug", async () => {
    cartRecovery.mockRejectedValueOnce(new Error("PGRST303: JWT issued at future"));

    const body = (await (await callLifecycle()).json()) as Record<string, unknown>;

    expect(cartRecovery).toHaveBeenCalledTimes(2);
    expect(body.cartRecovery).toEqual({ job: "cartRecovery" });
    expect(recordSystemAlert).not.toHaveBeenCalled();
  });

  it("does not retry an ordinary failure — one retry is for auth, not for bugs", async () => {
    cartRecovery.mockRejectedValueOnce(new Error("cannot read property of undefined"));

    await callLifecycle();

    expect(cartRecovery).toHaveBeenCalledTimes(1);
  });
});
