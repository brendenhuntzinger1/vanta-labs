/**
 * LEARN — lineage, hypotheses, and an evidence ledger that never forgets.
 *
 * The point of this file is the difference between "creative 002 won" and
 * "changing the hook from A to D was associated with a 40% lift, on one
 * comparison, with 12 conversions". The first is a fact about one asset and
 * teaches nothing transferable. The second is a claim about an *attribute*,
 * carries its own uncertainty, and can be tested again.
 *
 * Three commitments:
 *
 * **Correlation is never promoted to causation.** Every conclusion stores what
 * else changed, how much evidence there was, and an explicit caveat. A/B tests
 * on ad platforms are not clean experiments — delivery is algorithmic, audiences
 * overlap, and the platform optimises mid-flight. So the strongest thing this
 * system ever says is "associated with", and the honest reading of a single
 * comparison is "worth testing again", not "true".
 *
 * **Losers are kept forever.** A retired creative is the most useful record in
 * the system: it is the only evidence that an angle does not work, and deleting
 * it guarantees the same idea gets re-proposed in three weeks with new words.
 *
 * **Evidence accumulates across experiments.** One comparison is an anecdote.
 * The same attribute winning across five independent comparisons is a pattern
 * worth building on, and that count is the thing this ledger exists to hold.
 */

import type { Axis, CreativeClassification } from "./taxonomy";
import { AXES } from "./taxonomy";
import type { ComparisonResult } from "./stats";

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export type LineageNode = {
  creativeId: string;
  parentId: string | null;
  /** Root of the family. Lets a whole concept lineage be pulled in one query. */
  rootId: string;
  generation: number;
  classification: CreativeClassification;
  createdAt: string;
  /** Why this variant exists — the hypothesis it was built to test. */
  bornFromHypothesisId?: string | null;
};

export type AttributeDelta = {
  axis: Axis;
  from: string;
  to: string;
};

/**
 * What actually differs between two creatives.
 *
 * The whole causal claim rests on this being small. One delta means a
 * comparison can point at something; four deltas means the result is real but
 * unattributable, which is worth knowing and worth saying rather than quietly
 * crediting whichever attribute the analyst finds most interesting.
 */
export function diffCreatives(a: CreativeClassification, b: CreativeClassification): AttributeDelta[] {
  const deltas: AttributeDelta[] = [];
  for (const axis of Object.keys(AXES) as Axis[]) {
    const from = String(a[axis]);
    const to = String(b[axis]);
    if (from !== to) deltas.push({ axis, from, to });
  }
  return deltas;
}

/** Walk a lineage back to its root. Used to show "what changed since generation 1". */
export function ancestry(nodes: LineageNode[], creativeId: string): LineageNode[] {
  const byId = new Map(nodes.map((n) => [n.creativeId, n]));
  const chain: LineageNode[] = [];
  let cursor = byId.get(creativeId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.creativeId)) {
    seen.add(cursor.creativeId);
    chain.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain.reverse();
}

