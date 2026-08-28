import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// VL-18 / F-A-2 — THE FILING EXPORT MUST SAY WHEN IT IS SHORT.
//
// getSalesTaxReport has computed `truncated` since the row-cap work, and until
// now not one caller read it. This CSV is the artefact the owner actually files
// from: it is downloaded, saved, mailed to an accountant and opened next week,
// by which time every banner on the screen it came from is gone. A silently
// partial one understates a tax liability to a state and is byte-for-byte
// indistinguishable from a complete one.
//
// The condition cannot be reached against a real database without 200,000
// taxed orders, so it is proven at the seam instead — the report module is
// stubbed and the route's own output is read.
// ---------------------------------------------------------------------------

const report = vi.hoisted(() => ({ truncated: false }));

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => ({ username: "owner", role: "super_admin" }),
}));

vi.mock("@/lib/admin-tax-report", () => ({
  getSalesTaxReport: async () => ({
    rows: [{
      orderNumber: "VL-1001",
      createdAt: "2026-03-04T00:00:00.000Z",
      state: "TX",
      ratePercent: 8.25,
      taxableSales: 100,
      taxCollected: 8.25,
      taxRefunded: 0,
      netTax: 8.25,
      paymentStatus: "paid",
      refunded: false,
    }],
    byState: [{ state: "TX", orders: 1, taxableSales: 100, taxCollected: 8.25, taxRefunded: 0, netTax: 8.25 }],
    totals: { orders: 1, taxCollected: 8.25, taxRefunded: 0, netTax: 8.25 },
    truncated: report.truncated,
  }),
}));

const { GET } = await import("@/app/api/admin/tax/export/route");

const request = () => new Request("http://localhost/api/admin/tax/export");

beforeEach(() => {
  report.truncated = false;
});

describe("the sales-tax CSV export", () => {
  it("warns in the file, before any figure, when the read was short", async () => {
    report.truncated = true;
    const response = await GET(request());
    const body = await response.text();

    expect(body).toContain("WARNING: INCOMPLETE REPORT");
    // Before the numbers, not after them.
    expect(body.indexOf("WARNING: INCOMPLETE REPORT")).toBeLessThan(body.indexOf("SALES TAX BY STATE"));
    expect(body).toContain("TOTAL (PARTIAL — INCOMPLETE READ)");
  });

  it("marks the downloaded filename, which outlives every on-screen banner", async () => {
    report.truncated = true;
    const response = await GET(request());
    expect(response.headers.get("Content-Disposition")).toContain("-INCOMPLETE.csv");
  });

  it("says nothing of the sort when the report is whole", async () => {
    const response = await GET(request());
    const body = await response.text();

    expect(body).not.toContain("INCOMPLETE");
    expect(body).toContain("TOTAL,1,,8.25,0.00,8.25");
    expect(response.headers.get("Content-Disposition")).not.toContain("INCOMPLETE");
  });
});
