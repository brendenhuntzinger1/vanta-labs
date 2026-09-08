/**
 * A/B TESTING FOR BROADCAST CAMPAIGNS.
 *
 * cart-recovery-experiments.ts splits an ongoing sequence two ways and leaves
 * it running. A broadcast campaign wants the other shape: mail a SLICE of the
 * list both ways, wait, then send whichever subject won to everybody who has
 * not been mailed yet. The holdout is the point — it is what makes the test
 * worth running rather than a coin toss across the whole list.
 *
 * THE DECISION IS THE HARD PART, NOT THE SPLIT. "B got 26 clicks and A got 20"
 * is not a result on 500 recipients, and declaring it one — then mailing the
 * remaining 20,000 on that basis — is worse than not testing at all, because
 * the bad call now carries the authority of an experiment. So decideWinner runs
 * a real two-proportion test, is allowed to answer "not yet", and is expected
 * to answer that often.
 *
 * Pure and dependency-free, like the module it mirrors.
 */

export const CAMPAIGN_VARIANTS = ["a", "b"] as const;
export type CampaignVariant = (typeof CAMPAIGN_VARIANTS)[number];

/**
 * The smallest arm this system will draw a conclusion from.
 *
 * Not a statistical constant — the z-test below does that work. This is a floor
 * under it, because on tiny samples the test can technically clear its
 * threshold on a freak split, and a "winner" drawn from 40 people is not a
 * finding anybody should mail 20,000 people on. Stated as a constant so the
 * admin can show "needs 300 per arm, has 180", which is actionable, rather than
 * "no winner yet", which is not.
 */
export const MIN_ARM_SAMPLE = 300;

/**
 * A list smaller than this is not split at all.
 *
 * Two arms of 150 plus a holdout that is barely worth sending to is not an
 * experiment; it is three small sends. Below this the campaign goes out as one.
 */
export const MIN_TESTABLE_AUDIENCE = 2 * MIN_ARM_SAMPLE;

/** Critical value for a two-sided test at 95%. */
const Z_95 = 1.96;

/**
 * FNV-1a, the same hash cart-recovery-experiments.ts uses and for the same
 * reasons: cheap, well distributed, dependency-free, and repeatable across
 * processes and redeploys. This is a coin toss that has to be reproducible, not
 * a security decision.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Which arm this recipient is in for this campaign.
 *
 * KEYED ON BOTH, deliberately. Hashing the address alone would put the same
 * person in arm A of every campaign forever — a systematically under-tested
 * customer, and two arms that stop being comparable populations. Mixing the
 * campaign id in re-draws the split per campaign while staying stable within
 * one, so a retried or resumed send never moves anybody between arms.
 *
 * An unusable address falls to "a", the control, so a recipient who somehow
 * reaches this without an address is measured as the existing behaviour rather
 * than silently joining the treatment.
 */
export function campaignVariantFor(campaignId: string, email: string | null | undefined): CampaignVariant {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address) return "a";
  return CAMPAIGN_VARIANTS[fnv1a(`${String(campaignId ?? "")}:${address}`) % CAMPAIGN_VARIANTS.length];
}

export type AudienceSplit = {
  /** False when the list was too small to learn anything from — everyone is in the holdout. */
  testable: boolean;
  a: string[];
  b: string[];
  holdout: string[];
};

/**
 * Split a recipient list into two test arms and a holdout.
 *
 * DETERMINISTIC, so a send interrupted by a serverless timeout resumes into the
 * same arms rather than reshuffling everybody who had not been mailed yet —
 * which would put some recipients in both arms and make the result meaningless.
 * The test slice is chosen by hash, not by taking the first N, because the
 * recipient list arrives in whatever order the audience query produced and the
 * head of it is not a random sample of the tail.
 */
