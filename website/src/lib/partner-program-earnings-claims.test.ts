import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE PUBLIC PARTNER PAGE MAY NOT REPORT COMMISSIONS THAT WERE NEVER PAID.
//
// getPartnerProgramStats() used to floor three money figures with an
// admin-configured baseline from partner_program_stats: the total and the
// average ADDED it, the top payout took a MAX against it. The reason was
// recorded plainly in the code — "to avoid showing a discouraging '$0
// everything' to prospective partners".
//
// Those three numbers are rendered on the PUBLIC /partner page under the labels
// "Total Commissions Paid", "Average Partner Earnings" and "Top Partner Payout"
// to people deciding whether to join. A number an admin typed, under those
// labels, is a representation about what partners actually earn. Earnings
// claims to prospective participants are the category regulators treat most
// harshly (FTC Act §5, the Business Opportunity Rule, and several states'
// own earnings-claim rules), and "it was only a floor" is not a defence
// available after the fact — the reader was told commissions had been paid.
//
// The fix is not a relabel. The money metrics now report tracked reality, and
// the landing omits a money card whose value is zero rather than printing
// "$0.00" — which answers the discouraging-zero problem without inventing a
// figure. Approval time keeps its baseline: it is a service expectation, not an
// earnings claim, and it yields to the real average as soon as one exists.
//
// These are source assertions because getPartnerProgramStats is a paged read
// across five tables; what can regress here is the RULE — whether a baseline is
// allowed to touch money — and the rule is visible in the code.
// ---------------------------------------------------------------------------

const lib = readFileSync(resolve(process.cwd(), "src/lib/partner-portal.ts"), "utf8");
const landing = readFileSync(resolve(process.cwd(), "src/components/partner-program-landing.tsx"), "utf8");

describe("no admin baseline reaches a public earnings figure", () => {
  it("does not read a money baseline at all", () => {
    for (const key of [
      "total_commissions_paid_base",
      "average_partner_earnings_base",
      "top_partner_payout_base",
    ]) {
      expect(lib).not.toContain(key);
    }
  });

  it("returns the tracked totals unmodified", () => {
    expect(lib).toContain("totalCommissionsPaid: roundMoney(totalCommissionsPaid),");
    expect(lib).toContain("averagePartnerEarnings: roundMoney(averagePartnerEarnings),");
    expect(lib).toContain("topPartnerPayout: roundMoney(topPartnerPayout),");
  });

  it("never adds or maxes a baseline into a money metric", () => {
    expect(lib).not.toContain("baselineTotalCommissionsPaid + totalCommissionsPaid");
    expect(lib).not.toContain("baselineAveragePartnerEarnings + averagePartnerEarnings");
    expect(lib).not.toContain("Math.max(baselineTopPartnerPayout, topPartnerPayout)");
  });

  it("keeps the approval-time baseline, which is a service expectation rather than an earnings claim", () => {
    expect(lib).toContain('overrides.get("average_approval_time_hours_base")');
    expect(lib).toContain("hasApprovalData ? averageApprovalTimeHours : baselineAverageApprovalTimeHours");
  });
});

describe("an empty programme says nothing rather than advertising zero", () => {
  it("gates each money card on a value above zero", () => {
    expect(landing).toContain("stats.totalCommissionsPaid > 0 ?");
    expect(landing).toContain("stats.averagePartnerEarnings > 0 ?");
    expect(landing).toContain("stats.topPartnerPayout > 0 ?");
  });

  it("still always shows approval time, the one stat an applicant can use", () => {
    expect(landing).toContain('<StatCard label="Average Approval Time"');
    // Not wrapped in a truthiness gate of its own.
    expect(landing).not.toContain("stats.averageApprovalTimeHours > 0 ?");
  });
});
