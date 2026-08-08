import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// AN AMBASSADOR HAS TO BE ABLE TO QUOTE THEIR OWN OFFER.
//
// The number they post to their audience is the customer discount, and until
// now the dashboard showed only their commission. Someone with a 15% override
// would have advertised the program's 10% -- or nothing at all.
//
// The dashboard shows the RESOLVED rate, never the raw column: an ambassador
// who inherits has NULL stored, and printing that as blank or 0% would be a
// lie about a code that is discounting perfectly well.
// ---------------------------------------------------------------------------

const portal = readFileSync(join(process.cwd(), "src/lib/partner-portal.ts"), "utf8");
const dashboard = readFileSync(join(process.cwd(), "src/components/partner-dashboard-client.tsx"), "utf8");

describe("the ambassador dashboard states the discount their code gives", () => {
  it("loads the ambassador's own override", () => {
    expect(portal).toContain("commission_percent, customer_discount_percent, status");
  });

  it("resolves it against the program default rather than showing the raw column", () => {
    expect(portal).toContain("const customerDiscountPercent = resolveAmbassadorCustomerDiscount(");
    expect(portal).toContain("partner.customer_discount_percent");
  });

  // A dashboard that throws because the control table is unreachable is worse
  // than one showing the built-in default.
  it("survives an unreadable program config", () => {
    expect(portal).toContain("referralProgram?.discountPercent ?? DEFAULT_REFERRAL_DISCOUNT_PERCENT");
  });

  it("renders both rates, and keeps them visibly distinct", () => {
    expect(dashboard).toContain("liveSummary.customerDiscountPercent");
    expect(dashboard).toContain("liveSummary.commissionPercent");
    // "customers get X" and "you earn Y" -- an ambassador who confuses the two
    // quotes the wrong number to their audience.
    expect(dashboard).toContain("gives customers");
    expect(dashboard).toContain("you earn");
  });
});