/** Everything descended from a creative, breadth-first. */
export function descendants(nodes: LineageNode[], creativeId: string): LineageNode[] {
  const children = new Map<string, LineageNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  const out: LineageNode[] = [];
  const queue = [...(children.get(creativeId) ?? [])];
  while (queue.length > 0) {
    const node = queue.shift()!;
    out.push(node);
    queue.push(...(children.get(node.creativeId) ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------

export type EvidenceStrength = "anecdotal" | "suggestive" | "supported" | "strong";

export type Hypothesis = {
  hypothesisId: string;
  /** Stated as an attribute claim, never as "this creative is good". */
  statement: string;
  axis: Axis | "multiple" | "unknown";
  from: string;
  to: string;
  controlCreativeId: string;
  variantCreativeId: string;
  experimentId?: string | null;
  /** Observed relative difference on the metric tested. */
  observedLift: number | null;
  metric: string;
  conversions: number;
  strength: EvidenceStrength;
  /** Always present. The reason this is not a proven cause. */
  caveat: string;
  /** Other attributes that also differed, if any. Confounds, named. */
  confounds: AttributeDelta[];
  createdAt: string;
  status: "open" | "supported" | "contradicted" | "inconclusive";
};

/**
 * How much weight one comparison deserves.
 *
 * Conversion count dominates because everything downstream is priced in
 * conversions — a decisive CTR difference on 100,000 impressions still says
 * nothing about whether the change made money. Nothing here ever reaches
 * certainty; "strong" means "worth acting on", not "established".
 */
export function gradeEvidence(input: { decisive: boolean; conversions: number; independentReplications?: number }): EvidenceStrength {
  const replications = input.independentReplications ?? 0;
  if (!input.decisive) return "anecdotal";
  if (input.conversions >= 30 && replications >= 2) return "strong";
  if (input.conversions >= 15 || replications >= 1) return "supported";
  if (input.conversions >= 5) return "suggestive";
  return "anecdotal";
}

/**
 * Turn a head-to-head into an attribute claim.
 *
 * Refuses to name a cause when more than one attribute moved. That refusal is
 * the feature: a system that credits the most plausible-sounding delta will
 * confidently accumulate a body of false knowledge, and every future brief will
 * be built on it.
 */
export function formHypothesis(input: {
  hypothesisId: string;
  control: LineageNode;
  variant: LineageNode;
  comparison: ComparisonResult;
  metric: string;
  conversions: number;
  experimentId?: string | null;
  now: string;
}): Hypothesis {
  const deltas = diffCreatives(input.control.classification, input.variant.classification);
  const decisive = input.comparison.verdict === "DECISIVE_DIFFERENCE";
  const single = deltas.length === 1 ? deltas[0] : null;

  const axis: Hypothesis["axis"] = single ? single.axis : deltas.length === 0 ? "unknown" : "multiple";
  const lift = input.comparison.difference !== 0 && input.comparison.b.rate > 0
    ? input.comparison.difference / input.comparison.b.rate
    : null;

  let statement: string;
  let caveat: string;

  if (single) {
    statement =
      `Changing ${single.axis} from "${single.from}" to "${single.to}" is associated with ` +
      `${lift === null ? "a difference" : `${(lift * 100).toFixed(0)}%`} in ${input.metric}.`;
    caveat =
      "Association, not proof. Ad delivery is algorithmic and audiences overlap, so a single " +
      "comparison is grounds for testing again, not for treating this as established.";
  } else if (deltas.length === 0) {
    statement = `${input.variant.creativeId} differs from ${input.control.creativeId} in no classified attribute.`;
    caveat =
      "Nothing classified changed, so any difference comes from something unrecorded — execution " +
      "quality, timing, or delivery. Classify both before drawing a conclusion.";
  } else {
    statement =
      `${input.variant.creativeId} outperforms ${input.control.creativeId} on ${input.metric}, but ` +
      `${deltas.length} attributes differ (${deltas.map((d) => d.axis).join(", ")}).`;
    caveat =
      "Unattributable by construction. More than one variable moved, so no single attribute can be " +
      "credited. Re-run changing one at a time if the cause matters.";
  }

  return {
    hypothesisId: input.hypothesisId,
    statement,
    axis,
    from: single?.from ?? "",
    to: single?.to ?? "",
    controlCreativeId: input.control.creativeId,
    variantCreativeId: input.variant.creativeId,
    experimentId: input.experimentId ?? null,
    observedLift: lift,
    metric: input.metric,
    conversions: input.conversions,
    strength: gradeEvidence({ decisive, conversions: input.conversions }),
    caveat,
    confounds: single ? [] : deltas,
    createdAt: input.now,
    status: decisive ? (single ? "supported" : "inconclusive") : "inconclusive",
  };
}

// ---------------------------------------------------------------------------
// The evidence ledger
// ---------------------------------------------------------------------------

export type AttributeBelief = {
  axis: Axis;
  value: string;
  /** Comparisons where this value was the winning side. */
  supportingComparisons: number;
  /** Comparisons where it lost. Kept because absence of this is how bias forms. */
  contradictingComparisons: number;
  totalConversions: number;
  /** Net confidence, bounded. Never presented as a probability of truth. */
  score: number;
  strength: EvidenceStrength;
  hypothesisIds: string[];
  /** Set when the evidence points the other way. Explored again only deliberately. */
  discouraged: boolean;
};

/**
 * Fold hypotheses into per-attribute beliefs.
 *
 * Both sides of every comparison are recorded — the winner gains support and
 * the loser gains a contradiction. Counting only winners is how a system
 * convinces itself that everything works: an attribute that won once and lost
 * four times would otherwise look like a proven success.
 *
 * Multi-attribute comparisons are excluded entirely. They are real results but
 * cannot be assigned to an attribute, and folding them in on a guess would
 * corrupt exactly the ledger this is meant to protect.
 */
export function buildBeliefs(hypotheses: Hypothesis[]): AttributeBelief[] {
  const beliefs = new Map<string, AttributeBelief>();

  const touch = (axis: Axis, value: string): AttributeBelief => {
    const key = `${axis}|${value}`;
    const existing = beliefs.get(key);
    if (existing) return existing;
    const fresh: AttributeBelief = {
      axis, value,
      supportingComparisons: 0, contradictingComparisons: 0, totalConversions: 0,
      score: 0, strength: "anecdotal", hypothesisIds: [], discouraged: false,
    };
    beliefs.set(key, fresh);
    return fresh;
  };

  for (const h of hypotheses) {
    if (h.axis === "multiple" || h.axis === "unknown") continue;
    if (h.status === "inconclusive") continue;
    const axis = h.axis;

    const improved = (h.observedLift ?? 0) > 0;
    const winner = improved ? h.to : h.from;
    const loser = improved ? h.from : h.to;

    const win = touch(axis, winner);
    win.supportingComparisons += 1;
    win.totalConversions += h.conversions;
    win.hypothesisIds.push(h.hypothesisId);

    const lose = touch(axis, loser);
    lose.contradictingComparisons += 1;
    lose.hypothesisIds.push(h.hypothesisId);
  }

  for (const belief of beliefs.values()) {
    const net = belief.supportingComparisons - belief.contradictingComparisons;
    const total = belief.supportingComparisons + belief.contradictingComparisons;
    belief.score = total > 0 ? Math.round((net / total) * 100) / 100 : 0;
    belief.strength = gradeEvidence({
      decisive: true,
      conversions: belief.totalConversions,
      independentReplications: Math.max(0, belief.supportingComparisons - 1),
    });
    belief.discouraged = belief.score < 0 && total >= 2;
  }

  return [...beliefs.values()].sort((a, b) => b.score - a.score || b.totalConversions - a.totalConversions);
}

/**
 * What the system currently believes, in words.
 *
 * Deliberately hedged. This text ends up in briefs and in the Command Center,
 * and the language it uses becomes the language the operator thinks in — so it
 * says "associated with" and names the sample, every time.
 */
export function summariseBelief(belief: AttributeBelief): string {
  const total = belief.supportingComparisons + belief.contradictingComparisons;
  if (total === 0) return `No comparisons yet involve ${belief.axis} = ${belief.value}.`;
  if (belief.discouraged) {
    return (
      `${belief.axis} "${belief.value}" has lost ${belief.contradictingComparisons} of ${total} comparisons. ` +
      "Treat as discouraged — retest only with a specific reason to expect a different result."
    );
  }
  if (belief.score <= 0) {
    return `${belief.axis} "${belief.value}" is even across ${total} comparison(s). No signal either way yet.`;
  }
  return (
    `${belief.axis} "${belief.value}" won ${belief.supportingComparisons} of ${total} comparison(s) ` +
    `across ${belief.totalConversions} conversions — ${belief.strength} evidence. Associated with better ` +
    "performance; not established as the cause."
  );
}

/**
 * Retired creatives stay queryable forever.
 *
 * The memory that matters most is negative. This is the list a fresh session
 * reads before proposing anything, and losing it is how the same dead angle
 * gets funded twice.
 */
export type RetiredRecord = {
  creativeId: string;
  classification: CreativeClassification;
  retiredAt: string;
  reason: string;
  spendBeforeRetirement: number;
  conversions: number;
  /** What it taught. A creative that failed for a known reason is worth more. */
  lesson: string | null;
};

export function retirementLesson(record: Omit<RetiredRecord, "lesson">, beliefs: AttributeBelief[]): string | null {
  const discouraging = beliefs.filter(
    (b) => b.discouraged && String(record.classification[b.axis]) === b.value,
  );
  if (discouraging.length === 0) return null;
  return (
    `Carried ${discouraging.map((b) => `${b.axis}=${b.value}`).join(", ")}, which the ledger already ` +
    "discourages. Check the ledger before rebuilding anything similar."
  );
}
