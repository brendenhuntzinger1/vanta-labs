/**
 * ANALYZE — platform truth beside first-party truth, never merged.
 *
 * TikTok will report more conversions than our own attribution does, and both
 * numbers will be defensible. TikTok counts view-through and cross-device
 * within its own window using signals we cannot see; we count only what our
 * consent-gated attribution layer could actually observe end to end. Neither is
 * "the real number".
 *
 * Averaging them produces a figure with no definition, which is worse than
 * either input. So both are kept, the gap is quantified, and the gap itself is
 * treated as the signal — a stable ratio is normal, a sudden change in it is
 * usually a tracking break rather than a change in customer behaviour.
 *
 * The rule that governs every function here: **our number is a floor.** Consent
 * declines, blocked storage and cross-device journeys all subtract from what we
 * can prove and never add. When first-party is lower, that is expected. When
 * first-party is HIGHER, something is wrong with the platform feed and it is
 * worth saying so loudly.
 */

export type AttributionSide = "platform" | "first_party";

export type ConversionCount = {
  creativeId: string;
  /** TikTok's own reported conversions and value for this creative. */
  platformConversions: number;
  platformValue: number;
  /** What our attribution layer could prove: order_attribution joined to orders. */
  firstPartyConversions: number;
  firstPartyValue: number;
  spend: number;
};

export type ReconciliationRow = {
  creativeId: string;
  spend: number;
  platformConversions: number;
  firstPartyConversions: number;
  /** first-party ÷ platform. Null when the platform reported nothing. */
  captureRate: number | null;
  platformRoas: number | null;
  firstPartyRoas: number | null;
  /** How to read this row, in words a human can act on. */
  interpretation: string;
  flag: ReconciliationFlag | null;
};

export type ReconciliationFlag =
  | "first_party_exceeds_platform"
  | "platform_reports_nothing"
  | "capture_collapsed"
  | "no_conversions_either_side";

/**
 * Below this, our tracking is probably broken rather than merely conservative.
 * Consent decline and cross-device losses realistically cost tens of percent,
 * not ninety.
 */
export const CAPTURE_FLOOR = 0.25;

export function reconcile(row: ConversionCount): ReconciliationRow {
  const captureRate = row.platformConversions > 0 ? row.firstPartyConversions / row.platformConversions : null;
  const platformRoas = row.spend > 0 ? row.platformValue / row.spend : null;
  const firstPartyRoas = row.spend > 0 ? row.firstPartyValue / row.spend : null;

  let flag: ReconciliationFlag | null = null;
  let interpretation: string;

  if (row.platformConversions === 0 && row.firstPartyConversions === 0) {
    flag = "no_conversions_either_side";
    interpretation = "Neither side recorded a conversion. Nothing to reconcile yet.";
  } else if (row.platformConversions === 0 && row.firstPartyConversions > 0) {
    // Our layer proved a sale the platform did not see. The pixel or the
    // click-id handoff is the usual culprit.
    flag = "platform_reports_nothing";
    interpretation =
      `We proved ${row.firstPartyConversions} order(s) the platform did not report. ` +
      "That is backwards — check the pixel is firing and the click id is reaching the order.";
  } else if (captureRate !== null && captureRate > 1) {
    flag = "first_party_exceeds_platform";
    interpretation =
      `We are counting more conversions (${row.firstPartyConversions}) than the platform (${row.platformConversions}). ` +
      "Our number should be a floor, so this suggests over-attribution on our side or under-reporting on theirs.";
  } else if (captureRate !== null && captureRate < CAPTURE_FLOOR) {
    flag = "capture_collapsed";
    interpretation =
      `We can only prove ${(captureRate * 100).toFixed(0)}% of the platform's conversions. ` +
      "Below a quarter is more likely a tracking break than consent loss — check the pixel and attribution first.";
  } else {
    interpretation =
      `We proved ${(captureRate! * 100).toFixed(0)}% of the platform's ${row.platformConversions} conversion(s). ` +
      "Our figure is the floor; true performance is at least this good.";
  }

  return {
    creativeId: row.creativeId,
    spend: row.spend,
    platformConversions: row.platformConversions,
    firstPartyConversions: row.firstPartyConversions,
    captureRate,
    platformRoas,
    firstPartyRoas,
    interpretation,
    flag,
  };
}

