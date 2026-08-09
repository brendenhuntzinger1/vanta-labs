/**
 * The controlled vocabulary for creative intelligence.
 *
 * This is the difference between a folder of saved TikToks and something that
 * can answer "which hook types actually convert for us". Free text cannot be
 * grouped: one analyst writes "starts with a question", another writes
 * "interrogative open", a third writes "asks the viewer something", and three
 * observations of the same pattern become three patterns with one observation
 * each. The evidence count — the only thing that makes a pattern worth betting
 * on — is destroyed by vocabulary drift.
 *
 * So every reference and every Vanta creative is classified along the same
 * fixed axes. Fixed vocabulary on both sides is what lets the system ask the
 * question that matters: *of the attributes we can observe, which correlate
 * with performance?*
 *
 * Two rules keep it honest:
 *
 * **`unknown` is always a legal value.** Forcing a guess to satisfy a required
 * field is how a dataset fills with confident noise. Unclassified is a fact
 * worth storing.
 *
 * **Adding a term is a deliberate act.** If a genuinely new hook type appears,
 * it goes in this file with a definition. Ad-hoc terms are rejected at the
 * boundary, which is what stops the drift this file exists to prevent.
 */

export const HOOK_TYPES = [
  "question",              // opens by asking the viewer something
  "bold_claim",            // asserts something striking up front
  "problem_callout",       // names a frustration the viewer recognises
  "curiosity_gap",         // withholds the payoff
  "direct_address",        // "if you buy X, watch this"
  "demonstration",         // shows the thing happening immediately
  "document_reveal",       // opens on evidence: a report, a label, a number
  "negative",              // "stop doing X" / "the problem with Y"
  "social_proof",          // opens on other people's judgement
  "pattern_interrupt",     // visually or sonically jarring open
  "unknown",
] as const;

export const VISUAL_STYLES = [
  "handheld_ugc",
  "studio_product",
  "cinematic_macro",
  "screen_recording",
  "talking_head",
  "text_on_plain",
  "documentary",
  "lab_clinical",
  "lifestyle",
  "animation_motion_graphics",
  "unknown",
] as const;

export const PACING = ["slow", "measured", "fast", "frenetic", "unknown"] as const;

export const OFFER_TYPES = [
  "none",                  // no offer stated — common in documentation-led work
  "discount_percentage",
  "discount_fixed",
  "bundle",
  "free_shipping",
  "free_gift",
  "subscription",
  "urgency_deadline",
  "guarantee",
  "unknown",
] as const;

export const CTA_TYPES = [
  "shop_now",
  "learn_more",
  "verify_lookup",         // "search your lot number" — native to this brand
  "browse_catalogue",
  "sign_up",
  "watch_more",
  "none",
  "unknown",
] as const;

export const PROOF_TYPES = [
  "none",
  "document",              // a report or certificate on screen
  "lab_data",
  "testimonial",
  "credential",            // a person's authority
  "demonstration",
  "third_party_badge",
  "user_count",
  "unknown",
] as const;

export const PRODUCT_PRESENTATION = [
  "absent",
  "hero_static",
  "in_hand",
  "in_use",
  "packaging_focus",
  "label_closeup",
  "unboxing",
  "comparison_lineup",
  "unknown",
] as const;

export const FORMATS = [
  "ugc",
  "cinematic",
  "educational",
  "product_focused",
  "founder",
  "listicle",
  "comparison",
  "unknown",
] as const;

export const AUDIENCE_POSTURE = [
  "novice",                // assumes no prior knowledge
  "informed_buyer",        // assumes they already know the category
  "sceptic",               // addresses distrust directly
  "price_sensitive",
  "unknown",
] as const;

export type HookType = (typeof HOOK_TYPES)[number];
export type VisualStyle = (typeof VISUAL_STYLES)[number];
export type Pace = (typeof PACING)[number];
export type OfferType = (typeof OFFER_TYPES)[number];
export type CtaType = (typeof CTA_TYPES)[number];
export type ProofType = (typeof PROOF_TYPES)[number];
export type ProductPresentation = (typeof PRODUCT_PRESENTATION)[number];
export type Format = (typeof FORMATS)[number];
export type AudiencePosture = (typeof AUDIENCE_POSTURE)[number];

/**
 * The classification applied to a reference ad AND to a Vanta creative.
 *
 * Deliberately the same shape for both. A correlation between an attribute and
 * performance is only computable when the thing observed in a competitor's ad
 * and the thing built into ours are described in identical terms.
 */
export type CreativeClassification = {
  hookType: HookType;
  visualStyle: VisualStyle;
  pacing: Pace;
  offerType: OfferType;
  ctaType: CtaType;
  proofType: ProofType;
  productPresentation: ProductPresentation;
  format: Format;
  audiencePosture: AudiencePosture;
  durationSeconds?: number;
  /** Shots per second — a numeric companion to the coarse pacing label. */
  cutRate?: number;
  /** Whoever/whatever classified this, so a machine pass is distinguishable. */
  classifiedBy: "human" | "model" | "heuristic";
  classifiedAt: string;
};

export const AXES = {
  hookType: HOOK_TYPES,
  visualStyle: VISUAL_STYLES,
  pacing: PACING,
  offerType: OFFER_TYPES,
  ctaType: CTA_TYPES,
  proofType: PROOF_TYPES,
  productPresentation: PRODUCT_PRESENTATION,
  format: FORMATS,
  audiencePosture: AUDIENCE_POSTURE,
} as const;

export type Axis = keyof typeof AXES;

