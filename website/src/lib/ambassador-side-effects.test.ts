import { readFileSync } from "node:fs";
import { join } from "node:path";
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
