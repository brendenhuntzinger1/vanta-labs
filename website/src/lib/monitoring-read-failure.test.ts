import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// ADM-05 — A FAILED ALERTS READ IS NOT "NO ALERTS".
//
// getOpenCriticalAlertCount answered 0 and getOpenSystemAlerts answered [] when
// the system_alerts read failed. Both are the healthy answers too, so a database
// that would not respond drew a blank nav badge and "No unresolved system
// alerts 🎉" — an all-clear on the screens an operator opens to find out whether
// anything is wrong. Both callers already run the readers through settleRead(),
// which is where failing soft belongs: the page stays up AND the failure
// reaches the pixel. So the readers must THROW, or settleRead has nothing to
// carry.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ error: null as { message: string } | null, count: 3, rows: [{ id: "a-1" }] }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase-server", () => {
  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "order", "limit", "insert", "update", "in", "gte"]) {
      b[name] = () => b;
    }
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        state.error
          ? { data: null, count: null, error: state.error }
          : { data: state.rows, count: state.count, error: null },
      ).then(resolve);
    return b;
  }
  return { supabaseAdmin: { from: () => builder() } };
});

const { getOpenCriticalAlertCount, getOpenSystemAlerts } = await import("@/lib/monitoring");
const { settleRead } = await import("@/lib/admin-read");

beforeEach(() => {
  state.error = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getOpenCriticalAlertCount", () => {
  it("answers the count when the read works", async () => {
    expect(await getOpenCriticalAlertCount()).toBe(3);
  });

  it("THROWS when the read fails, rather than answering the all-clear 0", async () => {
    state.error = { message: 'relation "system_alerts" does not exist' };
    await expect(getOpenCriticalAlertCount()).rejects.toThrow(/system_alerts/);
  });

  it("is carried as a failure by settleRead, so the layout can draw an error badge", async () => {
    state.error = { message: "timeout" };
    const read = await settleRead("Critical alerts", getOpenCriticalAlertCount);
    expect(read.ok).toBe(false);
  });
});

describe("getOpenSystemAlerts", () => {
  it("answers the rows when the read works", async () => {
    expect(await getOpenSystemAlerts()).toEqual([{ id: "a-1" }]);
  });

  it("THROWS when the read fails, rather than answering the all-clear []", async () => {
    state.error = { message: "connection refused" };
    await expect(getOpenSystemAlerts({ severity: "critical" })).rejects.toThrow(/system_alerts read failed/);
  });
});
