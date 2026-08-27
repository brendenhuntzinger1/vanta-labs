import { describe, expect, it } from "vitest";

import {
  buildControlUpdates,
  findDestructiveClears,
  isBlankControlValue,
  type ControlUpdate,
} from "@/lib/admin-control-updates";

// ---------------------------------------------------------------------------
// REGRESSION GUARD FOR THE SETTINGS-BLANKING INCIDENT (F-02).
//
// WHAT HAPPENED IN PRODUCTION
//
// The Control Center renders ~30 fields across 10 sections from one snapshot
// fetch, and its single Save button PATCHed ALL of them unconditionally. Every
// text field initialises to "" and the nexus-state list initialises to [], so
// a save that ran before the snapshot landed -- or after a failed load, which
// only set a message and left the button live -- wrote "" over every key the
// form owns.
//
// The audit-log history shows it firing four times. The one that cost money:
//
//   2026-08-02 17:09  tax.nexus_states = "AL,IN,MA,...,WA"   (48 states)
//   2026-08-15 14:01  tax.nexus_states = ""                  <-- blanked
//   2026-08-23 22:01  tax.nexus_states = ""                  (re-saved empty)
//
// resolveSalesTax() reads an empty nexus list as "no nexus anywhere" and
// returns zero tax for every order. Florida orders charged 7.000% before
// 15 August and $0.00 after.
//
// THE TWO INVARIANTS THAT MAKE IT UNREPEATABLE
//
//   1. An unloaded form cannot write. No snapshot, no updates -- ever.
//   2. A save only carries keys the operator actually changed, and clearing a
//      value that currently holds something is an explicit act, not a default.
//
// These are enforced client-side (buildControlUpdates) and again server-side
// (findDestructiveClears), so a stale tab or a future caller cannot repeat it.
// ---------------------------------------------------------------------------

const desired = (over: Partial<Record<string, unknown>> = {}): ControlUpdate[] => [
  { section: "tax", key: "nexus_states", value: over["tax.nexus_states"] ?? "FL" },
  { section: "tax", key: "rate_overrides", value: over["tax.rate_overrides"] ?? "" },
  // Defaults to the stored value so each test isolates the ONE field it moves.
  { section: "profit", key: "count_sales_tax_as_profit", value: over["profit.count_sales_tax_as_profit"] ?? true },
  { section: "shipping", key: "flat_rate", value: over["shipping.flat_rate"] ?? "15" },
];

const baseline = {
  "tax.nexus_states": "FL",
  "tax.rate_overrides": "",
  "profit.count_sales_tax_as_profit": "true",
  "shipping.flat_rate": "15",
};

describe("isBlankControlValue", () => {
  it("treats empty, whitespace, null and undefined as blank", () => {
    for (const value of ["", "   ", null, undefined]) {
      expect(isBlankControlValue(value)).toBe(true);
    }
  });

  it("does not treat false, zero or a real string as blank", () => {
    for (const value of [false, 0, "0", "FL"]) {
      expect(isBlankControlValue(value)).toBe(false);
    }
  });
});

describe("buildControlUpdates — invariant 1: an unloaded form cannot write", () => {
  it("produces no updates at all when the snapshot has not loaded", () => {
    // This is the exact production incident: pristine form state (every string
    // "", the nexus list empty) against a baseline that holds real values.
    const pristine: ControlUpdate[] = [
      { section: "tax", key: "nexus_states", value: "" },
      { section: "tax", key: "rate_overrides", value: "" },
      { section: "profit", key: "count_sales_tax_as_profit", value: true },
      { section: "shipping", key: "flat_rate", value: "" },
    ];

    const updates = buildControlUpdates({ loaded: false, desired: pristine, baseline });

    expect(updates).toEqual([]);
  });

  it("still writes nothing when unloaded even if the values look deliberate", () => {
    expect(buildControlUpdates({ loaded: false, desired: desired(), baseline })).toEqual([]);
  });
});