export type CaptureBaseline = {
  /** Median capture rate across creatives with enough volume to mean anything. */
  medianCaptureRate: number | null;
  sampledCreatives: number;
  note: string;
};

export const MIN_PLATFORM_CONVERSIONS_FOR_BASELINE = 5;

/**
 * The account's normal capture rate.
 *
 * Worth establishing because the useful question is not "why is our number
 * lower" — it always will be — but "is the gap the size it usually is". Median
 * rather than mean: one creative with a broken landing page would drag an
 * average and mislabel the whole account as broken.
 */
export function captureBaseline(rows: ConversionCount[]): CaptureBaseline {
  const rates = rows
    .filter((r) => r.platformConversions >= MIN_PLATFORM_CONVERSIONS_FOR_BASELINE)
    .map((r) => r.firstPartyConversions / r.platformConversions)
    .sort((a, b) => a - b);

  if (rates.length === 0) {
    return {
      medianCaptureRate: null,
      sampledCreatives: 0,
      note: `No creative has ${MIN_PLATFORM_CONVERSIONS_FOR_BASELINE}+ platform conversions yet, so there is no baseline to compare against.`,
    };
  }

  const mid = Math.floor(rates.length / 2);
  const median = rates.length % 2 === 0 ? (rates[mid - 1] + rates[mid]) / 2 : rates[mid];
  return {
    medianCaptureRate: Math.round(median * 1000) / 1000,
    sampledCreatives: rates.length,
    note:
      `Across ${rates.length} creative(s) with enough volume, we typically prove ` +
      `${(median * 100).toFixed(0)}% of platform-reported conversions. Judge individual creatives against this, not against 100%.`,
  };
}

/**
 * Compare one creative's capture against the account norm.
 *
 * A creative well below the account's own baseline is the interesting case: the
 * account-wide losses (consent, cross-device) apply to everything, so a creative
 * that is worse than its peers points at something specific — a landing page
 * stripping parameters, a redirect losing the click id.
 */
export function captureAnomaly(row: ReconciliationRow, baseline: CaptureBaseline): {
  anomalous: boolean;
  note: string;
} {
  if (row.captureRate === null || baseline.medianCaptureRate === null) {
    return { anomalous: false, note: "Not enough data on one side to compare." };
  }
  const ratio = row.captureRate / baseline.medianCaptureRate;
  if (ratio < 0.5) {
    return {
      anomalous: true,
      note:
        `Capture is ${(row.captureRate * 100).toFixed(0)}% against an account norm of ` +
        `${(baseline.medianCaptureRate * 100).toFixed(0)}%. Account-wide losses affect every creative equally, ` +
        "so a gap this specific usually means this creative's link is losing parameters.",
    };
  }
  return { anomalous: false, note: "Capture is in line with the account norm." };
}

/**
 * Which number to report to the owner, and how to caveat it.
 *
 * Deliberately opinionated: first-party is the number we can defend, so it
 * leads. The platform figure is shown beside it as the optimistic bound rather
 * than hidden — TikTok's optimiser is trained on its own number, so ignoring it
 * makes bidding behaviour inexplicable.
 */
export function headlineRoas(row: ReconciliationRow): {
  value: number | null;
  side: AttributionSide;
  caveat: string;
} {
  if (row.firstPartyRoas === null && row.platformRoas === null) {
    return { value: null, side: "first_party", caveat: "No spend recorded, so there is no return to report." };
  }
  if (row.firstPartyRoas === null) {
    return {
      value: row.platformRoas,
      side: "platform",
      caveat: "Platform-reported only. Our own attribution has not proved a conversion for this creative.",
    };
  }
  return {
    value: row.firstPartyRoas,
    side: "first_party",
    caveat:
      row.platformRoas !== null
        ? `At least ${row.firstPartyRoas.toFixed(2)} on what we can prove; the platform claims ${row.platformRoas.toFixed(2)}.`
        : `At least ${row.firstPartyRoas.toFixed(2)} on what we can prove.`,
  };
}
