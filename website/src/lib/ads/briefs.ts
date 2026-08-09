/**
 * HYPOTHESIZE and CREATE — turning accumulated evidence into the next test.
 *
 * The failure mode this is built against is a system that finds one winner and
 * then spends forever producing near-copies of it. That looks productive, the
 * numbers hold up for a few weeks, and then the account plateaus with no idea
 * what else might have worked — because it never looked.
 *
 * So briefs are generated under an explicit exploit/explore split. Exploitation
 * builds on what the ledger supports. Exploration deliberately tries attribute
 * combinations the ledger has *no* evidence about, which is the only way the
 * evidence base ever grows. Early on, when almost nothing is known, exploration
 * dominates; as beliefs accumulate it recedes but never reaches zero.
 *
 * Two rules keep it honest:
 *
 * **Never re-propose a discouraged attribute without saying so.** The ledger
 * remembers losers precisely so they are not funded twice.
 *
 * **A brief is a hypothesis, not an asset.** Each one names the single variable
 * it changes and what result would disprove it, so the comparison it produces
 * can actually be read afterwards.
 */

import type { Axis, CreativeClassification } from "./taxonomy";
import { AXES } from "./taxonomy";
import type { AttributeBelief, LineageNode } from "./learning";
import { reviewConcept, type ComplianceVerdict } from "./compliance";

export type BriefStrategy = "exploit" | "explore" | "replicate" | "rotate";

export type CreativeBrief = {
  briefId: string;
  strategy: BriefStrategy;
  /** The claim this brief exists to test, stated so it can fail. */
  hypothesis: string;
  /** What result would count as disproof. Without this it is not a test. */
  disconfirming: string;
  /** Attribute targets for the new creative. */
  target: Partial<Record<Axis, string>>;
  /** The creative this varies from, when there is one. */
  parentCreativeId: string | null;
  /** The single axis being changed versus the parent. */
  variantAxis: Axis | null;
  /** Ledger entries that motivated this. Empty for pure exploration. */
  evidenceCited: string[];
  /** Production instructions handed to the generation layer. */
  production: ProductionSpec;
  priority: number;
  createdAt: string;
};

export type ProductionSpec = {
  concept: string;
  hook: string;
  storyboard: { index: number; durationSeconds: number; description: string; cameraMovement?: string }[];
  environment: string;
  productPresentation: string;
  lighting: string;
  textOverlays: string[];
  voiceover: string | null;
  cta: string;
  durationSeconds: number;
  aspectRatio: "9:16";
  variantInstructions: string | null;
};

/**
 * How much to explore.
 *
 * Falls as evidence accumulates, floored at 20%. The floor is the important
 * part: an account that stops exploring cannot discover that the market moved,
 * and short-form creative markets move constantly.
 */
export function exploreRatio(beliefCount: number): number {
  if (beliefCount === 0) return 1;
  const ratio = Math.max(0.2, 1 / Math.sqrt(beliefCount + 1));
  return Math.round(ratio * 100) / 100;
}

const BRAND_LIGHTING =
  "single cool key from behind and above, warm gold fill at low intensity, deep falloff to near-black, " +
  "soft contact shadow, no visible rim on the background";

function defaultStoryboard(hook: string, seconds: number): ProductionSpec["storyboard"] {
  // Three beats: earn the look, deliver the substance, name the action. Short
  // enough that a failed shot costs one clip rather than the whole render.
  const open = Math.min(2, Math.max(1, Math.round(seconds * 0.18)));
  const close = Math.min(3, Math.max(1, Math.round(seconds * 0.22)));
  return [
    { index: 1, durationSeconds: open, description: `Opening frame carrying the hook: ${hook}`, cameraMovement: "slow push in" },
    { index: 2, durationSeconds: Math.max(1, seconds - open - close), description: "The substance — the artefact, the document, or the object in detail", cameraMovement: "locked off, subject rotates" },
    { index: 3, durationSeconds: close, description: "Resolution and call to action on a clean dark field", cameraMovement: "static" },
  ];
}

export type BriefInputs = {
  briefId: string;
  beliefs: AttributeBelief[];
  /** Lineage, so a brief can vary a real parent rather than start from nothing. */
  lineage: LineageNode[];
  /** Attribute combinations already tried. Prevents re-proposing a done test. */
  triedCombinations: string[];
  now: string;
};

function combinationKey(target: Partial<Record<Axis, string>>): string {
  return (Object.keys(AXES) as Axis[]).map((axis) => `${axis}=${target[axis] ?? "*"}`).join("|");
}

/** The best-supported value on an axis, ignoring anything discouraged. */
function bestValue(beliefs: AttributeBelief[], axis: Axis): AttributeBelief | null {
  const candidates = beliefs.filter((b) => b.axis === axis && !b.discouraged && b.score > 0);
  return candidates.sort((a, b) => b.score - a.score || b.totalConversions - a.totalConversions)[0] ?? null;
}

