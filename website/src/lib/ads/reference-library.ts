/**
 * Reference creative intelligence — turning other people's ads into patterns
 * Vanta can legitimately use.
 *
 * The whole design rests on one separation, enforced in the type system rather
 * than in a policy document:
 *
 *   REFERENCE  — what the source ad actually did. Never reproduced.
 *   PATTERN    — the general principle, stated so it could apply to any brand.
 *   VANTA WORK — an original execution, which cites patterns and never assets.
 *
 * A concept may cite patterns freely. It may cite a reference only as
 * provenance. It may never carry a source's script, footage, logo, graphics,
 * testimonial or claim, and `assertNoVerbatimCopy` is the check that makes that
 * failure loud instead of silent.
 *
 * Intake is deliberately forgiving. The owner will paste a URL and one line of
 * opinion far more often than they will fill in twenty fields, and a system
 * that demands the twenty fields gets used twice. Everything except the URL and
 * the platform is optional, and a bare reference with a good note is still
 * worth more than nothing.
 */

import type {
  CreativeFormat,
  CreativePattern,
  OwnerTasteSignal,
  Pacing,
  ReferenceCreative,
  ReferenceSourceKind,
} from "./types";

export type ReferenceIntake = {
  /** A TikTok/Reels URL, or omitted when the owner uploads or describes it. */
  url?: string;
  kind?: ReferenceSourceKind;
  platform?: "tiktok" | "reels" | "shorts" | "other";
  company?: string;
  caption?: string;
  /** Paths to uploaded video or key frames in the private reference bucket. */
  assetPaths?: string[];
  /** The owner's own words. The highest-signal field in this whole object. */
  note?: string;
  observed?: Partial<ReferenceCreative["observed"]>;
};

const PLATFORM_HOSTS: Record<string, "tiktok" | "reels" | "shorts"> = {
  "tiktok.com": "tiktok",
  "vm.tiktok.com": "tiktok",
  "instagram.com": "reels",
  "youtube.com": "shorts",
  "youtu.be": "shorts",
};

/** Infer the platform from a URL so the owner never has to state the obvious. */
export function inferPlatform(url?: string): "tiktok" | "reels" | "shorts" | "other" {
  if (!url) return "other";
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const [needle, platform] of Object.entries(PLATFORM_HOSTS)) {
      if (host === needle || host.endsWith(`.${needle}`)) return platform;
    }
  } catch {
    // A malformed URL is not worth rejecting an intake over.
  }
  return "other";
}

/**
 * Deterministic id from the URL when there is one, so the same ad submitted
 * twice collapses to one record instead of quietly becoming two data points
 * that both "confirm" the same pattern.
 */
