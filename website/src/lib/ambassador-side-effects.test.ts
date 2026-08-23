import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// EDITING A RATE IS NOT A STATUS CHANGE.
//
// updatePartnerStatus is the only write path for an ambassador's row, so
// changing a commission or a customer discount has to send the ambassador's
// CURRENT status along to preserve it. That made every rate edit look like an
// approval:
//
//   owner nudges the discount 10% -> 12%
//     -> status "approved" arrives
//     -> "Your application has been approved!" email sent, again
//     -> another notification_queue row
//
// Three saves, three congratulatory emails to someone approved months ago. The
// fix is to fire on the TRANSITION, not on the value.
// ---------------------------------------------------------------------------

const portal = readFileSync(join(process.cwd(), "src/lib/partner-portal.ts"), "utf8");
const adminPage = readFileSync(join(process.cwd(), "src/app/admin/partners/page.tsx"), "utf8");
const ratesCard = readFileSync(join(process.cwd(), "src/components/admin-ambassador-rates-card.tsx"), "utf8");

describe("a rate edit does not re-send the approval email", () => {
  it("reads the ambassador's existing status so a transition can be detected", () => {
    expect(portal).toContain('.select("id, name, email, referral_code, commission_percent, status")');
  });

  it("compares old status against new", () => {
    expect(portal).toContain('const statusChanged = String(existingPartner.status ?? "") !== input.status;');
  });

  it("gates the status email on the transition, not on the value", () => {
    expect(portal).toContain(
      'if (statusChanged && (input.status === "approved" || input.status === "rejected") && existingPartner.email) {',
    );
  });

  // Same class of defect, same guard: editing a disabled ambassador's rates
  // used to reset disabled_at to today, erasing when the disable happened.
  it("does not rewrite the disable date on a rate edit", () => {
    expect(portal).toContain(
      'if (statusChanged && (input.status === "disabled" || input.status === "rejected")) {',
    );
    expect(portal).not.toContain('if (input.status === "disabled") {\n    updatePayload.disabled_at');
  });

  it("defines the transition check once, before the payload is built", () => {
    const occurrences = portal.match(/const statusChanged =/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(portal.indexOf("const statusChanged =")).toBeLessThan(portal.indexOf("updatePayload.disabled_at"));
  });

  // The rates card has to send the current status -- that is what makes the
  // guard necessary rather than optional.
  it("the rates card still preserves status, which is why the guard is needed", () => {
    expect(ratesCard).toContain('JSON.stringify({ action: "set_status", status, ...body })');
  });

  // A genuine approval must still notify. The guard must not have silenced it.
  it("still emails on a real approval", () => {
    expect(portal).toContain('input.status === "approved" ? "partner_application_approved" : "partner_application_rejected"');
    expect(portal).toContain("sendPartnerStatusEmail(");
  });

  // Renaming a code is a separate notification and is keyed on the code
  // actually changing, so it was never affected.
  it("leaves the referral-code email on its own change check", () => {
    expect(portal).toContain("if (referralCodeChanged && existingPartner.email) {");
  });
});

// ---------------------------------------------------------------------------
// A FAILED READ MUST NOT LOOK LIKE A POLICY OF ZERO.
//
// The admin page fell back to minimumQualifyingOrder: 0 when the settings read
// threw. On its own that was a misleading display. Combined with the new
// explicit Save button it became destructive: the owner sees "0", presses Save
// believing they are confirming their policy, and persists a $0 minimum --
// every referred order qualifies for commission from then on.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// A RATE EDIT MUST NOT WRITE STATUS.
//
// Found in production: saving a discount for an ambassador whose status was
// "info_requested" failed with Postgres 23514. The ambassadors mirror carries a
// stricter check constraint than partners, and "info_requested" is in the app's
// vocabulary but not in that constraint.
//
// The error was the visible half. The dangerous half is that both tables are
// updated CONCURRENTLY: partners had already accepted the new rate when the
// ambassadors write was rejected. Checkout reads ambassadors, so the admin
// could show a discount the storefront would never apply -- money drift with a
// red banner that looks like a mere UI complaint.
// ---------------------------------------------------------------------------
describe("a rate edit writes only the rate", () => {
  it("omits status from the payload unless it changed", () => {
    expect(portal).toContain("const updatePayload: Record<string, unknown> = {\n    updated_at: new Date().toISOString(),\n  };");
    expect(portal).toContain("if (statusChanged) {\n    updatePayload.status = input.status;\n  }");
  });

  // The old payload always carried status, which is what reached the
  // constraint on every save.
  it("no longer hardcodes status into the payload", () => {
    expect(portal).not.toContain("const updatePayload: Record<string, unknown> = {\n    status: input.status,");
  });

  // Approval timestamps are status side effects and follow the same rule.
  it("only touches approval timestamps on a real transition", () => {
    expect(portal).toContain('if (statusChanged && input.status === "approved") {');
  });

  // Both tables still receive the write, so the mirror cannot silently drift
  // when a rate genuinely changes.
  it("still mirrors the rate to both tables", () => {
    expect(portal).toContain('.from("partners")\n    .update(updatePayload)');
    expect(portal).toContain('.from("ambassadors")\n    .update(updatePayload)');
  });

  // Order matters. Concurrent writes let a rejected one land AFTER the other
  // had committed, which is how partners took 20% while ambassadors kept the
  // old rate. ambassadors is what checkout reads, so it must commit first: if
  // it fails, nothing is written anywhere.
  it("writes the money table before the display mirror", () => {
    const ambassadorsWrite = portal.indexOf('.from("ambassadors")\n    .update(updatePayload)');
    const partnersWrite = portal.indexOf('.from("partners")\n    .update(updatePayload)');
    expect(ambassadorsWrite).toBeGreaterThan(-1);
    expect(partnersWrite).toBeGreaterThan(ambassadorsWrite);
  });

  it("no longer fires the two writes concurrently", () => {
    expect(portal).not.toContain("await Promise.all([\n    supabaseAdmin.from(\"partners\").update(updatePayload)");
  });

  // The failure of the authoritative write must stop the mirror from running.
  it("asserts on the ambassadors write before touching partners", () => {
    const assertAmbassadors = portal.indexOf('assertNoSupabaseError("ambassadors.update(authoritative rates)"');
    const partnersWrite = portal.indexOf('.from("partners")\n    .update(updatePayload)');
    expect(assertAmbassadors).toBeGreaterThan(-1);
    expect(assertAmbassadors).toBeLessThan(partnersWrite);
  });
});

// ---------------------------------------------------------------------------
// DISPLAY MUST READ THE TABLE THAT CHARGES THE CUSTOMER.
//
// The deeper cause of the production drift was not the failed write -- it was
// that money and display read different tables. Checkout and the payment
// webhook read `ambassadors`; the admin roster and the ambassador dashboard
// read `partners`. So the two could disagree and nothing in the system noticed.
//
// Every rate shown to a human now comes from `ambassadors`, which means a drift
// can no longer display a rate that is not the one charged.
// ---------------------------------------------------------------------------
describe("rates are displayed from the authoritative table", () => {
  it("reads the rate columns from ambassadors", () => {
    expect(portal).toContain("async function fetchAuthoritativeRates(");
    expect(portal).toContain('.from("ambassadors")\n    .select("id, customer_discount_percent, commission_percent, commission_percent_locked")');
  });

  it("the admin roster prefers the authoritative rate", () => {
    expect(portal).toContain("const authoritativeRates = await fetchAuthoritativeRates(");
    expect(portal).toContain("liveRates?.commissionPercent ?? Number(partner.commission_percent ?? 15)");
  });

  it("the ambassador's own dashboard prefers it too", () => {
    expect(portal).toContain("liveRates ? liveRates.customerDiscountPercent : partner.customer_discount_percent");
  });

  // A NULL override on the authoritative row means "inherit the program
  // default" and must not silently fall through to a stale partners value.
  it("does not fall back to partners when the authoritative row exists", () => {
    expect(portal).toContain("liveRates\n          ? liveRates.customerDiscountPercent");
  });

  // Losing the ambassadors read should degrade to the old behaviour, not blank
  // the admin.
  it("falls back to partners only when the lookup itself failed", () => {
    expect(portal).toContain("if (error) return rates;");
  });
});

describe("a settings read failure falls back to policy, not to zero", () => {
  it("uses the real defaults rather than 0", () => {
    expect(adminPage).toContain("minimumQualifyingOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER");
    expect(adminPage).toContain("minimumPayoutThreshold: DEFAULT_MINIMUM_PAYOUT_THRESHOLD");
    expect(adminPage).toContain("commissionHoldDays: DEFAULT_COMMISSION_HOLD_DAYS");
  });

  it("no longer zeroes the qualifying minimum on error", () => {
    expect(adminPage).not.toContain("minimumQualifyingOrder: 0,");
  });

  it("marks the fallback as unsaved so it is not mistaken for stored policy", () => {
    expect(adminPage).toContain("stored: { minimumQualifyingOrder: false");
  });
});

describe("unknown provenance reads as Default", () => {
  const adminUi = readFileSync(join(process.cwd(), "src/components/admin-partners-client.tsx"), "utf8");

  // Defaulting the chip to "Saved" would reassure the owner about a value that
  // was never persisted -- the precise lie the chip exists to prevent.
  it("never claims a value is saved when it cannot tell", () => {
    expect(adminUi).toContain("const isStored = settings.stored?.[field.prop] ?? false;");
    expect(adminUi).not.toContain("settings.stored?.[field.prop] ?? true");
  });
});

// ---------------------------------------------------------------------------
// THE CUSTOMER DISCOUNT IS EDITABLE PER AMBASSADOR, FROM THE PARTNERS PAGE.
//
// The API accepted customerDiscountPercent from the day it was written, with
// its own validation and its own three-state null handling. The admin page only
// ever RENDERED the value — so the only way to change one ambassador's discount
// was to change the program default, which changes it for everybody.
//
// A capability that exists in the route and not in the UI is not a capability.
// These assertions hold the control in place, and hold the two rates apart.
// ---------------------------------------------------------------------------
describe("per-ambassador customer discount control", () => {
  const client = readFileSync(resolve(process.cwd(), "src/components/admin-partners-client.tsx"), "utf8");

  it("offers a Set Discount action, not only a display of the value", () => {
    expect(client).toContain(">Set Discount<");
  });

  it("sends an explicit null to clear the override, never 0", () => {
    // 0% off and "follow the program default" are different intentions, and the
    // API distinguishes them. Sending 0 for a blank would pin the ambassador to
    // a permanent 0% discount that looks identical to the default in the table.
    expect(client).toContain("customerDiscountPercent: null");
  });

  it("stops short of 100, matching the API guard and the database constraint", () => {
    const handler = client.slice(client.indexOf("Customer discount for"));
    expect(handler).toMatch(/value < 0 \|\| value >= 100/);
  });

  it("keeps the two rates on separate controls so neither can move the other", () => {
    // The commission button no longer reads "Set %" — with two percentages on
    // the row, an unlabelled one is an invitation to set the wrong rate.
    expect(client).toContain(">Set Earns %<");
    const discountHandler = client.slice(client.indexOf("Customer discount for"), client.indexOf(">Set Discount<"));
    expect(discountHandler).not.toContain("commissionPercent");
  });
});
