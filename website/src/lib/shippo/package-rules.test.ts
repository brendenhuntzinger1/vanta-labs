import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKAGE_RULES,
  ruleMatches,
  selectPresetForUnits,
  sortRules,
  validatePackageRules,
  type PackageRule,
} from "@/lib/shippo/package-rules";
import type { PackagePresetRecord } from "@/lib/shippo/packages";

function preset(name: string, overrides: Partial<PackagePresetRecord> = {}): PackagePresetRecord {
  return {
    id: `preset-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    lengthIn: 9,
    widthIn: 6,
    heightIn: 3,
    emptyWeightOz: 1.5,
    isDefault: false,
    isActive: true,
    ...overrides,
  } as PackagePresetRecord;
}

const PRESETS = [preset("Small Bubble Mailer"), preset("Medium Bubble Mailer"), preset("Shipping Box")];

// A representative rule set, written out here rather than borrowed from
// DEFAULT_PACKAGE_RULES. The defaults are empty on purpose (see the module),
// and a test that reaches for them to get sample data goes green for the wrong
// reason the moment that changes.
const SAMPLE_RULES: PackageRule[] = [
  { minUnits: 1, maxUnits: 4, presetName: "Small Bubble Mailer" },
  { minUnits: 5, maxUnits: 10, presetName: "Medium Bubble Mailer" },
  { minUnits: 11, maxUnits: null, presetName: "Shipping Box" },
];

describe("ruleMatches", () => {
  it("includes both bounds", () => {
    const rule: PackageRule = { minUnits: 5, maxUnits: 10, presetName: "Medium Bubble Mailer" };
    expect(ruleMatches(rule, 5)).toBe(true);
    expect(ruleMatches(rule, 10)).toBe(true);
    expect(ruleMatches(rule, 4)).toBe(false);
    expect(ruleMatches(rule, 11)).toBe(false);
  });

  it("treats a null upper bound as open-ended", () => {
    const rule: PackageRule = { minUnits: 11, maxUnits: null, presetName: "Shipping Box" };
    expect(ruleMatches(rule, 11)).toBe(true);
    expect(ruleMatches(rule, 9999)).toBe(true);
  });
});

describe("selectPresetForUnits", () => {
  it.each([
    [1, "Small Bubble Mailer"],
    [4, "Small Bubble Mailer"],
    [5, "Medium Bubble Mailer"],
    [10, "Medium Bubble Mailer"],
    [11, "Shipping Box"],
    [50, "Shipping Box"],
  ])("puts %i units in the %s", (units, expected) => {
    expect(selectPresetForUnits(units, SAMPLE_RULES, PRESETS)?.name).toBe(expected);
  });

  it("returns null rather than guessing when nothing matches", () => {
    const rules: PackageRule[] = [{ minUnits: 5, maxUnits: 10, presetName: "Medium Bubble Mailer" }];
    // A wrong box misprices the postage. Null lets the caller fall back to the
    // account default and lets the admin show what was actually chosen.
    expect(selectPresetForUnits(2, rules, PRESETS)).toBeNull();
  });

  it("ignores a zero or nonsense unit count", () => {
    expect(selectPresetForUnits(0, SAMPLE_RULES, PRESETS)).toBeNull();
    expect(selectPresetForUnits(Number.NaN, SAMPLE_RULES, PRESETS)).toBeNull();
  });

  // A retired mailer must not be selected, or labels get bought against a box
  // no longer in the cupboard.
  it("skips a retired preset and falls through to a wider rule", () => {
    const presets = [preset("Small Bubble Mailer", { isActive: false }), preset("Shipping Box")];
    const rules: PackageRule[] = [
      { minUnits: 1, maxUnits: 4, presetName: "Small Bubble Mailer" },
      { minUnits: 1, maxUnits: null, presetName: "Shipping Box" },
    ];
    expect(selectPresetForUnits(2, rules, presets)?.name).toBe("Shipping Box");
  });

  it("returns null when the rule names a preset that no longer exists", () => {
    const rules: PackageRule[] = [{ minUnits: 1, maxUnits: null, presetName: "Deleted Mailer" }];
    expect(selectPresetForUnits(3, rules, PRESETS)).toBeNull();
  });

  it("matches preset names case- and whitespace-insensitively", () => {
    const rules: PackageRule[] = [{ minUnits: 1, maxUnits: null, presetName: "  small bubble MAILER " }];
    expect(selectPresetForUnits(1, rules, PRESETS)?.name).toBe("Small Bubble Mailer");
  });

  it("applies the narrowest matching rule regardless of input order", () => {
    const shuffled = [...SAMPLE_RULES].reverse();
    expect(selectPresetForUnits(3, shuffled, PRESETS)?.name).toBe("Small Bubble Mailer");
  });
});

describe("sortRules", () => {
  it("orders ascending without mutating the input", () => {
    const input = [...SAMPLE_RULES].reverse();
    const snapshot = JSON.stringify(input);
    expect(sortRules(input).map((r) => r.minUnits)).toEqual([1, 5, 11]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// Gaps and overlaps both produce a WRONG BOX rather than an error, which is why
// they are worth surfacing in the admin: a gap silently uses the account
// default, and an overlap makes the result depend on sort order, not intent.
describe("validatePackageRules", () => {
  it("accepts a complete, well-formed rule set", () => {
    expect(validatePackageRules(SAMPLE_RULES)).toEqual([]);
  });

  it("reports a gap between two rules", () => {
    const rules: PackageRule[] = [
      { minUnits: 1, maxUnits: 4, presetName: "Small Bubble Mailer" },
      { minUnits: 8, maxUnits: null, presetName: "Shipping Box" },
    ];
    expect(validatePackageRules(rules).join(" ")).toContain("5–7");
  });

  it("reports an overlap", () => {
    const rules: PackageRule[] = [
      { minUnits: 1, maxUnits: 6, presetName: "Small Bubble Mailer" },
      { minUnits: 5, maxUnits: null, presetName: "Medium Bubble Mailer" },
    ];
    expect(validatePackageRules(rules).join(" ")).toContain("both cover");
  });

  it("reports an unbounded top when the largest order matches nothing", () => {
    const rules: PackageRule[] = [{ minUnits: 1, maxUnits: 10, presetName: "Small Bubble Mailer" }];
    expect(validatePackageRules(rules).join(" ")).toContain("above 10");
  });

  it("reports a first rule that does not start at one", () => {
    const rules: PackageRule[] = [{ minUnits: 3, maxUnits: null, presetName: "Shipping Box" }];
    expect(validatePackageRules(rules).join(" ")).toContain("2 unit");
  });

  it("flags a rule stranded behind an open-ended one", () => {
    const rules: PackageRule[] = [
      { minUnits: 1, maxUnits: null, presetName: "Small Bubble Mailer" },
      { minUnits: 5, maxUnits: null, presetName: "Shipping Box" },
    ];
    expect(validatePackageRules(rules).join(" ")).toContain("can ever match");
  });

  it("says so when there are no rules at all", () => {
    expect(validatePackageRules([]).join(" ")).toContain("at least one rule");
  });
});

// ---------------------------------------------------------------------------
// The bug these two guard against: rules that name a box nobody owns. They
// match nothing, every order silently falls through to the account default,
// and the admin shows a tidy list of rules that are doing nothing at all.
// ---------------------------------------------------------------------------
describe("rules naming a package that does not exist", () => {
  it("ships no default rules, rather than rules that cannot fire", () => {
    expect(DEFAULT_PACKAGE_RULES).toEqual([]);
  });

  it("is reported when the preset list is supplied", () => {
    const rules: PackageRule[] = [{ minUnits: 1, maxUnits: null, presetName: "Purple Mailer" }];
    const problems = validatePackageRules(rules, PRESETS);

    expect(problems.some((p) => p.includes("Purple Mailer"))).toBe(true);
  });

  it("stays quiet for a rule whose package really exists", () => {
    const rules: PackageRule[] = [{ minUnits: 1, maxUnits: null, presetName: "Shipping Box" }];

    expect(validatePackageRules(rules, PRESETS)).toEqual([]);
  });

  // Case and padding are display detail, not identity -- an owner who renamed a
  // box "shipping box" has not broken their rules.
  it("matches the package name case-insensitively", () => {
    const rules: PackageRule[] = [{ minUnits: 1, maxUnits: null, presetName: "  shipping BOX " }];

    expect(validatePackageRules(rules, PRESETS)).toEqual([]);
  });

  it("counts a retired package as missing", () => {
    const retired = [preset("Shipping Box", { isActive: false })];
    const rules: PackageRule[] = [{ minUnits: 1, maxUnits: null, presetName: "Shipping Box" }];

    expect(validatePackageRules(rules, retired).length).toBeGreaterThan(0);
  });
});