export function referenceIdFor(intake: ReferenceIntake, now: string): string {
  const basis = (intake.url ?? intake.assetPaths?.[0] ?? `${intake.company ?? "unknown"}|${intake.note ?? now}`).trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `ref-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

const TASTE_PATTERNS: { re: RegExp; dimension: OwnerTasteSignal["dimension"]; sentiment: OwnerTasteSignal["sentiment"] }[] = [
  { re: /\b(love|obsessed with|exactly what i want)\b/i, dimension: "overall", sentiment: "love" },
  { re: /\b(hate|awful|terrible)\b/i, dimension: "overall", sentiment: "hate" },
  { re: /\b(looks? cheap|feels? cheap|low.?budget)\b/i, dimension: "quality_bar", sentiment: "dislike" },
  { re: /\b(this is the level|quality i want|production value)\b/i, dimension: "quality_bar", sentiment: "love" },
  { re: /\blighting\b/i, dimension: "lighting", sentiment: "like" },
  { re: /\bhook\b/i, dimension: "hook", sentiment: "like" },
  { re: /\b(text|caption|overlay)\b/i, dimension: "text", sentiment: "like" },
  { re: /\b(pacing|too slow|too fast|cuts?)\b/i, dimension: "pacing", sentiment: "like" },
  { re: /\b(sound|music|audio)\b/i, dimension: "sound", sentiment: "like" },
];

/**
 * Read taste out of a free-text note.
 *
 * "I love the lighting in this" carries two facts — a dimension and a strength
 * of feeling — and both matter for steering later generation. This is a coarse
 * first pass, kept coarse on purpose: the raw note is always preserved, so a
 * wrong guess here costs nothing that reading the note again cannot fix.
 * Negation flips sentiment, because "I don't like this hook" and "I like this
 * hook" must not both register as approval.
 */
export function extractTasteSignals(note: string, referenceId: string, now: string): OwnerTasteSignal[] {
  const text = note.trim();
  if (!text) return [];
  const negated = /\b(don'?t|do not|not|never|no)\s+(like|love|want)\b/i.test(text) || /\b(hate|dislike)\b/i.test(text);

  const signals: OwnerTasteSignal[] = [];
  for (const { re, dimension, sentiment } of TASTE_PATTERNS) {
    if (!re.test(text)) continue;
    if (signals.some((s) => s.dimension === dimension)) continue;
    const resolved: OwnerTasteSignal["sentiment"] =
      negated && (sentiment === "love" || sentiment === "like")
        ? sentiment === "love"
          ? "hate"
          : "dislike"
        : sentiment;
    signals.push({ dimension, sentiment: resolved, note: text, referenceId, recordedAt: now });
  }
  return signals;
}

/** Normalise an intake into a stored reference. Never throws on thin input. */
export function buildReference(intake: ReferenceIntake, now: string): ReferenceCreative {
  const referenceId = referenceIdFor(intake, now);
  const note = intake.note?.trim();
  return {
    referenceId,
    addedAt: now,
    source: {
      kind: intake.kind ?? (intake.url ? "url" : intake.assetPaths?.length ? "upload" : "described"),
      url: intake.url,
      assetPaths: intake.assetPaths,
      company: intake.company?.trim() || undefined,
      platform: intake.platform ?? inferPlatform(intake.url),
    },
    ownerNote: note,
    ownerVerdict: note ? extractTasteSignals(note, referenceId, now) : [],
    observed: {
      captionText: intake.caption?.trim() || undefined,
      ...intake.observed,
    },
    patternIds: [],
    // Populated by the analysis pass. Present from creation so the field is
    // never undefined at the moment somebody needs to check it.
    doNotCopy: [],
    complianceFlags: [],
  };
}

// ---------------------------------------------------------------------------
// The copy firewall
// ---------------------------------------------------------------------------

/** Tokens too generic to indicate copying. Without these every ad "matches". */
const COMMON = new Set([
  "the","a","an","and","or","but","for","to","of","in","on","at","by","with","from","is","are","was",
  "this","that","it","you","your","we","our","i","my","me","if","so","just","get","how","what","why",
  "when","new","now","one","all","can","will","not","no","yes","up","out","more","best","like",
]);

function shingles(text: string, n: number): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    const gram = words.slice(i, i + n);
    if (gram.every((w) => COMMON.has(w))) continue;
    out.add(gram.join(" "));
  }
  return out;
}

export type CopyCheck = {
  ok: boolean;
  /** Phrases of 5+ words shared with a reference. Any hit is a hard fail. */
  sharedPhrases: string[];
  matchedReferenceIds: string[];
};

/**
 * Refuse a Vanta script that reproduces a reference's wording.
 *
 * Five-word overlap is the threshold because four words catch idiom ("at the
 * end of the day") while five almost never collide by chance in short-form
 * scripts. This is the mechanical half of not copying; the judgement half —
 * distinctive visual expression, trade dress, a signature transition — lives in
 * `doNotCopy` on each reference and needs a human or a careful reader.
 */
export function assertNoVerbatimCopy(
  candidateText: string,
  references: Pick<ReferenceCreative, "referenceId" | "observed">[],
): CopyCheck {
  const candidate = shingles(candidateText, 5);
  const sharedPhrases = new Set<string>();
  const matchedReferenceIds = new Set<string>();

  for (const ref of references) {
    const sourceText = [ref.observed?.hook, ref.observed?.captionText, ref.observed?.voiceoverStructure, ref.observed?.ctaStructure]
      .filter(Boolean)
      .join(" \n ");
    if (!sourceText.trim()) continue;
    for (const gram of shingles(sourceText, 5)) {
      if (candidate.has(gram)) {
        sharedPhrases.add(gram);
        matchedReferenceIds.add(ref.referenceId);
      }
    }
  }

  return {
    ok: sharedPhrases.size === 0,
    sharedPhrases: [...sharedPhrases],
    matchedReferenceIds: [...matchedReferenceIds],
  };
}

// ---------------------------------------------------------------------------
// Pattern extraction
// ---------------------------------------------------------------------------

export type PatternDraft = {
  name: string;
  dimension: CreativePattern["dimension"];
  principle: string;
  mechanism?: string;
  eligibilityRisk?: CreativePattern["eligibilityRisk"];
};

export function patternIdFor(draft: PatternDraft): string {
  const slug = draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `pat-${draft.dimension}-${slug}`;
}

/**
 * Fold a draft into the library, merging rather than duplicating.
 *
 * The same principle observed in thirty ads should be one pattern with thirty
 * citations, not thirty patterns. That count is exactly the evidence that makes
 * a pattern worth betting on, and splitting it destroys the signal.
 */
export function upsertPattern(
  library: CreativePattern[],
  draft: PatternDraft,
  referenceId: string,
): CreativePattern[] {
  const patternId = patternIdFor(draft);
  const existing = library.find((p) => p.patternId === patternId);
  if (existing) {
    if (!existing.observedInReferenceIds.includes(referenceId)) {
      existing.observedInReferenceIds.push(referenceId);
    }
    return library;
  }
  library.push({
    patternId,
    name: draft.name,
    dimension: draft.dimension,
    principle: draft.principle,
    mechanism: draft.mechanism,
    observedInReferenceIds: [referenceId],
    usedByCreativeIds: [],
    eligibilityRisk: draft.eligibilityRisk ?? "medium",
  });
  return library;
}

/** Patterns ranked by how much independent evidence supports them. */
export function patternsByEvidence(library: CreativePattern[]): CreativePattern[] {
  return [...library].sort(
    (a, b) => b.observedInReferenceIds.length - a.observedInReferenceIds.length || a.name.localeCompare(b.name),
  );
}

export type LibrarySummary = {
  references: number;
  byPlatform: Record<string, number>;
  byFormat: Record<string, number>;
  patterns: number;
  strongestPatterns: { patternId: string; name: string; seenIn: number }[];
  tasteSignals: number;
  /** References with no observed fields — worth a second pass. */
  unanalysed: string[];
};

export function summariseLibrary(refs: ReferenceCreative[], patterns: CreativePattern[]): LibrarySummary {
  const byPlatform: Record<string, number> = {};
  const byFormat: Record<string, number> = {};
  let tasteSignals = 0;
  const unanalysed: string[] = [];

  for (const ref of refs) {
    byPlatform[ref.source.platform] = (byPlatform[ref.source.platform] ?? 0) + 1;
    const format: CreativeFormat = ref.observed?.format ?? "unknown";
    byFormat[format] = (byFormat[format] ?? 0) + 1;
    tasteSignals += ref.ownerVerdict?.length ?? 0;
    const observedCount = Object.values(ref.observed ?? {}).filter((v) => v !== undefined && v !== null && v !== "").length;
    if (observedCount === 0) unanalysed.push(ref.referenceId);
  }

  return {
    references: refs.length,
    byPlatform,
    byFormat,
    patterns: patterns.length,
    strongestPatterns: patternsByEvidence(patterns)
      .slice(0, 10)
      .map((p) => ({ patternId: p.patternId, name: p.name, seenIn: p.observedInReferenceIds.length })),
    tasteSignals,
    unanalysed,
  };
}

/** Pacing inferred from shot count and duration, when both were captured. */
export function inferPacing(shotCount?: number, durationSeconds?: number): Pacing | undefined {
  if (!shotCount || !durationSeconds || durationSeconds <= 0) return undefined;
  const secondsPerShot = durationSeconds / shotCount;
  if (secondsPerShot >= 4) return "slow";
  if (secondsPerShot >= 2) return "measured";
  if (secondsPerShot >= 1) return "fast";
  return "frenetic";
}
