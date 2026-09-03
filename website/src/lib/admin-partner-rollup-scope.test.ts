import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE ROSTER IS FETCHED WHOLE. THE TABLE IS NARROWED ON THE CLIENT.
//
// admin-partners-client keeps two datasets and they are not interchangeable:
//
//   rows          -- the whole ambassador roster. EVERY program-wide figure is
//                    derived from it: totalAmbassadors, approvedCount,
//                    pendingCount (and the amber badge on the Applications
//                    tab), activeCount, liveSales, paidCommissions,
//                    pendingCommissions, approvedForPayoutCommissions,
//                    balanceOwed, totalOrders, totalClicks, programAov,
//                    programConversionRate, topPerformers, lowestPerformers.
//   filteredRows  -- rows narrowed by the status dropdown, the payout bucket
//                    and the search box. Only the table renders from it.
//
// The regression this file exists to prevent: refreshRows() forwarding the
// active filters to /api/admin/partners. That narrows `rows` itself, so the
// "program-wide" figures silently become "figures for whatever is on screen".
//
// It is not hypothetical. Selecting "Approved" in the status dropdown made
// pendingCount 0 and hid the Applications badge, so the page reported that
// every ambassador was approved while an application sat unreviewed --
// ROBINL applied 2026-09-03 and was invisible on exactly this path. Filtering
// to a payout bucket did the same thing to Commission Owed and Ambassador
// Sales, which are the numbers payouts get decided on.
//
// The server filter was never needed: filteredRows already applies all three
// filters over the same fields the API matches on. The first paint proves the
// intent -- the server render asks for { status: "all" } and its rollups are
// correct; only the client refetch narrowed them.
// ---------------------------------------------------------------------------

const source = readFileSync(join(process.cwd(), "src/components/admin-partners-client.tsx"), "utf8");

const refreshRows = source.slice(
  source.indexOf("const refreshRows = async () =>"),
  source.indexOf("const refreshFraudAndPayouts = async () =>"),
);

describe("refreshRows fetches the whole roster", () => {
  it("finds the function it is asserting against", () => {
    expect(refreshRows).not.toBe("");
    expect(refreshRows).toContain("/api/admin/partners");
  });

  // The three that poisoned the rollups.
  it("does not forward the status filter to the API", () => {
    expect(refreshRows).not.toMatch(/params\.set\(\s*["']status["']/);
  });

  it("does not forward the payout-bucket filter to the API", () => {
    expect(refreshRows).not.toMatch(/params\.set\(\s*["']payoutStatus["']/);
  });

  it("does not forward the search box to the API", () => {
    expect(refreshRows).not.toMatch(/params\.set\(\s*["']search["']/);
  });

  // Matches the server render in src/app/admin/partners/page.tsx, which calls
  // getAdminPartnerRows({ status: "all" }). A refetch that asked for anything
  // narrower would make the rollups depend on whether the page had been
  // refreshed yet, which is the worst of both behaviours.
  it("asks for every status, exactly as the first paint does", () => {
    expect(refreshRows).toMatch(/status=all/);
  });
});

describe("the two datasets stay in their lanes", () => {
  // If these ever read filteredRows, the filter poisoning comes back through
  // the front door instead of through the fetch.
  const programWide = [
    "totalAmbassadors",
    "approvedCount",
    "pendingCount",
    "disabledCount",
    "activeCount",
    "liveSales",
    "paidCommissions",
    "pendingCommissions",
    "approvedForPayoutCommissions",
    "reversedCommissions",
    "totalOrders",
    "totalClicks",
  ];

  for (const name of programWide) {
    it(`derives ${name} from the unfiltered roster`, () => {
      const declaration = source.match(new RegExp(`const ${name} = [^;]+;`, "s"));
      expect(declaration, `no declaration found for ${name}`).not.toBeNull();
      expect(declaration![0]).toContain("rows");
      expect(declaration![0]).not.toContain("filteredRows");
    });
  }

  it("renders the roster table from the filtered view", () => {
    expect(source).toContain("filteredRows.map");
  });

  it("still applies all three filters on the client", () => {
    const filtered = source.slice(
      source.indexOf("const filteredRows = useMemo"),
      source.indexOf("const refreshRows = async () =>"),
    );
    expect(filtered).toContain("statusMatch");
    expect(filtered).toContain("payoutMatch");
    expect(filtered).toContain("searchMatch");
  });
});