export const EMPTY_CLASSIFICATION: Omit<CreativeClassification, "classifiedAt" | "classifiedBy"> = {
  hookType: "unknown",
  visualStyle: "unknown",
  pacing: "unknown",
  offerType: "unknown",
  ctaType: "unknown",
  proofType: "unknown",
  productPresentation: "unknown",
  format: "unknown",
  audiencePosture: "unknown",
};

export type ClassificationResult = {
  classification: CreativeClassification;
  /** Terms that were rejected, with the axis they were offered for. */
  rejected: { axis: string; value: string }[];
};

/**
 * Coerce a loose input into a valid classification.
 *
 * Unrecognised terms fall back to `unknown` and are reported rather than
 * silently dropped — a rejected term is a signal that either the classifier is
 * drifting or the vocabulary genuinely needs a new entry, and both are worth
 * a human seeing.
 */
export function classify(
  input: Partial<Record<Axis, string>> & { durationSeconds?: number; cutRate?: number },
  classifiedBy: CreativeClassification["classifiedBy"],
  now: string,
): ClassificationResult {
  const rejected: { axis: string; value: string }[] = [];
  const out = { ...EMPTY_CLASSIFICATION } as CreativeClassification;

  for (const axis of Object.keys(AXES) as Axis[]) {
    const raw = input[axis];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const value = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const allowed = AXES[axis] as readonly string[];
    if (allowed.includes(value)) {
      (out as Record<string, unknown>)[axis] = value;
    } else {
      rejected.push({ axis, value: String(raw) });
    }
  }

  if (typeof input.durationSeconds === "number" && input.durationSeconds > 0) {
    out.durationSeconds = input.durationSeconds;
  }
  if (typeof input.cutRate === "number" && input.cutRate > 0) {
    out.cutRate = input.cutRate;
  }
  out.classifiedBy = classifiedBy;
  out.classifiedAt = now;

  return { classification: out, rejected };
}

/** How much of a classification is actually known. Drives the "needs review" queue. */
export function completeness(classification: CreativeClassification): number {
  const axes = Object.keys(AXES) as Axis[];
  const known = axes.filter((axis) => classification[axis] !== "unknown").length;
  return Math.round((known / axes.length) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

export type AttributePerformance = {
  axis: Axis;
  value: string;
  creatives: number;
  spend: number;
  purchases: number;
  revenue: number;
  roas: number | null;
  cpa: number | null;
  /**
   * Whether there is enough here to mean anything. Aggregating two creatives
   * and calling the winner a "pattern" is how a system convinces itself of
   * nonsense and then spends money on it.
   */
  sufficient: boolean;
};

export const MIN_CREATIVES_FOR_PATTERN = 5;
export const MIN_CONVERSIONS_FOR_PATTERN = 10;

/**
 * Group performance by one classification axis.
 *
 * This is the query the whole taxonomy exists to serve: not "which ad won" but
 * "which characteristic is associated with winning". The `sufficient` flag is
 * load-bearing — a caller should present insufficient rows differently, or not
 * at all, rather than letting a two-creative bucket top a leaderboard.
 */
export function performanceByAttribute(
  rows: {
    creativeId: string;
    classification: CreativeClassification;
    spend: number;
    purchases: number;
    revenue: number;
  }[],
  axis: Axis,
): AttributePerformance[] {
  const buckets = new Map<string, { ids: Set<string>; spend: number; purchases: number; revenue: number }>();

  for (const row of rows) {
    const value = String(row.classification[axis] ?? "unknown");
    const bucket = buckets.get(value) ?? { ids: new Set<string>(), spend: 0, purchases: 0, revenue: 0 };
    bucket.ids.add(row.creativeId);
    bucket.spend += row.spend;
    bucket.purchases += row.purchases;
    bucket.revenue += row.revenue;
    buckets.set(value, bucket);
  }

  return [...buckets.entries()]
    .map(([value, b]) => ({
      axis,
      value,
      creatives: b.ids.size,
      spend: b.spend,
      purchases: b.purchases,
      revenue: b.revenue,
      roas: b.spend > 0 ? b.revenue / b.spend : null,
      cpa: b.purchases > 0 ? b.spend / b.purchases : null,
      sufficient: b.ids.size >= MIN_CREATIVES_FOR_PATTERN && b.purchases >= MIN_CONVERSIONS_FOR_PATTERN,
    }))
    .sort((a, b) => {
      // Sufficient evidence always ranks above insufficient, whatever the ROAS.
      if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
      return (b.roas ?? -1) - (a.roas ?? -1);
    });
}

/**
 * Which axis currently explains the most variation in return.
 *
 * A blunt spread measure rather than a real model: with the sample sizes a new
 * ad account produces, anything more sophisticated would imply a precision the
 * data cannot support. It answers "where should a human look first", which is
 * the honest limit of what this can do early on.
 */
export function mostInformativeAxis(
  rows: Parameters<typeof performanceByAttribute>[0],
): { axis: Axis; spread: number; buckets: number } | null {
  let best: { axis: Axis; spread: number; buckets: number } | null = null;

  for (const axis of Object.keys(AXES) as Axis[]) {
    const grouped = performanceByAttribute(rows, axis).filter((g) => g.sufficient && g.roas !== null);
    if (grouped.length < 2) continue;
    const values = grouped.map((g) => g.roas as number);
    const spread = Math.max(...values) - Math.min(...values);
    if (!best || spread > best.spread) best = { axis, spread, buckets: grouped.length };
  }

  return best;
}
