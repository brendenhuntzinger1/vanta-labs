import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_GATEWAY_RETRY_DELAY_MS } from "@/lib/cron-runner";

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

  // -------------------------------------------------------------------------
  // THE SUPABASE EDGE GIVES UP ON A REQUEST AFTER FIVE SECONDS.
  //
  // 2026-09-10: twenty-seven edge 504s in ten hours, every one with an origin
  // time of 5.0–5.4s, every one inside the first ten seconds of a cron tick,
  // on tables of a few dozen rows. PostgREST on this project runs a
  // ten-connection pool, a tick fans out thirty-odd reads at once, and
  // whichever one waits past the edge's limit comes back as a bare
  // "Gateway Timeout" — which the runner treated as a bug in the job and
  // raised as a critical, twice in one afternoon.
  // -------------------------------------------------------------------------
  describe("a request the Supabase edge timed out", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    async function callLifecycleThroughRetry() {
      const pending = callLifecycle();
      await vi.advanceTimersByTimeAsync(JOB_GATEWAY_RETRY_DELAY_MS);
      return (await (await pending).json()) as Record<string, unknown>;
    }

    it("is retried once, in the shape PostgREST actually reports it", async () => {
      // What production raised: a paged read wraps the edge's statusText, and a
      // bare PostgREST error object carries nothing but that text.
      emailAutomations.mockRejectedValueOnce(new Error("marketing opt-in read failed: Gateway Timeout"));
      cartRecovery.mockRejectedValueOnce({ message: "Gateway Timeout" });

      const body = await callLifecycleThroughRetry();

      expect(emailAutomations).toHaveBeenCalledTimes(2);
      expect(cartRecovery).toHaveBeenCalledTimes(2);
      expect(body.emailAutomations).toEqual({ job: "emailAutomations" });
      expect(body.cartRecovery).toEqual({ job: "cartRecovery" });
      expect(recordSystemAlert).not.toHaveBeenCalled();
    });

    it("is retried once when GoTrue is the service that timed out", async () => {
      // auth-js wraps every 5xx in AuthRetryableFetchError; its message is the
      // request URL, so the status is the only thing that says why.
      const refusal = Object.assign(new Error('{"url":"https://example.supabase.co/auth/v1/admin/users"}'), {
        name: "AuthRetryableFetchError",
        status: 504,
      });
      emailAutomations.mockRejectedValueOnce(refusal);

      await callLifecycleThroughRetry();

      expect(emailAutomations).toHaveBeenCalledTimes(2);
      expect(recordSystemAlert).not.toHaveBeenCalled();
    });

    it("is reported when it happens twice, because two in a row is an outage", async () => {
      emailAutomations
        .mockRejectedValueOnce(new Error("marketing opt-in read failed: Gateway Timeout"))
        .mockRejectedValueOnce(new Error("marketing opt-in read failed: Gateway Timeout"));

      const body = await callLifecycleThroughRetry();

      expect(emailAutomations).toHaveBeenCalledTimes(2);
      expect(body.emailAutomations).toEqual({ error: "marketing opt-in read failed: Gateway Timeout" });
      expect(recordSystemAlert).toHaveBeenCalledTimes(1);
      expect(recordSystemAlert.mock.calls[0][0].context).toEqual({
        email_automations: "marketing opt-in read failed: Gateway Timeout",
      });
    });

    it("waits before retrying, so the retry lands after the burst rather than inside it", async () => {
      emailAutomations.mockRejectedValueOnce(new Error("marketing opt-in read failed: Gateway Timeout"));

      const pending = callLifecycle();
      await vi.advanceTimersByTimeAsync(JOB_GATEWAY_RETRY_DELAY_MS - 1);
      expect(emailAutomations).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(emailAutomations).toHaveBeenCalledTimes(2);
    });
  });
});
