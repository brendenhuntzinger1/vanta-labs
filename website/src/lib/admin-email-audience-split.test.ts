import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// TWO AUDIENCES SHARE ONE TABLE, SO EVERY READ MUST SAY WHICH ONE IT WANTS.
//
// Affiliate broadcasts are rows in `email_campaigns` alongside customer
// campaigns — deliberately, so they inherit the queue, the suppression check
// and the unsubscribe path rather than growing a second copy of each.
//
// The cost of that decision is exactly this: a read that forgets to filter gets
// BOTH. It was found in the browser, not by a unit test — the customer Email
// Marketing page listed two affiliate campaigns in its history and folded their
// sends and clicks into the totals an owner reads as "how is customer marketing
// doing". Nothing errored; the numbers were simply wrong.
//
// Asserted on the source because the property is about the QUERY, and a
// fixture-backed test would only prove the filter works when it is present.
// ---------------------------------------------------------------------------

const adminEmail = readFileSync(join(process.cwd(), "src/lib/admin-email.ts"), "utf8");
const affiliateEmail = readFileSync(join(process.cwd(), "src/lib/admin-affiliate-email.ts"), "utf8");

describe("the customer dashboard reads customer campaigns only", () => {
  it("filters email_campaigns by audience kind", () => {
    expect(adminEmail).toContain('.eq("audience_kind", "customer")');
  });
});

describe("the affiliate dashboard reads affiliate campaigns only", () => {
  it("filters email_campaigns by audience kind", () => {
    expect(affiliateEmail).toContain('.eq("audience_kind", "affiliate")');
  });

  it("refuses to open a campaign that is not an affiliate one", () => {
    expect(affiliateEmail).toContain('audience_kind ?? "") !== "affiliate"');
  });
});
