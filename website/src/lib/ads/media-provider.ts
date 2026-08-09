/**
 * Media generation — provider-agnostic by construction.
 *
 * The goal is a finished 9:16 TikTok asset, not a prompt. But nothing in this
 * system should know or care which service renders it: Higgsfield today,
 * Runway or Kling or ElevenLabs tomorrow, several at once when one is better at
 * voice than video. So the pipeline speaks in `RenderJob`s and a provider
 * translates.
 *
 * One honesty constraint shapes the whole file. The Higgsfield integration
 * available to this project is an MCP server, which is reachable from an agent
 * session and NOT from the Next.js runtime — a server route cannot call it. So
 * a provider here does two separable things:
 *
 *   1. `plan()`   — turn a creative into fully-specified render jobs. Pure,
 *                   deterministic, testable, needs no network and no keys.
 *   2. `dispatch` — hand a job to a transport. Implementations exist for an
 *                   agent-executed MCP transport and for a direct HTTP one.
 *
 * Planning works today and is where the craft lives. Dispatch is a seam, and
 * the seam is explicit rather than a stub that pretends to have called
 * something.
 */

import type { MediaRequest, ShotSpec, VantaCreative } from "./types";

/** TikTok's frame. Everything is authored to it rather than cropped into it. */
export const TIKTOK_FRAME = {
  aspect: "9:16" as const,
  width: 1080,
  height: 1920,
  /** Text must clear these or the UI eats it. Fractions of frame height/width. */
  safeAreaTop: 0.12,
  safeAreaBottom: 0.2,
  safeAreaRight: 0.15,
};

export type RenderJobKind = "image" | "video" | "voiceover" | "music";

export type RenderJob = {
  requestId: string;
  creativeId: string;
  kind: RenderJobKind;
  /** The generation prompt, already brand-conditioned. */
  prompt: string;
  /** Negative prompt — what must not appear. Compliance depends on it. */
  avoid: string[];
  durationSeconds?: number;
  aspect: "9:16";
  width: number;
  height: number;
  /** Shot this job renders, when the job is one shot of many. */
  shotIndex?: number;
  /** Voice direction, for voiceover jobs. */
  voice?: { style: string; script: string };
  metadata: Record<string, string | number>;
};

export type DispatchOutcome = {
  requestId: string;
  status: "submitted" | "complete" | "failed" | "unavailable";
  provider: string;
  providerJobId?: string;
  assetPath?: string;
  error?: string;
};

export interface MediaProvider {
  readonly name: string;
  /** Which job kinds this provider can render. */
  readonly supports: RenderJobKind[];
  /** Pure. Turns a creative into render jobs. No network. */
  plan(creative: VantaCreative): RenderJob[];
  /** Executes a job. Implementations may be unavailable at runtime. */
  dispatch(job: RenderJob): Promise<DispatchOutcome>;
}

// ---------------------------------------------------------------------------
// Brand conditioning
// ---------------------------------------------------------------------------

/**
 * Every prompt carries the brand, because a generator with no constraints
 * reverts to the mean — and the mean for "peptide ad" is a glowing blue beaker
 * on a white background, which is the single most off-brand image possible.
 * Values match `references/brand.md` and the production stylesheet.
 */
const BRAND_PROMPT =
  "dark matte laboratory aesthetic, near-black background #0a0a0a, pure neutral greys with no blue tint, " +
  "single champagne-gold accent #c7ae5e used sparingly on under 10 percent of the frame, " +
  "product lit from behind with a soft contact shadow, edges falling away into darkness rather than a hard border, " +
  "generous negative space, hairline highlights, controlled glow not bloom, premium biotech, Apple restraint, luxury laboratory";

/**
 * The negative prompt. Half of this is aesthetic and half is compliance, and
 * the compliance half is not optional: a generated frame showing a syringe
 * entering skin is an ad-account problem no caption can undo.
 */
const AVOID = [
  // Aesthetic failure modes
  "bright white background", "glowing blue liquid", "beakers", "gloved hands holding pipettes at camera",
  "stock photo science", "neon", "gamer aesthetic", "bodybuilding gym", "clinical hospital setting",
  "solid gold fill", "blue-tinted greys", "cluttered frame", "lens flare",
  // Compliance failure modes — never generate these under any prompt
  "human body", "bare skin", "torso", "muscles", "before and after", "weight scale", "tape measure",
  "syringe entering skin", "injection", "person taking a supplement", "pills", "medical procedure",
  "doctor", "lab coat on a person addressing camera as a user",
  // Fabrication failure modes
  "purity percentage text", "certificate of analysis document", "lab report text", "star ratings",
  "review quotes", "testimonial text", "countdown timer", "fake urgency badge",
];

function shotPrompt(shot: ShotSpec, creative: VantaCreative): string {
  const parts = [
    shot.description,
    shot.cameraNote,
    shot.lightingNote,
    BRAND_PROMPT,
    `vertical 9:16 composition, ${shot.durationSeconds} second shot`,
  ].filter(Boolean);
  return `${parts.join(". ")}. Context: ${creative.archetype} ad for a research-materials brand.`;
}

// ---------------------------------------------------------------------------
// Higgsfield
// ---------------------------------------------------------------------------

export type HiggsfieldTransport = (job: RenderJob) => Promise<DispatchOutcome>;