/** Values on an axis the ledger has never seen. The exploration frontier. */
export function untestedValues(beliefs: AttributeBelief[], axis: Axis): string[] {
  const seen = new Set(beliefs.filter((b) => b.axis === axis).map((b) => b.value));
  return (AXES[axis] as readonly string[]).filter((v) => v !== "unknown" && !seen.has(v));
}

/**
 * Build one exploitation brief: keep what the ledger supports, change one thing.
 *
 * Returns null when there is nothing to exploit yet, rather than inventing a
 * confident-sounding brief from no evidence — which would be exploration
 * wearing exploitation's clothes and would corrupt the split.
 */
export function exploitBrief(inputs: BriefInputs, product: { name: string; landingPath: string }): CreativeBrief | null {
  const supported = inputs.beliefs.filter((b) => !b.discouraged && b.score > 0 && b.strength !== "anecdotal");
  if (supported.length === 0) return null;

  const target: Partial<Record<Axis, string>> = {};
  const cited: string[] = [];
  for (const axis of Object.keys(AXES) as Axis[]) {
    const best = bestValue(inputs.beliefs, axis);
    if (!best) continue;
    target[axis] = best.value;
    cited.push(`${best.axis}=${best.value} (${best.supportingComparisons} win(s), ${best.strength})`);
  }

  // Vary the axis with the weakest evidence: repeating a well-supported test
  // buys little, while the thinnest belief is where one more comparison changes
  // the picture most.
  const weakest = supported.sort((a, b) => a.totalConversions - b.totalConversions)[0];
  const alternatives = untestedValues(inputs.beliefs, weakest.axis);
  const swapTo = alternatives[0];
  if (swapTo) target[weakest.axis] = swapTo;

  const hook = `Opening built on ${target.hookType ?? "document_reveal"} for ${product.name}`;
  return {
    briefId: inputs.briefId,
    strategy: "exploit",
    hypothesis:
      swapTo
        ? `Holding the supported attributes constant and changing ${weakest.axis} to "${swapTo}" will not reduce performance, and may improve it.`
        : "Rebuilding on the best-supported attribute combination will reproduce prior performance.",
    disconfirming:
      `If this performs decisively worse than the parent on the same metric with at least 10 conversions, ` +
      `the ledger's support for ${weakest.axis} is weaker than it appears.`,
    target,
    parentCreativeId: inputs.lineage[inputs.lineage.length - 1]?.creativeId ?? null,
    variantAxis: swapTo ? weakest.axis : null,
    evidenceCited: cited,
    production: {
      concept: `Evidence-led rebuild for ${product.name}`,
      hook,
      storyboard: defaultStoryboard(hook, 12),
      environment: "dark matte laboratory field, no set dressing",
      productPresentation: target.productPresentation ?? "label_closeup",
      lighting: BRAND_LIGHTING,
      textOverlays: [],
      voiceover: "Precise, factual, unhurried. Short declarative sentences.",
      cta: target.ctaType === "verify_lookup" ? "Search your lot number" : "See the documentation",
      durationSeconds: 12,
      aspectRatio: "9:16",
      variantInstructions: swapTo ? `Change only ${weakest.axis} to ${swapTo}. Hold everything else identical to the parent.` : null,
    },
    priority: 0.8,
    createdAt: inputs.now,
  };
}

/**
 * Build one exploration brief: deliberately try what has never been tested.
 *
 * Priority rises when the ledger is thin, because that is exactly when the
 * value of a new observation is highest and the cost of not having one is a
 * permanently narrow account.
 */
export function exploreBrief(inputs: BriefInputs, product: { name: string; landingPath: string }): CreativeBrief | null {
  const frontier: { axis: Axis; value: string }[] = [];
  for (const axis of Object.keys(AXES) as Axis[]) {
    for (const value of untestedValues(inputs.beliefs, axis)) frontier.push({ axis, value });
  }
  if (frontier.length === 0) return null;

  const tried = new Set(inputs.triedCombinations);
  const target: Partial<Record<Axis, string>> = {};
  // Two untested attributes at once. This brief is for discovery, not
  // attribution — and it says so, so nobody later reads a causal claim into it.
  for (const pick of frontier.slice(0, 2)) target[pick.axis] = pick.value;
  if (tried.has(combinationKey(target))) return null;

  const chosen = Object.entries(target).map(([axis, value]) => `${axis}=${value}`).join(", ");
  const hook = `Untested territory for ${product.name}: ${chosen}`;

  return {
    briefId: inputs.briefId,
    strategy: "explore",
    hypothesis: `${chosen} has never been tested for this brand. This brief exists to find out, not to win.`,
    disconfirming:
      "There is no disconfirming result — an exploration brief cannot fail, it can only inform. " +
      "Judge it on whether it produced a usable observation, not on whether it beat the incumbent.",
    target,
    parentCreativeId: null,
    variantAxis: null,
    evidenceCited: [],
    production: {
      concept: `Exploration: ${chosen}`,
      hook,
      storyboard: defaultStoryboard(hook, 15),
      environment: "dark matte laboratory field",
      productPresentation: target.productPresentation ?? "hero_static",
      lighting: BRAND_LIGHTING,
      textOverlays: [],
      voiceover: "Precise, factual, unhurried.",
      cta: "See the documentation",
      durationSeconds: 15,
      aspectRatio: "9:16",
      variantInstructions: "Deliberately unlike the current winners. Do not converge on the house pattern.",
    },
    priority: inputs.beliefs.length === 0 ? 1 : 0.5,
    createdAt: inputs.now,
  };
}

