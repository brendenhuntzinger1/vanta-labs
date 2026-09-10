import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE QUALIFIER HAS TO REACH THE ROW, NOT JUST THE FUNCTION THAT BUILDS IT.
//
// alert-scan-completeness.test.ts proves the sentence is built correctly.
// alert-population-claims.test.ts proves every counted alert declares its scan.
// Neither proves the two are joined, and an alert that is honest in a unit test
// and complete-sounding in the database would be the worst of the three
// outcomes — the row and the Sentry event are what an operator actually reads.
//
// So this drives recordSystemAlert itself and reads what it wrote.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ inserted: [] as Array<Record<string, unknown>> }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "order", "limit", "update", "in", "gte"]) {
      b[name] = () => b;
    }
    b.insert = (row: Record<string, unknown>) => {
      state.inserted.push(row);
      return Promise.resolve({ error: null });
    };
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
    return b;
  }
  return { supabaseAdmin: { from: () => builder() } };
});
vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ success: true }) }));
vi.mock("@/lib/admin-control", () => ({
  getBusinessSettings: async () => ({ supportEmail: "" }),
  getControlSnapshot: async () => ({}),
}));

const { recordSystemAlert } = await import("@/lib/monitoring");

beforeEach(() => {
  state.inserted = [];
});

describe("recordSystemAlert and the scan behind it", () => {
  it("writes a complete scan's message word for word", async () => {
    await recordSystemAlert({
      type: "proof_complete",
      severity: "warning",
      message: "3 order(s) are unresolved.",
      scan: { truncated: false, scanned: 120 },
    });

    expect(state.inserted[0].message).toBe("3 order(s) are unresolved.");
    expect(state.inserted[0].context).toMatchObject({ scanTruncated: false, scanned: 120 });
  });

  it("will not let a truncated scan reach the row reading as a total", async () => {
    await recordSystemAlert({
      type: "proof_truncated",
      severity: "warning",
      message: "20 approved ambassador(s) have never signed in.",
      scan: { truncated: true, scanned: 500 },
    });

    const row = state.inserted[0];
    expect(String(row.message)).toMatch(/at least/i);
    expect(String(row.message)).toMatch(/incomplete/i);
    expect(String(row.message)).toContain("500");
    expect(row.context).toMatchObject({ scanTruncated: true, scanned: 500 });
  });

  it("keeps the caller's own context alongside the scan record", async () => {
    // The scan keys are merged in, not substituted for what the caller sent —
    // losing the alert's own context to gain its provenance would be a bad trade.
    await recordSystemAlert({
      type: "proof_context",
      severity: "warning",
      message: "9 account(s) waiting.",
      context: { oldestCreatedAt: "2026-09-04T05:33:10Z", stalled: 9 },
      scan: { truncated: true },
    });

    expect(state.inserted[0].context).toMatchObject({
      oldestCreatedAt: "2026-09-04T05:33:10Z",
      stalled: 9,
      scanTruncated: true,
    });
  });

  it("leaves an alert that declares no scan completely untouched", async () => {
    // 64 of 75 call sites report a single named thing — an order, a webhook, a
    // label — and are none of this rule's business. They must not change.
    await recordSystemAlert({
      type: "proof_none",
      severity: "critical",
      message: "Order VL-1 was captured after cancellation.",
      context: { orderId: "VL-1" },
    });

    expect(state.inserted[0].message).toBe("Order VL-1 was captured after cancellation.");
    expect(state.inserted[0].context).toEqual({ orderId: "VL-1" });
  });
});
