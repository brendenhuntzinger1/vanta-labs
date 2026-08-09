/**
 * Bulk reference intake.
 *
 * The owner will paste a wall of links with opinions attached, not fill in a
 * form two hundred times. So the parser is generous: one reference per line,
 * a URL anywhere in it, and everything else treated as the note. Any of these
 * work, mixed freely in the same paste:
 *
 *   https://tiktok.com/@brand/video/1 — love the lighting, hate the text
 *   Ridge Wallet | https://tiktok.com/@ridge/video/2 | hook is the whole ad
 *   https://instagram.com/reel/xyz
 *   #  a comment line, ignored
 *
 * Two design points that matter more than the parsing.
 *
 * **The owner's note wins.** Automatic taste extraction is a convenience; the
 * note is evidence. When the two disagree the note is authoritative, and the
 * raw text is always preserved so a wrong parse costs nothing permanent.
 *
 * **An intake never fails a batch.** A malformed line is reported and skipped,
 * because losing 199 good references to one bad paste is the failure that stops
 * people using a tool.
 */

import { buildReference, extractTasteSignals, referenceIdFor } from "./reference-library";
import type { OwnerTasteSignal, ReferenceCreative } from "./types";
import type { ReferenceIntake } from "./reference-library";

const URL_RE = /https?:\/\/[^\s|,]+/i;
/** Separators an owner actually types between a company, a link and a note. */
const SPLIT_RE = /\s+[—–|]\s+|\s+--\s+/;

export type ParsedLine = {
  lineNumber: number;
  raw: string;
  intake?: ReferenceIntake;
  problem?: string;
};

/**
 * Turn one pasted line into an intake. Returns a problem rather than throwing;
 * the caller reports it and keeps going.
 */
export function parseLine(raw: string, lineNumber: number): ParsedLine {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return { lineNumber, raw };

  const urlMatch = line.match(URL_RE);
  const url = urlMatch?.[0];

  const parts = line.split(SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  const withoutUrl = parts.filter((p) => !URL_RE.test(p));

  if (!url && withoutUrl.length === 0) {
    return { lineNumber, raw, problem: "no URL and no description — nothing to record" };
  }

  // A short leading fragment before the URL reads as a brand name; anything
  // after it reads as commentary. Wrong occasionally, and harmless when wrong
  // because the raw line is kept.
  let company: string | undefined;
  let note: string | undefined;
  if (withoutUrl.length === 1) {
    const only = withoutUrl[0];
    if (only.length <= 40 && !/\s(is|the|love|like|hate|hook|this)\s/i.test(` ${only} `)) company = only;
    else note = only;
  } else if (withoutUrl.length > 1) {
    const [first, ...rest] = withoutUrl;
    if (first.length <= 40) {
      company = first;
      note = rest.join(" — ");
    } else {
      note = withoutUrl.join(" — ");
    }
  }

  if (!url && !note && company) {
    // A bare name with no link is a description, not a brand label.
    note = company;
    company = undefined;
  }

  return {
    lineNumber,
    raw,
    intake: { url, company, note, kind: url ? "url" : "described" },
  };
}

export type BulkIntakeResult = {
  references: ReferenceCreative[];
  /** Lines that could not be parsed, with the reason and the original text. */
  skipped: { lineNumber: number; raw: string; problem: string }[];
  /** Second and later sightings of a URL already in this batch or the library. */
  duplicates: { lineNumber: number; raw: string; referenceId: string }[];
  /** References with nothing observed yet — the work queue for analysis. */
  needsAnalysis: string[];
};

/**
 * Parse a whole paste into reference records.
 *
 * Deduplication runs against the existing library as well as within the batch,
 * because the same ad pasted a month apart would otherwise become two records
 * that both "independently confirm" a pattern — inflating the evidence count
 * that the whole pattern-ranking scheme depends on.
 */
export function ingestBulk(
  text: string,
  now: string,
  existing: Pick<ReferenceCreative, "referenceId">[] = [],
): BulkIntakeResult {
  const seen = new Set(existing.map((r) => r.referenceId));
  const references: ReferenceCreative[] = [];
  const skipped: BulkIntakeResult["skipped"] = [];
  const duplicates: BulkIntakeResult["duplicates"] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i], i + 1);
    if (parsed.problem) {
      skipped.push({ lineNumber: parsed.lineNumber, raw: parsed.raw, problem: parsed.problem });
      continue;
    }
    if (!parsed.intake) continue; // blank or comment

    const referenceId = referenceIdFor(parsed.intake, now);
    if (seen.has(referenceId)) {
      duplicates.push({ lineNumber: parsed.lineNumber, raw: parsed.raw, referenceId });
      continue;
    }
    seen.add(referenceId);
    references.push(buildReference(parsed.intake, now));
  }

  return {
    references,
    skipped,
    duplicates,
    needsAnalysis: references
      .filter((r) => Object.values(r.observed ?? {}).every((v) => v === undefined || v === null || v === ""))
      .map((r) => r.referenceId),
  };
}

