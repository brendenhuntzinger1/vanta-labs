import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// AN EMPTY WATCH LIST AND A FAILED ONE MUST NOT LOOK THE SAME.
//
// "Nothing needs ordering" is the single most expensive sentence this screen
// can show: read it while the database is down and you skip a purchase order
// you needed to place. Same concern as admin-list-read-failure.test.tsx, for
// the reorder panel — it drives the REAL page with the reader made to fail.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getInventoryRows: vi.fn(),
  getInventoryWatchlist: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirected"); } }));
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromCookie: async () => ({ username: "owner", role: "super_admin" }),
}));
vi.mock("@/lib/admin-roles", () => ({ canManageInventory: () => true }));
vi.mock("@/lib/inventory-settings", () => ({ isInventoryTrackingActive: async () => true }));
vi.mock("@/lib/admin-inventory", () => ({ getInventoryRows: mocks.getInventoryRows }));
vi.mock("@/lib/admin-inventory-watchlist", () => ({ getInventoryWatchlist: mocks.getInventoryWatchlist }));
vi.mock("@/components/admin-inventory-client", () => ({
  AdminInventoryClient: () => <p data-testid="inventory-table">table</p>,
}));

const HEALTHY_WATCHLIST = {
  entries: [],
  settings: { leadTimeDays: 14, coverTargetDays: 30, salesWindowDays: 30 },
  linesConsidered: 48,
  unitsSoldInWindow: 150,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/admin/inventory reorder watch list", () => {
  it("says the watch list did not load, and never that nothing needs ordering", async () => {
    mocks.getInventoryRows.mockResolvedValue([]);
    mocks.getInventoryWatchlist.mockRejectedValue(new Error("connection refused"));

    const { default: Page } = await import("./inventory/page");
    const html = renderToStaticMarkup(await Page());

    expect(html).toContain("Did not load: Reorder watch list");
    expect(html).not.toContain("Nothing needs ordering");
    expect(html).not.toContain("Reorder watch list</h2>");
    // The rest of the screen still works — stock can still be counted.
    expect(html).toContain("Inventory");
  });

  it("shows the all-clear only when the read actually answered", async () => {
    mocks.getInventoryRows.mockResolvedValue([]);
    mocks.getInventoryWatchlist.mockResolvedValue(HEALTHY_WATCHLIST);

    const { default: Page } = await import("./inventory/page");
    const html = renderToStaticMarkup(await Page());

    expect(html).toContain("Nothing needs ordering");
    expect(html).toContain("All 48 lines");
    expect(html).not.toContain("Did not load: Reorder watch list");
  });

  it("keeps the watch list when only the stock table fails to load", async () => {
    mocks.getInventoryRows.mockRejectedValue(new Error("statement timeout"));
    mocks.getInventoryWatchlist.mockResolvedValue(HEALTHY_WATCHLIST);

    const { default: Page } = await import("./inventory/page");
    const html = renderToStaticMarkup(await Page());

    expect(html).toContain("Did not load: Inventory");
    expect(html).toContain("Nothing needs ordering");
  });
});
