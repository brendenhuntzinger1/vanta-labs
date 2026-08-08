import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// SIX VIEWS, NOT ONE SCROLL.
//
// Every section on this page already existed and already worked. The problem
// was that all of them rendered at once, so reaching the payout history meant
// scrolling past the commission tier editor, the fraud queue, and the marketing
// resource list.
//
// The failure this file is written against is a section that ends up outside
// every tab group -- it would render on all six tabs, and the page would look
// like the tabs simply do nothing. That is invisible to the type checker,
// because the JSX is perfectly valid either way.
// ---------------------------------------------------------------------------

const source = readFileSync(join(process.cwd(), "src/components/admin-partners-client.tsx"), "utf8");

// Everything after the tab bar must live inside a group.
const body = source.slice(source.indexOf('{tab === "overview" ? (<>'));

function groupFor(tab: string): string {
  const start = body.indexOf(`{tab === "${tab}"`);
  if (start === -1) throw new Error(`no group renders the ${tab} tab`);
  const end = body.indexOf("</>) : null}", start);
  return body.slice(start, end);
}

describe("every section belongs to exactly one tab", () => {
  const open = (body.match(/\{tab === /g) ?? []).length;
  const close = (body.match(/<\/>\) : null\}/g) ?? []).length;

  it("opens and closes the same number of groups", () => {
    expect(open).toBe(close);
    expect(open).toBe(5); // ambassadors and applications share one group
  });

  // The regression that would make the tabs cosmetic.
  it("leaves no section stranded between groups", () => {
    const gaps: string[] = [];
    let cursor = 0;
    for (;;) {
      const groupStart = body.indexOf("{tab === ", cursor);
      const between = body.slice(cursor, groupStart === -1 ? body.length : groupStart);
      if (between.includes("<section")) gaps.push(between.slice(0, 120));
      if (groupStart === -1) break;
      const groupEnd = body.indexOf("</>) : null}", groupStart);
      cursor = groupEnd + "</>) : null}".length;
    }
    expect(gaps).toEqual([]);
  });
});

describe("each tab shows what its name promises", () => {
  // The six headline figures, named as the owner asked for them. Labels are
  // part of the contract here -- "Commission Owed" answers a question that
  // "Balance Owed" only hinted at.
  it("puts the program-wide numbers on Overview", () => {
    const overview = groupFor("overview");
    for (const kpi of [
      "Active Ambassadors",
      "Pending Applications",
      "Ambassador Sales",
      "Ambassador Orders",
      "Commission Owed",
      "Commission Paid",
    ]) {
      expect(overview).toContain(kpi);
    }
    // ...and none of the editors, which is the whole point of the split.
    expect(overview).not.toContain("Commission Tiers");
  });

  it("puts the roster and the invite form on Ambassadors", () => {
    const people = groupFor("ambassadors");
    expect(people).toContain("Invite Partner");
    expect(people).toContain("Rates");
  });

  it("puts the payout history on Payouts", () => {
    expect(groupFor("payouts")).toContain("Payout History");
  });

  it("puts every editable program control on Program", () => {
    const program = groupFor("program");
    expect(program).toContain("Commission Tiers");
    expect(program).toContain("Ambassador Program Settings");
    expect(program).toContain("Marketing Resources");
  });

  it("puts the performance and fraud reads on Analytics", () => {
    const analytics = groupFor("analytics");
    expect(analytics).toContain("Top Performers");
    expect(analytics).toContain("Needs Attention");
    expect(analytics).toContain("Fraud &amp; Review");
  });
});

describe("Applications is the roster, narrowed", () => {
  // It renders the same table rather than a second copy -- one table means one
  // place for the approve/disable actions to drift out of sync.
  it("shares the roster group instead of duplicating it", () => {
    expect(body).toContain('{tab === "ambassadors" || tab === "applications" ? (<>');
  });

  // Moving the real filter, rather than hiding rows behind the tab, keeps the
  // status dropdown describing what is actually on screen.
  it("moves the status filter rather than filtering invisibly", () => {
    expect(source).toContain('if (entry.key === "applications") setStatus("pending");');
    expect(source).toContain('if (entry.key === "ambassadors") setStatus("all");');
  });

  it("surfaces the waiting count on the tab itself", () => {
    expect(source).toContain('entry.key === "applications" && pendingCount > 0');
  });
});
