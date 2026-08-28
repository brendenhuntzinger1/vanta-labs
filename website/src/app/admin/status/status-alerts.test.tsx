import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { SystemAlertRow } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// VL-23 / ADM-01 / P1-1: THE BADGE SAID 4, THE PAGE SHOWED 2.
//
// getOpenCriticalAlertCount counts every unresolved critical. The page read the
// ten most recent alerts of ANY severity and filtered the resolved ones out
// afterwards. Production held 44 repetitions of one warning against 4
// criticals, so the warnings owned all ten rows and two of the criticals were
// reachable from no screen in the application — while a red badge in the nav
// insisted they existed.
//
// The fix is two things and this file tests the WIRING of both: criticals are
// fetched on their own budget so the count and the list cannot disagree, and
// repeats are folded into one row with a count so a storm cannot fill the
// window. Testing groupOpenAlerts alone would pass against the broken page,
// which is the exact trap the sibling monitoring-alert-orders suite calls out.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({ getOpenSystemAlerts: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirected"); } }));
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromCookie: async () => ({ username: "owner" }),
}));
vi.mock("@/lib/system-status", () => ({ getSystemStatus: async () => [] }));
// Not what this page is about, and both fetch on mount.
vi.mock("@/components/checkout-preflight", () => ({ CheckoutPreflight: () => null }));
vi.mock("@/components/inventory-reservation-check", () => ({ InventoryReservationCheck: () => null }));

vi.mock("@/lib/monitoring", async (importOriginal) => {
  // The grouping and the order-id extraction are the REAL implementations: this
  // test is about the page calling them, not about re-testing them.
  const actual = await importOriginal<typeof import("@/lib/monitoring")>();
  return { ...actual, getOpenSystemAlerts: mocks.getOpenSystemAlerts };
});

let seq = 0;
function alert(type: string, severity: string): SystemAlertRow {
  seq += 1;
  return {
    id: `alert-${seq}`,
    type,
    severity,
    message: `${type} needs attention`,
    context: {},
    created_at: `2026-08-27T00:00:${String(seq).padStart(2, "0")}.000Z`,
    resolved_at: null,
  };
}

// Production's shape, with the storm scaled past the page's own fetch limit.
// The criticals are the OLDEST rows and the storm is everything newer, so a
// newest-first query that is capped at any size returns nothing but storm —
// which is exactly the state that made two criticals unreachable.
const CRITICALS = [
  alert("fulfillment_transmit_failed", "critical"),
  alert("shippo_label_unattributed", "critical"),
  alert("cron_sweep_failed", "critical"),
  alert("inventory_rpc_failed", "critical"),
];
const STORM = Array.from({ length: 150 }, () => alert("shipping_cost_manual_entry_required", "warning"));
const ALL_NEWEST_FIRST = [...CRITICALS, ...STORM].sort((a, b) => b.created_at.localeCompare(a.created_at));

/** How many alert rows the page rendered. */
const rowCount = (html: string) => (html.match(/class="bg-white\/\[0\.02\] p-4"/g) ?? []).length;

async function renderStatusPage() {
  const { default: AdminStatusPage } = await import("./page");
  return renderToStaticMarkup(await AdminStatusPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  // Honours both arguments the page passes, so the page's own choice of limits
  // is what is under test rather than a fixture that hands it the right answer.
  mocks.getOpenSystemAlerts.mockImplementation(async (options?: { severity?: string; limit?: number }) => {
    const pool = options?.severity
      ? ALL_NEWEST_FIRST.filter((row) => row.severity === options.severity)
      : ALL_NEWEST_FIRST;
    return pool.slice(0, options?.limit ?? 100);
  });
});

describe("/admin/status under an alert storm", () => {
  it("shows every critical the badge counts, even when the storm fills the window", async () => {
    const html = await renderStatusPage();

    for (const critical of CRITICALS) {
      expect(html).toContain(critical.type);
    }
  });

  it("states the same critical count the nav badge shows", async () => {
    const html = await renderStatusPage();
    expect(html).toContain("4 unresolved criticals");
  });

  it("folds the whole storm into one row that says how many there are", async () => {
    const html = await renderStatusPage();

    // Four criticals and ONE line for the storm. Before, 150 warning rows would
    // have been the entire list.
    expect(rowCount(html)).toBe(5);
    expect(html).toContain("×100");
  });

  it("puts the criticals above the warnings", async () => {
    const html = await renderStatusPage();

    const firstCritical = html.indexOf("fulfillment_transmit_failed");
    const storm = html.indexOf("shipping_cost_manual_entry_required");
    expect(firstCritical).toBeGreaterThan(-1);
    expect(firstCritical).toBeLessThan(storm);
  });

  it("offers a way to clear each group, which is what makes the list drain", async () => {
    const html = await renderStatusPage();
    expect(html).toContain("Resolve all 100");
  });

  it("says so plainly when nothing is open", async () => {
    mocks.getOpenSystemAlerts.mockResolvedValue([]);
    const html = await renderStatusPage();

    expect(html).toContain("No unresolved system alerts");
    expect(html).toContain("0 unresolved criticals");
  });

  it("still renders the page when the alert read fails", async () => {
    // A monitoring read must never be what takes the admin console down.
    mocks.getOpenSystemAlerts.mockRejectedValue(new Error("system_alerts is not migrated"));
    const html = await renderStatusPage();

    expect(html).toContain("System Status");
  });
});
