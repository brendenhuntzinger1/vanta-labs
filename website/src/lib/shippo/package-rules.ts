import "server-only";

import { getControlSnapshot } from "@/lib/admin-control";
import type { PackagePresetRecord } from "@/lib/shippo/packages";

// ---------------------------------------------------------------------------
// Which box an order goes in, chosen by how many units it contains.
//
// Editable in admin rather than hardcoded: the right thresholds depend on the
// physical mailers actually bought, which change. A rule baked into the code is
// a rule that silently stops matching reality the day a different mailer is
// ordered.
//
// The rule picks a DEFAULT. An order-level package choice always wins — the
// packer looking at the actual items is a better judge than a unit count.
// ---------------------------------------------------------------------------

export interface PackageRule {
  /** Inclusive lower bound on total units in the order. */
  minUnits: number;
  /**
   * Inclusive upper bound, or null for "and above". Exactly one rule should be
   * open-ended, otherwise a large order matches nothing.
   */
  maxUnits: number | null;
  /** The preset to use. Matched by name so a rule survives a preset being recreated. */
  presetName: string;
}

/**
 * NO shipped defaults, deliberately.
 *
 * This used to name three plausible mailers -- "Small Bubble Mailer" and
 * friends -- which matched nothing, because a rule is resolved against the
 * preset names the owner actually created and nobody's boxes are called that.
 * The admin listed three rules, none of which could ever fire, and every order
 * quietly used the account default anyway. A rule that cannot match is worse
 * than no rule: it reads as configuration that is working.
 *
 * Empty is the honest state for a store that has not written a rule yet. It
 * behaves identically -- the account default preset is used -- but it says so.
 */
export const DEFAULT_PACKAGE_RULES: PackageRule[] = [];

function parseRule(raw: unknown): PackageRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const minUnits = Number(r.minUnits ?? r.min_units);
  const presetName = typeof r.presetName === "string" ? r.presetName : String(r.preset_name ?? "");
  if (!Number.isFinite(minUnits) || minUnits < 1 || !presetName.trim()) return null;
  const rawMax = r.maxUnits ?? r.max_units;
  const maxUnits = rawMax == null || rawMax === "" ? null : Number(rawMax);
  if (maxUnits !== null && (!Number.isFinite(maxUnits) || maxUnits < minUnits)) return null;
  return { minUnits: Math.trunc(minUnits), maxUnits: maxUnits === null ? null : Math.trunc(maxUnits), presetName: presetName.trim() };
}

export async function getPackageRules(): Promise<PackageRule[]> {
  try {
    const snapshot = await getControlSnapshot("shipping_package_rules");
    const cfg = (snapshot as Record<string, unknown>).shipping_package_rules as Record<string, unknown> | undefined;
    const raw = cfg?.rules;
    if (!Array.isArray(raw)) return DEFAULT_PACKAGE_RULES;
    const parsed = raw.map(parseRule).filter((rule): rule is PackageRule => rule !== null);
    // An empty or wholly invalid rule set falls back rather than matching
    // nothing: no rule means no box, and no box means no shipment.
    return parsed.length > 0 ? sortRules(parsed) : DEFAULT_PACKAGE_RULES;
  } catch {
    return DEFAULT_PACKAGE_RULES;
  }
}

/** Ascending by lower bound, so the first match is always the narrowest. */
export function sortRules(rules: PackageRule[]): PackageRule[] {
  return [...rules].sort((a, b) => a.minUnits - b.minUnits);
}

export function ruleMatches(rule: PackageRule, units: number): boolean {
  if (units < rule.minUnits) return false;
  return rule.maxUnits === null || units <= rule.maxUnits;
}

/**
 * The preset a given unit count should use, or null when no rule matches or the
 * named preset does not exist.
 *
 * Null is a real answer, not a failure to be papered over: falling back to an
 * arbitrary box would ship a 20-vial order in a small mailer and misprice the
 * postage. The caller uses the account default and the admin shows what was
 * chosen, so a mismatch is visible before the label is bought.
 */
export function selectPresetForUnits(
  units: number,
  rules: PackageRule[],
  presets: PackagePresetRecord[],
): PackagePresetRecord | null {
  if (!Number.isFinite(units) || units <= 0) return null;
  const active = presets.filter((preset) => preset.isActive !== false);
  for (const rule of sortRules(rules)) {
    if (!ruleMatches(rule, units)) continue;
    const match = active.find(
      (preset) => preset.name.trim().toLowerCase() === rule.presetName.trim().toLowerCase(),
    );
    if (match) return match;
    // Rule matched but its preset is missing or retired. Keep looking: a wider
    // rule is a better answer than no rule at all.
  }
  return null;
}

/**
 * Validate a rule set for the admin UI.
 *
 * Gaps and overlaps are both reported because both produce wrong boxes rather
 * than errors: a gap silently falls through to the account default, and an
 * overlap makes the chosen box depend on sort order rather than intent.
 */
export function validatePackageRules(
  rules: PackageRule[],
  presets: PackagePresetRecord[] = [],
): string[] {
  const problems: string[] = [];
  const sorted = sortRules(rules);

  if (sorted.length === 0) {
    problems.push("Add at least one rule, or every order falls back to the default package.");
    return problems;
  }

  // The failure that started all this: a rule naming a box that does not exist
  // matches nothing and falls through to the default, with no error anywhere.
  // Checked only when the caller supplies the preset list, so a rule set can
  // still be validated for shape alone.
  if (presets.length > 0) {
    const known = new Set(
      presets.filter((p) => p.isActive !== false).map((p) => p.name.trim().toLowerCase()),
    );
    for (const rule of sorted) {
      if (!known.has(rule.presetName.trim().toLowerCase())) {
        problems.push(
          `No active package is named "${rule.presetName}", so this rule never applies and those orders use the default package.`,
        );
      }
    }
  }
  if (sorted[0].minUnits !== 1) {
    problems.push(`Orders of ${sorted[0].minUnits - 1} unit(s) or fewer match no rule. Start the first rule at 1.`);
  }
  if (!sorted.some((rule) => rule.maxUnits === null)) {
    const highest = sorted[sorted.length - 1].maxUnits ?? 0;
    problems.push(`Orders above ${highest} units match no rule. Leave the last rule's upper bound blank.`);
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous.maxUnits === null) {
      problems.push(`"${previous.presetName}" is open-ended, so no rule after it can ever match.`);
      break;
    }
    if (current.minUnits <= previous.maxUnits) {
      problems.push(`"${previous.presetName}" and "${current.presetName}" both cover ${current.minUnits} units.`);
    } else if (current.minUnits > previous.maxUnits + 1) {
      problems.push(`Nothing covers ${previous.maxUnits + 1}–${current.minUnits - 1} units.`);
    }
  }
  return problems;
}
