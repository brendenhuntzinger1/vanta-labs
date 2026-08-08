import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_MINIMUM_QUALIFYING_ORDER, DEFAULT_COMMISSION_HOLD_DAYS } from "@/lib/referral-config";

// ---------------------------------------------------------------------------
// A DEFAULT THAT LOOKS LIKE A DECISION.
//
// The Program tab showed "100" whether or not 100 had ever been saved, and the
// save fired only when the typed value DIFFERED from what was displayed. So the
// one value an owner could never store was the one already on screen -- the
// fallback. Typing 100 and clicking away did nothing, silently, and the only
// way through was 101 -> save -> 100 -> save.
//
// That matters beyond the annoyance: an unsaved policy is not a policy. Change
// the built-in default in a later release and every store still "showing" 100
// would quietly move.
//
// Two fixes, both asserted here: the settings layer reports whether each value
// is stored or merely defaulted, and the UI saves what is on screen rather than
// diffing against it.
// ---------------------------------------------------------------------------

const settingsLib = readFileSync(join(process.cwd(), "src/lib/ambassador-settings.ts"), "utf8");
const adminUi = readFileSync(join(process.cwd(), "src/components/admin-partners-client.tsx"), "utf8");
const settingsRoute = readFileSync(join(process.cwd(), "src/app/api/admin/ambassadors/settings/route.ts"), "utf8");

describe("the owner can save a value equal to the default", () => {
  // The precise defect. If this string ever comes back, the 101 -> 100 dance
  // comes back with it.
  it("no longer skips the request when the typed value matches the displayed one", () => {
    expect(adminUi).not.toContain("!== settings.minimumQualifyingOrder && updateSetting");
    expect(adminUi).not.toContain("!== settings.minimumPayoutThreshold && updateSetting");
    expect(adminUi).not.toContain("!== settings.commissionHoldDays && updateSetting");
  });

  it("saves whatever is in the field, unconditionally", () => {
    expect(adminUi).toContain("onClick={() => updateSetting(field.key, Number(draft))}");
  });

  // A controlled input backed by its own draft state: what the button sends is
  // what the owner sees, with no comparison against the resolved value.
  it("holds the typed value in its own state rather than diffing against settings", () => {
    expect(adminUi).toContain("const [settingDrafts, setSettingDrafts]");
    expect(adminUi).toContain("setSettingDrafts((prev) => ({ ...prev, [field.key]: event.target.value }))");
  });

  it("still refuses to send an empty field", () => {
    expect(adminUi).toContain('draft.trim() === ""');
  });
});

describe("stored and defaulted are told apart", () => {
  it("the settings layer reports which values are actually stored", () => {
    expect(settingsLib).toContain("stored?: {");
    expect(settingsLib).toContain('isStored("minimum_qualifying_order")');
    expect(settingsLib).toContain('isStored("minimum_payout_threshold")');
    expect(settingsLib).toContain('isStored("commission_hold_days")');
  });

  // A stored 0 is a real decision -- "no minimum" -- and must not be reported
  // as never-saved. Key presence, not truthiness.
  it("treats a stored 0 as stored", () => {
    expect(settingsLib).toContain("const isStored = (key: string) => settings[key] != null;");
  });

  it("labels an unsaved value in the UI instead of showing a bare number", () => {
    expect(adminUi).toContain('{isStored ? "Saved" : "Default"}');
  });

  // Optional on the interface so checkout, the webhook and the portal keep
  // reading the numbers exactly as before. This is an admin-only concern.
  it("keeps the flag optional so no consumer of the numbers is affected", () => {
    expect(settingsLib).toContain("stored?: {");
    expect(settingsLib).not.toContain("stored: {\n    minimumQualifyingOrder: boolean;");
  });
});

describe("the $100 policy", () => {
  it("has a built-in fallback of 100 until it is stored", () => {
    expect(DEFAULT_MINIMUM_QUALIFYING_ORDER).toBe(100);
  });

  it("holds commission for 30 days by default", () => {
    expect(DEFAULT_COMMISSION_HOLD_DAYS).toBe(30);
  });

  // Persisting is manager+ only: these numbers decide how much money leaves the
  // business.
  it("is writable only by an authorized admin", () => {
    expect(settingsRoute).toContain("verifyAdminSessionFromRequest");
    expect(settingsRoute).toContain("canManageRefunds(session.role)");
  });

  it("rejects a negative or non-numeric minimum", () => {
    expect(settingsRoute).toContain("!Number.isFinite(value) || value < 0");
  });

  it("accepts only the three known setting keys", () => {
    expect(settingsRoute).toContain('"Invalid setting key"');
  });

  // The response carries fresh settings, so the chip flips Default -> Saved
  // without a reload. Otherwise the owner saves and sees no confirmation that
  // it took.
  it("returns the re-read settings so the UI reflects the new state", () => {
    expect(settingsRoute).toContain("const settings = await getAmbassadorProgramSettings();");
    expect(adminUi).toContain("setSettings(json.settings);");
  });
});
