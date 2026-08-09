/**
 * Vanta Ads — the domain model for the advertising operating system.
 *
 * This module is deliberately isolated from commerce. Nothing here imports a
 * cart, an order total, a payment client or an inventory function, and nothing
 * in commerce imports this. The ad system READS finished commerce facts
 * (revenue on a paid order) and never participates in producing them.
 *
 * The spine of the whole system is `creative_id`. A reference ad teaches a
 * pattern, a pattern becomes a concept, a concept spawns variants, a variant is
 * published as an ad, an ad accrues performance, and performance decides the
 * concept's fate. If any link in that chain loses the creative_id, the system
 * degrades into a dashboard of numbers nobody can act on.
 */

// ---------------------------------------------------------------------------
// 1. Reference intelligence — what other people's ads teach us
// ---------------------------------------------------------------------------

/** How a reference arrived. Determines how much of it we could actually parse. */
export type ReferenceSourceKind = "url" | "upload" | "screenshots" | "described";

export type CreativeFormat =
  | "ugc"
  | "cinematic"
  | "educational"
  | "product_focused"
  | "founder"
  | "listicle"
  | "unknown";

export type Pacing = "slow" | "measured" | "fast" | "frenetic";

/**
 * A competitor or inspiration ad, as observed. Everything here describes what
 * the SOURCE did — never what Vanta will do. Keeping those apart in the type
 * system is what stops "inspired by" quietly becoming "copied from".
 */
export type ReferenceCreative = {
  referenceId: string;
  addedAt: string;
  source: {
    kind: ReferenceSourceKind;
    url?: string;
    /** Paths in the private reference bucket. Never re-published. */
    assetPaths?: string[];
    company?: string;
    platform: "tiktok" | "reels" | "shorts" | "other";
  };
  /** Why the owner sent this in, in their words. High signal — never discard. */
  ownerNote?: string;
  ownerVerdict?: OwnerTasteSignal[];

  observed: {
    hook?: string;
    openingFrame?: string;
    visualStyle?: string;
    pacing?: Pacing;
    shotStructure?: string;
    durationSeconds?: number;
    textOverlayStyle?: string;
    voiceoverStructure?: string;
    ctaStructure?: string;
    offerStructure?: string;
    productPresentation?: string;
    transitions?: string;
    soundStyle?: string;
    format?: CreativeFormat;
    captionText?: string;
  };

  /** The analyst's read. A hypothesis about mechanism, not a fact. */
  whyItMayWork?: string;
  /** Extracted patterns — the reusable part. */
  patternIds: string[];
  /**
   * Elements that are the source brand's own expression and must never be
   * reproduced. Naming them explicitly is cheaper than remembering not to.
   */
  doNotCopy: string[];
  complianceFlags: string[];
};

/** A directional preference the owner expressed. Weighted into generation. */
export type OwnerTasteSignal = {
  dimension: "lighting" | "hook" | "text" | "pacing" | "sound" | "overall" | "quality_bar";
  sentiment: "love" | "like" | "dislike" | "hate";
  note: string;
  referenceId?: string;
  recordedAt: string;
};

/**
 * The reusable abstraction. A pattern is what survives after the source brand's
 * logo, script and footage are stripped away — which is the whole reason this
 * layer exists rather than a folder of saved videos.
 */
export type CreativePattern = {
  patternId: string;
  name: string;
  dimension:
    | "hook"
    | "opening_frame"
    | "structure"
    | "pacing"
    | "text_treatment"
    | "proof_placement"
    | "cta"
    | "sound";
  /** The general principle, stated so it could apply to any brand. */
  principle: string;
  /** Why it plausibly works on a human. */
  mechanism?: string;
  observedInReferenceIds: string[];
  /** Concepts that used it — the join that later answers "which patterns win". */
  usedByCreativeIds: string[];
  eligibilityRisk: "low" | "medium" | "high";
};

// ---------------------------------------------------------------------------
// 2. Vanta creative — original work
// ---------------------------------------------------------------------------

export type CreativeStatus =
  | "concept"
  | "approved_for_production"
  | "generating"
  | "ready"
  | "published"
  | "testing"
  | "winner"
  | "scaling"
  | "fatiguing"
  | "paused"
  | "retired"
  | "ineligible";

export type ShotSpec = {
  index: number;
  durationSeconds: number;
  description: string;
  cameraNote?: string;
  lightingNote?: string;
  onScreenText?: string;
};

/**
 * A media asset request. Deliberately provider-agnostic: the pipeline records
 * WHAT is needed, and an adapter decides which service renders it. Claude does
 * not generate video; pretending otherwise would strand the pipeline the first
 * time someone tried to run it.
 */