describe("buildControlUpdates — invariant 2: only what changed", () => {
  it("sends nothing when the form matches the stored snapshot", () => {
    expect(buildControlUpdates({ loaded: true, desired: desired(), baseline })).toEqual([]);
  });

  it("sends only the key the operator actually changed", () => {
    const updates = buildControlUpdates({
      loaded: true,
      desired: desired({ "profit.count_sales_tax_as_profit": false }),
      baseline,
    });

    expect(updates).toEqual([
      { section: "profit", key: "count_sales_tax_as_profit", value: false },
    ]);
  });

  it("compares booleans against their stored string form rather than re-writing them", () => {
    // Stored values come back as strings; the form holds real booleans. Without
    // normalisation every save rewrote all four boolean keys as "changed",
    // which is how one save produced 30 audit rows.
    const updates = buildControlUpdates({
      loaded: true,
      desired: [{ section: "profit", key: "count_sales_tax_as_profit", value: true }],
      baseline: { "profit.count_sales_tax_as_profit": "true" },
    });

    expect(updates).toEqual([]);
  });

  it("marks a genuine clear as an explicit, acknowledged clear", () => {
    const updates = buildControlUpdates({
      loaded: true,
      desired: desired({ "tax.nexus_states": "" }),
      baseline,
    });

    expect(updates).toEqual([
      { section: "tax", key: "nexus_states", value: "", allowClear: true },
    ]);
  });

  it("does not mark a field that was already blank as a clear", () => {
    const updates = buildControlUpdates({
      loaded: true,
      desired: desired({ "tax.rate_overrides": "  " }),
      baseline,
    });

    expect(updates).toEqual([]);
  });
});

describe("findDestructiveClears — the server-side backstop", () => {
  const stored = {
    tax: { nexus_states: "FL", rate_overrides: "" },
    shipping: { flat_rate: "15" },
  };

  it("names a blanking write that did not declare itself a clear", () => {
    const blanking: ControlUpdate[] = [
      { section: "tax", key: "nexus_states", value: "" },
      { section: "shipping", key: "flat_rate", value: "" },
    ];

    expect(findDestructiveClears(blanking, stored)).toEqual(["tax.nexus_states", "shipping.flat_rate"]);
  });

  it("allows a clear the caller explicitly acknowledged", () => {
    const acknowledged: ControlUpdate[] = [
      { section: "tax", key: "nexus_states", value: "", allowClear: true },
    ];

    expect(findDestructiveClears(acknowledged, stored)).toEqual([]);
  });

  it("allows blanking a key that is already blank or absent", () => {
    const harmless: ControlUpdate[] = [
      { section: "tax", key: "rate_overrides", value: "" },
      { section: "content", key: "faq", value: "" },
    ];

    expect(findDestructiveClears(harmless, stored)).toEqual([]);
  });

  it("never treats false or 0 as a destructive clear", () => {
    const booleans: ControlUpdate[] = [
      { section: "shipping", key: "flat_rate", value: 0 },
      { section: "tax", key: "nexus_states", value: false },
    ];

    expect(findDestructiveClears(booleans, stored)).toEqual([]);
  });

  it("reproduces the 15 August incident and refuses it", () => {
    // The whole-form blanking save, replayed against the snapshot that was
    // live at the time. Every populated key is named; nothing is written.
    const liveAtTheTime = {
      tax: { nexus_states: "AL,IN,MA,NV,OH,SD,WV,FL,ID", rate_overrides: "" },
      shipping: { flat_rate: "15", free_shipping_threshold: "200" },
      referral: { default_commission_percent: "10", personal_discount_percent: "20" },
    };
    const wholeFormBlank: ControlUpdate[] = [
      { section: "tax", key: "nexus_states", value: "" },
      { section: "tax", key: "rate_overrides", value: "" },
      { section: "shipping", key: "flat_rate", value: "" },
      { section: "shipping", key: "free_shipping_threshold", value: "" },
      { section: "referral", key: "default_commission_percent", value: "" },
      { section: "referral", key: "personal_discount_percent", value: "" },
    ];

    expect(findDestructiveClears(wholeFormBlank, liveAtTheTime)).toEqual([
      "tax.nexus_states",
      "shipping.flat_rate",
      "shipping.free_shipping_threshold",
      "referral.default_commission_percent",
      "referral.personal_discount_percent",
    ]);
  });
});
