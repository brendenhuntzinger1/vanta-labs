import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// P0-2: THE PRIORITY ORDER WAS A LIST, NOT AN ORDER.
//
// runCronGroup started every job in the same tick of the event loop, so the
// six lifecycle jobs ran concurrently. The comment in the lifecycle route said
// the recovery ladder came "first because it is the one with a closing window",
// and nothing made that true.
//
// It matters because exactly one resource is contended: the 24-hour quiet
// period held per recipient by marketing_send_claim. The loser of that race is
// deferred — which costs an automation nothing and costs a recovery stage the
// send outright, because a stage is due inside a window that closes when the
// next one opens.
//
// Measured in production 2026-09-12: four real carts reached t72h, were
// deferred on every tick of the whole 24-hour window, and none of the four ever
// received the message.
//
// These tests pin the ORDERING GUARANTEE, not the recovery behaviour that
// depends on it — that lives in the cart-recovery suite.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));
vi.mock("@/lib/monitoring", () => ({ recordSystemAlert: vi.fn(async () => {}) }));
vi.mock("@/lib/operator-error", () => ({ describeError: (e: unknown) => String(e) }));
vi.mock("@/lib/inventory-reservation", () => ({ isTransientAuthRejection: () => false }));

import { runCronGroup } from "@/lib/cron-runner";
import { recordSystemAlert } from "@/lib/monitoring";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function tracked(order: string[]) {
  const make = (name: string, delayMs = 0) => ({
    label: name,
    run: async () => {
      order.push(`${name}:start`);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      order.push(`${name}:end`);
      return { ok: name };
    },
  });
  return make;
}

describe("the lifecycle schedule's priority order", () => {
  it("finishes the windowed job before any other job starts", async () => {
    const order: string[] = [];
    const make = tracked(order);
    await runCronGroup({
      jobs: {
        cartRecovery: make("cartRecovery", 20),
        emailAutomations: make("emailAutomations"),
        marketingQueue: make("marketingQueue"),
      },
      group: "lifecycle",
      maxDurationSeconds: 60,
      deadlineMs: 5_000,
      runFirst: ["cartRecovery"],
    });

    // The guarantee: recovery has ENDED before anything else has STARTED.
    expect(order.indexOf("cartRecovery:end")).toBeLessThan(order.indexOf("emailAutomations:start"));
    expect(order.indexOf("cartRecovery:end")).toBeLessThan(order.indexOf("marketingQueue:start"));
  });

  it("still runs the rest when the first-phase job throws", async () => {
    const order: string[] = [];
    const make = tracked(order);
    const result = await runCronGroup({
      jobs: {
        cartRecovery: { label: "cartRecovery", run: async () => { throw new Error("recovery exploded"); } },
        emailAutomations: make("emailAutomations"),
      },
      group: "lifecycle",
      maxDurationSeconds: 60,
      deadlineMs: 5_000,
      runFirst: ["cartRecovery"],
    });

    // A failing first phase must not take the schedule down with it: the other
    // five jobs are unrelated and a swallowed tick is how mail silently stops.
    expect(order).toContain("emailAutomations:end");
    // `success` is "the route ran", not "every job worked" — the route always
    // answers 200 so the scheduler does not retry a whole tick over one job.
    // The failure travels in that job's own key, which is what an operator and
    // the cron_lifecycle_failed alert both read.
    expect(result.success).toBe(true);
    expect(result.cartRecovery).toMatchObject({ error: expect.stringContaining("recovery exploded") });
    expect(result.emailAutomations).toMatchObject({ ok: "emailAutomations" });
  });

  it("is unchanged when no ordering is asked for", async () => {
    const order: string[] = [];
    const make = tracked(order);
    await runCronGroup({
      jobs: { a: make("a", 20), b: make("b") },
      group: "sweep",
      maxDurationSeconds: 60,
      deadlineMs: 5_000,
    });
    // b does not wait for a: the sweep route's 28 jobs keep running concurrently.
    expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
  });

  it("ignores a runFirst name that is not a job rather than taking the schedule down", async () => {
    const order: string[] = [];
    const make = tracked(order);
    const result = await runCronGroup({
      jobs: { emailAutomations: make("emailAutomations") },
      group: "lifecycle",
      maxDurationSeconds: 60,
      deadlineMs: 5_000,
      runFirst: ["cartRecovery"],
    });
    expect(order).toContain("emailAutomations:end");
    expect(result.success).toBe(true);
  });

  it("reports a job held behind the budget as never started, not as stalled", async () => {
    vi.mocked(recordSystemAlert).mockClear();
    const never = new Promise<void>(() => {});
    await runCronGroup({
      jobs: {
        cartRecovery: { label: "cartRecovery", run: async () => { await never; } },
        emailAutomations: { label: "emailAutomations", run: async () => ({ ok: true }) },
      },
      group: "lifecycle",
      maxDurationSeconds: 60,
      deadlineMs: 30,
      runFirst: ["cartRecovery"],
    });
    await tick();

    const timeout = vi.mocked(recordSystemAlert).mock.calls
      .map((c) => c[0])
      .find((a) => a.type === "cron_lifecycle_timeout");
    expect(timeout).toBeTruthy();
    // The distinction an operator needs: recovery hung, automations never ran.
    // Conflating the two sends them to read the wrong code.
    expect((timeout!.context as Record<string, unknown>).stalled).toEqual(["cartRecovery"]);
    expect((timeout!.context as Record<string, unknown>).neverStarted).toEqual(["emailAutomations"]);
  });
});