export type BriefBatch = {
  briefs: CreativeBrief[];
  exploreRatio: number;
  /** Attributes deliberately avoided, and why. Visible, never silent. */
  avoided: { axis: Axis; value: string; reason: string }[];
  note: string;
};

/**
 * Produce a batch under the exploit/explore split.
 *
 * The split is reported rather than hidden, because "why is it making weird
 * ads" has a real answer — it is buying information — and an operator who does
 * not know that will switch exploration off and never learn anything again.
 */
export function generateBriefBatch(
  inputs: BriefInputs,
  product: { name: string; landingPath: string },
  count: number,
): BriefBatch {
  const ratio = exploreRatio(inputs.beliefs.filter((b) => !b.discouraged && b.score > 0).length);
  const exploreCount = Math.max(1, Math.round(count * ratio));
  const briefs: CreativeBrief[] = [];

  for (let i = 0; i < count; i++) {
    const wantExplore = i < exploreCount;
    const scoped = { ...inputs, briefId: `${inputs.briefId}-${i + 1}` };
    const brief = wantExplore
      ? exploreBrief(scoped, product) ?? exploitBrief(scoped, product)
      : exploitBrief(scoped, product) ?? exploreBrief(scoped, product);
    if (brief) briefs.push(brief);
  }

  return {
    briefs,
    exploreRatio: ratio,
    avoided: inputs.beliefs
      .filter((b) => b.discouraged)
      .map((b) => ({
        axis: b.axis,
        value: b.value,
        reason: `lost ${b.contradictingComparisons} of ${b.supportingComparisons + b.contradictingComparisons} comparisons`,
      })),
    note:
      `${Math.round(ratio * 100)}% of this batch is exploration. That share falls as evidence accumulates ` +
      "and is floored at 20% — an account that stops exploring cannot notice the market moving.",
  };
}

// ---------------------------------------------------------------------------
// Generation queue
// ---------------------------------------------------------------------------

export type GenerationStatus = "queued" | "briefed" | "awaiting_provider" | "generating" | "generated" | "failed" | "cancelled";

export type GenerationJob = {
  jobId: string;
  briefId: string;
  /** Assigned before generation, so the asset is attributable from birth. */
  creativeId: string;
  provider: string;
  status: GenerationStatus;
  /** Never invented. Set only by a real provider response. */
  providerJobId: string | null;
  assetPaths: string[];
  compliance: ComplianceVerdict | null;
  failureReason: string | null;
  queuedAt: string;
  updatedAt: string;
};

/**
 * Queue a brief for generation.
 *
 * The compliance gate runs here, before a provider is ever called, for two
 * reasons: rendering a concept that can never be approved wastes money and
 * time, and an asset that exists is much harder to throw away than a brief.
 */
export function queueGeneration(input: {
  jobId: string;
  brief: CreativeBrief;
  creativeId: string;
  provider: string;
  now: string;
}): GenerationJob {
  const compliance = reviewConcept({
    creativeId: input.creativeId,
    hook: input.brief.production.hook,
    caption: input.brief.production.concept,
    cta: input.brief.production.cta,
    onScreenText: input.brief.production.textOverlays,
    visualDirection: `${input.brief.production.environment}. ${input.brief.production.lighting}`,
    claimsUsed: [],
  });

  return {
    jobId: input.jobId,
    briefId: input.brief.briefId,
    creativeId: input.creativeId,
    provider: input.provider,
    status: compliance.approvable ? "briefed" : "cancelled",
    providerJobId: null,
    assetPaths: [],
    compliance,
    failureReason: compliance.approvable ? null : "blocked by the compliance gate before any provider was called",
    queuedAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Advance a job. Refuses transitions that would claim work nobody did — a job
 * cannot reach `generated` without at least one real asset path.
 */
export function advanceJob(job: GenerationJob, next: GenerationStatus, patch: Partial<GenerationJob>, now: string): GenerationJob {
  if (next === "generated" && (patch.assetPaths ?? job.assetPaths).length === 0) {
    throw new Error(`job ${job.jobId} cannot be marked generated with no asset — that would fabricate a result`);
  }
  if (job.status === "cancelled") {
    throw new Error(`job ${job.jobId} was cancelled by the compliance gate and cannot be advanced`);
  }
  return { ...job, ...patch, status: next, updatedAt: now };
}