// ---------------------------------------------------------------------------
// Analysis pass
// ---------------------------------------------------------------------------

/**
 * What can be extracted, and by what.
 *
 * Worth being blunt about the limits: from a URL alone, nothing about the video
 * can be known. Nobody can read a hook out of a link. Extraction requires the
 * pixels or the audio, which means either an uploaded asset or a service that
 * fetches and analyses the video. So intake stores the record immediately and
 * an analysis pass fills the observed fields in later — rather than an intake
 * that blocks on analysis and therefore never happens.
 */
export type AnalysisCapability = "from_url_alone" | "needs_asset" | "needs_vision_model";

export const FIELD_CAPABILITY: Record<string, AnalysisCapability> = {
  platform: "from_url_alone",
  company: "from_url_alone",
  captionText: "needs_asset",
  durationSeconds: "needs_asset",
  hook: "needs_vision_model",
  openingFrame: "needs_vision_model",
  visualStyle: "needs_vision_model",
  pacing: "needs_vision_model",
  shotStructure: "needs_vision_model",
  textOverlayStyle: "needs_vision_model",
  voiceoverStructure: "needs_vision_model",
  ctaStructure: "needs_vision_model",
  offerStructure: "needs_vision_model",
  productPresentation: "needs_vision_model",
  transitions: "needs_vision_model",
  soundStyle: "needs_vision_model",
  format: "needs_vision_model",
};

export type AnalysisJob = {
  referenceId: string;
  /** Where the analyser gets the content. */
  input: { kind: "asset"; paths: string[] } | { kind: "url"; url: string } | { kind: "unavailable" };
  fields: string[];
  /** Prompt for whichever vision-capable model runs the pass. */
  instruction: string;
};

const ANALYSIS_INSTRUCTION = `Watch this short-form ad and describe ONLY what it does. Do not evaluate the brand, do not rewrite it, and do not suggest a version for anyone else.

Report, as JSON:
  hook                 the first spoken or written line, verbatim
  openingFrame         what is literally on screen at 0:00
  durationSeconds      total length
  shotStructure        the sequence of shots, one clause each
  pacing               slow | measured | fast | frenetic
  transitions          how cuts are made (hard cut, whip, match cut, none)
  textOverlayStyle     placement, weight, colour, timing of on-screen text
  voiceoverStructure   who speaks, in what register, and how it is structured
  ctaStructure         the call to action and when it appears
  offerStructure       any discount, bundle, guarantee or urgency device
  productPresentation  how and when the product appears
  soundStyle           music, ambient, voice-only
  format               ugc | cinematic | educational | product_focused | founder | listicle
  visualStyle          lighting, colour, camera, set
  whyItMayWork         the psychological mechanism, as a hypothesis
  doNotCopy            elements that are this brand's own expression: logo, mascot,
                       slogan, distinctive transition, signature framing, spokesperson,
                       any specific claim. These must never appear in our work.
  complianceFlags      anything that would fail ad review for a research-materials
                       advertiser: health claims, before/after, body imagery, dosing.

Then state the reusable PATTERNS separately — each as a principle general enough to
apply to any brand in any category. A pattern that only makes sense with this brand's
product in it is not a pattern, it is their ad.`;