/**
 * Higgsfield provider.
 *
 * `plan` is complete and runs anywhere. `dispatch` needs a transport injected —
 * an agent session wires one that calls the MCP tools; a server would wire an
 * HTTP one once an API key exists. With no transport it returns `unavailable`
 * with a reason, which is the honest answer and keeps the pipeline runnable
 * end to end in review mode.
 */
export class HiggsfieldProvider implements MediaProvider {
  readonly name = "higgsfield";
  readonly supports: RenderJobKind[] = ["image", "video", "voiceover"];
  private readonly transport?: HiggsfieldTransport;

  constructor(transport?: HiggsfieldTransport) {
    this.transport = transport;
  }

  plan(creative: VantaCreative): RenderJob[] {
    if (creative.storyboard.length === 0) {
      throw new Error(`creative ${creative.creativeId} has no storyboard — nothing to render`);
    }

    const jobs: RenderJob[] = [];

    // One video job per shot. Generating a whole ad in one call reliably loses
    // the shot list, and a shot that comes back wrong then costs the entire
    // render rather than one clip.
    creative.storyboard.forEach((shot) => {
      jobs.push({
        requestId: `${creative.creativeId}-shot-${shot.index}`,
        creativeId: creative.creativeId,
        kind: "video",
        prompt: shotPrompt(shot, creative),
        avoid: AVOID,
        durationSeconds: shot.durationSeconds,
        aspect: TIKTOK_FRAME.aspect,
        width: TIKTOK_FRAME.width,
        height: TIKTOK_FRAME.height,
        shotIndex: shot.index,
        metadata: {
          archetype: creative.archetype,
          conceptId: creative.conceptId,
          onScreenText: shot.onScreenText ?? "",
        },
      });
    });

    // The opening frame is rendered as a still as well as a clip. It is the
    // one frame that decides whether anything else gets watched, so it is worth
    // being able to iterate on it without re-rendering video.
    jobs.push({
      requestId: `${creative.creativeId}-openframe`,
      creativeId: creative.creativeId,
      kind: "image",
      prompt: `${creative.openingFrame}. ${BRAND_PROMPT}. Vertical 9:16, this is frame zero of a short-form ad.`,
      avoid: AVOID,
      aspect: TIKTOK_FRAME.aspect,
      width: TIKTOK_FRAME.width,
      height: TIKTOK_FRAME.height,
      metadata: { role: "opening_frame", creativeId: creative.creativeId },
    });

    const spoken = extractSpokenLines(creative.script);
    if (spoken.trim()) {
      jobs.push({
        requestId: `${creative.creativeId}-vo`,
        creativeId: creative.creativeId,
        kind: "voiceover",
        prompt: "Precise, factual, unhurried. Short declarative sentences. No hype, no upsell cadence.",
        avoid: ["excited advertising read", "hard sell", "shouting", "medical authority tone"],
        aspect: TIKTOK_FRAME.aspect,
        width: TIKTOK_FRAME.width,
        height: TIKTOK_FRAME.height,
        voice: { style: "calm, precise, low-register", script: spoken },
        metadata: { creativeId: creative.creativeId },
      });
    }

    return jobs;
  }

  async dispatch(job: RenderJob): Promise<DispatchOutcome> {
    if (!this.transport) {
      return {
        requestId: job.requestId,
        status: "unavailable",
        provider: this.name,
        error:
          "no Higgsfield transport configured. The MCP server is reachable from an agent session, not from " +
          "the web runtime; wire an agent-side transport or an HTTP client with credentials.",
      };
    }
    return this.transport(job);
  }
}

/**
 * Pull only the spoken lines out of a timestamped script.
 *
 * Scripts carry both spoken and on-screen text, and feeding on-screen text to a
 * voice model produces an ad that reads its own subtitles aloud.
 */
export function extractSpokenLines(script: string): string {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(vo|voiceover|spoken)\s*:/i.test(line))
    .map((line) => line.replace(/^(vo|voiceover|spoken)\s*:/i, "").trim())
    .join(" ");
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Turn a creative into pending MediaRequests.
 *
 * The creative already has its permanent `creativeId` before this runs, so the
 * asset that comes back is bound to the concept, hook, references and patterns
 * that produced it — which is the whole basis for learning anything from its
 * later performance.
 */
export function planMedia(creative: VantaCreative, provider: MediaProvider): MediaRequest[] {
  if (!creative.creativeId) {
    throw new Error("cannot plan media for a creative with no creativeId — the asset would be unattributable");
  }
  return provider.plan(creative).map((job) => ({
    requestId: job.requestId,
    kind: job.kind,
    prompt: job.prompt,
    provider: provider.name,
    status: "pending" as const,
  }));
}

export type ReviewGate = {
  creativeId: string;
  ready: boolean;
  missing: string[];
  /** Always true. A generated asset never reaches an ad account unreviewed. */
  requiresHumanApproval: true;
};

/** A creative is only ready for review when every requested asset exists. */
export function reviewGate(creative: VantaCreative): ReviewGate {
  const missing = creative.mediaRequests
    .filter((r) => r.status !== "complete" || !r.assetPath)
    .map((r) => `${r.kind}:${r.requestId} (${r.status})`);
  return {
    creativeId: creative.creativeId,
    ready: creative.mediaRequests.length > 0 && missing.length === 0,
    missing,
    requiresHumanApproval: true,
  };
}