export function splitTestAudience(input: {
  campaignId: string;
  recipients: string[];
  testFraction: number;
}): AudienceSplit {
  const recipients = input.recipients ?? [];

  // Clamp rather than trust: a fraction from an admin form can be anything.
  const fraction = Number.isFinite(input.testFraction) ? Math.min(Math.max(input.testFraction, 0), 0.5) : 0;

  if (recipients.length < MIN_TESTABLE_AUDIENCE || fraction <= 0) {
    return { testable: false, a: [], b: [], holdout: [...recipients] };
  }

  const wanted = Math.floor(recipients.length * fraction);
  if (wanted < MIN_TESTABLE_AUDIENCE) {
    return { testable: false, a: [], b: [], holdout: [...recipients] };
  }

  // Rank by hash and take the top slice. Stable, order-independent, and it does
  // not care how the audience query sorted its rows.
  const ranked = recipients
    .map((email) => ({ email, rank: fnv1a(`${input.campaignId}:slice:${email}`) }))
    .sort((left, right) => left.rank - right.rank || left.email.localeCompare(right.email));

  const inTest = ranked.slice(0, wanted).map((row) => row.email);
  const holdout = ranked.slice(wanted).map((row) => row.email);

  const a: string[] = [];
  const b: string[] = [];
  for (const email of inTest) {
    if (campaignVariantFor(input.campaignId, email) === "a") a.push(email);
    else b.push(email);
  }

  return { testable: true, a, b, holdout };
}

export type ArmResult = { sent: number; clicked: number };

export type WinnerDecision = {
  winner: CampaignVariant | null;
  confident: boolean;
  rateA: number;
  rateB: number;
  /** Why the decision came out the way it did, in language the admin can show. */
  reason: string;
};

/**
 * Which arm won, if either.
 *
 * A two-proportion z-test at 95%, with a hard sample floor under it. Returning
 * null is a normal, common, correct answer: most subject-line differences are
 * not detectable on the sample a single campaign produces, and saying so is the
 * whole value of doing this properly rather than eyeballing two numbers.
 */
export function decideWinner(input: { a: ArmResult; b: ArmResult }): WinnerDecision {
  const sentA = Math.max(0, Math.floor(input.a?.sent ?? 0));
  const sentB = Math.max(0, Math.floor(input.b?.sent ?? 0));
  const clickedA = Math.max(0, Math.floor(input.a?.clicked ?? 0));
  const clickedB = Math.max(0, Math.floor(input.b?.clicked ?? 0));

  const rateA = sentA > 0 ? clickedA / sentA : 0;
  const rateB = sentB > 0 ? clickedB / sentB : 0;

  if (sentA < MIN_ARM_SAMPLE || sentB < MIN_ARM_SAMPLE) {
    return {
      winner: null,
      confident: false,
      rateA,
      rateB,
      reason: `Not enough sample yet — needs ${MIN_ARM_SAMPLE} per arm, has ${sentA} and ${sentB}.`,
    };
  }

  if (clickedA === clickedB && sentA === sentB) {
    return { winner: null, confident: false, rateA, rateB, reason: "The two arms performed identically." };
  }

  // Pooled proportion, then the standard error of the difference.
  const pooled = (clickedA + clickedB) / (sentA + sentB);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / sentA + 1 / sentB));

  if (!Number.isFinite(standardError) || standardError === 0) {
    return { winner: null, confident: false, rateA, rateB, reason: "Not enough variation to compare the arms." };
  }

  const z = (rateB - rateA) / standardError;

  if (Math.abs(z) < Z_95) {
    return {
      winner: null,
      confident: false,
      rateA,
      rateB,
      reason: "The difference between the arms is within noise — keep the test running or send as one.",
    };
  }

  const winner: CampaignVariant = z > 0 ? "b" : "a";
  const winningRate = winner === "b" ? rateB : rateA;
  const losingRate = winner === "b" ? rateA : rateB;

  return {
    winner,
    confident: true,
    rateA,
    rateB,
    reason: `Variant ${winner.toUpperCase()} clicked at ${(winningRate * 100).toFixed(2)}% against ${(losingRate * 100).toFixed(2)}% — significant at 95%.`,
  };
}