/** Build the analysis work queue for references that still have no observations. */
export function buildAnalysisJobs(refs: ReferenceCreative[]): AnalysisJob[] {
  return refs.map((ref) => {
    const assetPaths = ref.source.assetPaths ?? [];
    const input: AnalysisJob["input"] = assetPaths.length
      ? { kind: "asset", paths: assetPaths }
      : ref.source.url
        ? { kind: "url", url: ref.source.url }
        : { kind: "unavailable" };
    return {
      referenceId: ref.referenceId,
      input,
      fields: Object.entries(FIELD_CAPABILITY)
        .filter(([, capability]) => capability !== "from_url_alone")
        .map(([field]) => field),
      instruction: ANALYSIS_INSTRUCTION,
    };
  });
}

export type AnalysisResult = {
  referenceId: string;
  observed: Partial<ReferenceCreative["observed"]>;
  whyItMayWork?: string;
  doNotCopy?: string[];
  complianceFlags?: string[];
};

/**
 * Fold an analysis back into a reference.
 *
 * The owner's note is re-applied last and wins on every dimension it touches.
 * An analyser calling the lighting "moody" does not overrule the owner calling
 * it cheap — the person paying for the ads is the authority on taste, and the
 * whole point of collecting notes is that they steer generation.
 */
export function applyAnalysis(ref: ReferenceCreative, result: AnalysisResult, now: string): ReferenceCreative {
  const merged: ReferenceCreative = {
    ...ref,
    observed: { ...ref.observed, ...result.observed },
    whyItMayWork: result.whyItMayWork ?? ref.whyItMayWork,
    doNotCopy: [...new Set([...(ref.doNotCopy ?? []), ...(result.doNotCopy ?? [])])],
    complianceFlags: [...new Set([...(ref.complianceFlags ?? []), ...(result.complianceFlags ?? [])])],
  };

  if (ref.ownerNote?.trim()) {
    const ownerSignals = extractTasteSignals(ref.ownerNote, ref.referenceId, now);
    const byDimension = new Map<OwnerTasteSignal["dimension"], OwnerTasteSignal>();
    for (const signal of merged.ownerVerdict ?? []) byDimension.set(signal.dimension, signal);
    for (const signal of ownerSignals) byDimension.set(signal.dimension, signal);
    merged.ownerVerdict = [...byDimension.values()];
  }

  return merged;
}

/**
 * Aggregate taste across the whole library into generation guidance.
 *
 * This is how the system stops being a folder of other people's ads and starts
 * having a point of view: repeated preferences on one dimension become a
 * constraint on new work, and a dimension the owner has never mentioned stays
 * absent rather than being invented.
 */
export function tasteProfile(refs: ReferenceCreative[]): {
  dimension: string;
  net: number;
  loves: string[];
  hates: string[];
}[] {
  const buckets = new Map<string, { net: number; loves: string[]; hates: string[] }>();
  const weight: Record<OwnerTasteSignal["sentiment"], number> = { love: 2, like: 1, dislike: -1, hate: -2 };

  for (const ref of refs) {
    for (const signal of ref.ownerVerdict ?? []) {
      const bucket = buckets.get(signal.dimension) ?? { net: 0, loves: [], hates: [] };
      bucket.net += weight[signal.sentiment];
      if (weight[signal.sentiment] > 0) bucket.loves.push(signal.note);
      else bucket.hates.push(signal.note);
      buckets.set(signal.dimension, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([dimension, b]) => ({ dimension, ...b }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}