export type MediaRequest = {
  requestId: string;
  kind: "image" | "video" | "voiceover" | "music";
  prompt: string;
  /** Set once an adapter accepts the job. */
  provider?: string;
  providerJobId?: string;
  status: "pending" | "submitted" | "complete" | "failed" | "rejected";
  assetPath?: string;
  failureReason?: string;
};

export type VariantAxis =
  | "hook"
  | "opening_frame"
  | "format"
  | "length"
  | "cta"
  | "landing_page"
  | "sound"
  | "none";

export type VantaCreative = {
  creativeId: string;
  /** Parent concept. A hook variant shares its parent's body. */
  conceptId: string;
  /** Null on the base creative; set on every variant. */
  variantOf?: string | null;
  /**
   * The single thing this variant changes versus its parent. Enforced at
   * creation — a variant that changes two axes produces a result nobody can
   * attribute, which is the same as no result.
   */
  variantAxis: VariantAxis;
  variantLabel?: string;

  archetype: string;
  status: CreativeStatus;
  createdAt: string;

  hook: string;
  openingFrame: string;
  script: string;
  storyboard: ShotSpec[];
  caption: string;
  cta: string;
  landingPath: string;
  audienceHypothesis: string;
  lengthSeconds: number;

  /** Where every factual claim is substantiated. Load-bearing for compliance. */
  claimsUsed: { claim: string; source: string }[];
  eligibility: "likely_eligible" | "restricted" | "needs_verification" | "prohibited";

  /** Provenance. Inspiration is traceable; copying is therefore visible. */
  inspiredByReferenceIds: string[];
  usesPatternIds: string[];

  mediaRequests: MediaRequest[];

  /** Populated only after publishing. Null until then — never guessed. */
  platformRefs?: PlatformRefs | null;
};

/** The join between a Vanta creative and what the ad platform calls it. */
export type PlatformRefs = {
  platform: "tiktok" | "meta";
  advertiserId: string;
  campaignId: string;
  adGroupId: string;
  adId: string;
  /** The utm_content value stamped on the landing URL. The attribution key. */
  utmContent: string;
  publishedAt: string;
};

// ---------------------------------------------------------------------------
// 3. Experiments
// ---------------------------------------------------------------------------

export type Experiment = {
  experimentId: string;
  name: string;
  hypothesis: string;
  axis: VariantAxis;
  /** Creatives in the test. All must differ only along `axis`. */
  armCreativeIds: string[];
  controlCreativeId?: string;
  status: "draft" | "running" | "decided" | "abandoned";
  startedAt?: string;
  decidedAt?: string;
  outcome?: string;
  /** Declared up front so the decision engine can correct for peeking. */
  plannedLooks: number;
  looksTaken: number;
};

// ---------------------------------------------------------------------------
// 4. Performance
// ---------------------------------------------------------------------------

/**
 * One platform-reported slice for one creative on one day. Append-only: the
 * decay curve matters more than any snapshot of it.
 *
 * Site-side fields come from our own analytics joined on utm_content, NOT from
 * the platform — the platform's conversion count is its own attribution model
 * and will disagree with ours. Both are kept so the disagreement is visible.
 */
export type PerformanceSnapshot = {
  snapshotId: string;
  creativeId: string;
  platform: "tiktok" | "meta";
  campaignId: string;
  adGroupId: string;
  adId: string;
  /** UTC date of the reporting slice. */
  statDate: string;

  // Platform-side
  spend: number;
  impressions: number;
  reach?: number | null;
  clicks: number;
  videoViews?: number | null;
  views2s?: number | null;
  views6s?: number | null;
  viewsComplete?: number | null;
  platformConversions?: number | null;

  // Site-side, joined on utm_content
  siteSessions: number;
  siteAddToCarts: number;
  siteCheckouts: number;
  sitePurchases: number;
  siteRevenue: number;
  siteRefunds: number;

  recordedAt: string;
};

/** Derived metrics. Computed, never stored — so they cannot drift from source. */
export type DerivedMetrics = {
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  atcRate: number | null;
  checkoutRate: number | null;
  cvr: number | null;
  cpa: number | null;
  roas: number | null;
  hookRate: number | null;
  holdRate: number | null;
};

// ---------------------------------------------------------------------------
// 5. Decisions
// ---------------------------------------------------------------------------

export type DecisionAction =
  | "keep_running"
  | "scale_budget"
  | "pause"
  | "retire_hook"
  | "produce_variants"
  | "rotate_creative"
  | "investigate_funnel"
  | "no_action";

export type Decision = {
  decisionId: string;
  creativeId: string;
  action: DecisionAction;
  /** Human-readable, and required. A recommendation without a reason is noise. */
  rationale: string;
  /** Metrics that were statistically decided, and those that were not. */
  decidedMetrics: string[];
  unresolvedMetrics: string[];
  evidence: Record<string, unknown>;
  /** Never true until the owner enables autonomy AND guardrails pass. */
  autoExecutable: boolean;
  createdAt: string;
};
