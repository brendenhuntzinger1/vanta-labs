/**
 * Systematic testing, rather than making adverts and hoping.
 *
 * The rule this file enforces is that an experiment varies exactly one thing.
 * Change the hook and the CTA at once and you get a number you cannot explain,
 * which costs the same as the disciplined test and teaches nothing. That is
 * easy to agree with and very easy to violate at 11pm, so it is a function that
 * refuses rather than a paragraph in a document.
 *
 * The second job here is the `utm_content` value. It is the only identifier
 * that survives the whole journey — ad click, landing page, session,
 * add-to-cart, checkout, paid order — so if it is not unique per creative and
 * stable forever, per-creative attribution silently degrades into per-campaign
 * attribution and nobody notices until the numbers stop making sense.
 */

import type { Experiment, VantaCreative, VariantAxis } from "./types";

/** The fields a variant axis is allowed to change. */
const AXIS_FIELDS: Record<Exclude<VariantAxis, "none">, (keyof VantaCreative)[]> = {
  hook: ["hook"],
  opening_frame: ["openingFrame"],
  format: ["archetype", "storyboard", "script"],
  length: ["lengthSeconds", "storyboard", "script"],
  cta: ["cta"],
  landing_page: ["landingPath"],
  sound: [],
};

/** Fields that must be identical across arms whatever the axis. */
const INVARIANT_FIELDS: (keyof VantaCreative)[] = ["conceptId", "landingPath", "cta", "hook", "openingFrame", "lengthSeconds"];

export type ArmValidation = {
  valid: boolean;
  problems: string[];
};

/**
 * Confirm a set of creatives differ only along the declared axis.
 *
 * Compares against the first arm as the reference rather than pairwise, because
 * the failure mode in practice is one arm drifting, and naming that arm is more
 * useful than reporting a combinatorial list of differences.
 */
export function validateExperimentArms(axis: VariantAxis, arms: VantaCreative[]): ArmValidation {
  const problems: string[] = [];
  if (arms.length < 2) return { valid: false, problems: ["an experiment needs at least two arms"] };
  if (axis === "none") return { valid: false, problems: ["an experiment must declare a variant axis"] };

  const allowed = new Set<string>(AXIS_FIELDS[axis].map(String));
  const [reference, ...rest] = arms;

  if (new Set(arms.map((a) => a.conceptId)).size > 1 && axis !== "format") {
    problems.push("arms belong to different concepts — that is a concept test, not a variant test");
  }

  for (const arm of rest) {
    for (const field of INVARIANT_FIELDS) {
      if (allowed.has(String(field))) continue;
      if (JSON.stringify(arm[field]) !== JSON.stringify(reference[field])) {
        problems.push(
          `${arm.creativeId} differs from ${reference.creativeId} on '${String(field)}', which the '${axis}' axis does not cover`,
        );
      }
    }
    if (arm.variantAxis !== axis) {
      problems.push(`${arm.creativeId} declares axis '${arm.variantAxis}' but the experiment is testing '${axis}'`);
    }
  }

  const distinct = new Set(arms.map((a) => JSON.stringify(AXIS_FIELDS[axis].map((f) => a[f]))));
  if (distinct.size < arms.length) {
    problems.push(`two or more arms are identical on the '${axis}' axis — there is nothing to compare`);
  }

  return { valid: problems.length === 0, problems };
}

/**
 * The tracking token stamped on the landing URL.
 *
 * Kept short, lowercase and free of characters that get mangled by URL
 * handling or by a platform's own macro expansion. It is derived from the
 * creative id and never regenerated: a changed utm_content orphans every row of
 * history that used the old one.
 */
export function utmContentFor(creativeId: string): string {
  const clean = creativeId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!clean) throw new Error("creativeId produced an empty utm_content");
  return clean.slice(0, 60);
}

export type LandingUrlParts = {
  baseUrl: string;
  landingPath: string;
  creativeId: string;
  campaignName: string;
  adGroupName?: string;
};

/**
 * Build the destination URL for a published ad.
 *
 * `ttclid` is deliberately absent: TikTok appends it at click time, and a
 * placeholder here would be captured as a literal string and then treated as a
 * real click id by the attribution layer. Better to have no value than a wrong
 * one — the attribution code already knows how to store null.
 */
export function buildLandingUrl(parts: LandingUrlParts): string {
  const url = new URL(parts.landingPath, parts.baseUrl);
  url.searchParams.set("utm_source", "tiktok");
  url.searchParams.set("utm_medium", "paid_social");
  url.searchParams.set("utm_campaign", parts.campaignName);
  url.searchParams.set("utm_content", utmContentFor(parts.creativeId));
  if (parts.adGroupName) url.searchParams.set("utm_term", parts.adGroupName);
  return url.toString();
}

export function createExperiment(input: {
  experimentId: string;
  name: string;
  hypothesis: string;
  axis: VariantAxis;
  arms: VantaCreative[];
  controlCreativeId?: string;
  plannedLooks?: number;
}): Experiment {
  const validation = validateExperimentArms(input.axis, input.arms);
  if (!validation.valid) {
    throw new Error(`cannot create experiment: ${validation.problems.join("; ")}`);
  }
  return {
    experimentId: input.experimentId,
    name: input.name,
    hypothesis: input.hypothesis,
    axis: input.axis,
    armCreativeIds: input.arms.map((a) => a.creativeId),
    controlCreativeId: input.controlCreativeId,
    status: "draft",
    // Declared up front so the decision engine can correct alpha for peeking.
    // Deciding how often you will look AFTER seeing the data is how a 5% error
    // rate quietly becomes 23%.
    plannedLooks: input.plannedLooks ?? 3,
    looksTaken: 0,
  };
}

/**
 * Record a read of an experiment's data. Returns the multiplicity settings the
 * decision engine should use for this look.
 */
export function takeLook(experiment: Experiment, metricsBeingTested: number): {
  experiment: Experiment;
  looks: number;
  testsRun: number;
  overPlanned: boolean;
} {
  const next = { ...experiment, looksTaken: experiment.looksTaken + 1 };
  return {
    experiment: next,
    looks: Math.max(next.looksTaken, next.plannedLooks),
    testsRun: Math.max(1, metricsBeingTested * Math.max(1, experiment.armCreativeIds.length - 1)),
    overPlanned: next.looksTaken > next.plannedLooks,
  };
}
