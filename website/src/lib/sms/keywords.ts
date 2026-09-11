// Inbound message classification: STOP, START, HELP, and the hard case —
// free-text revocation.
//
// Pure, because this is the highest-consequence parser in the programme and it
// must be testable against every spelling a real person uses. A missed opt-out
// is a TCPA claim at $500-$1,500 per subsequent message; a false positive is a
// subscriber lost. Those costs are not symmetric, and this file is biased
// accordingly.
//
// THE FCC'S 2024 REVOCATION RULES, which are live and are what this implements:
// a consumer may revoke consent by ANY reasonable means, and the standardised
// keywords must be honoured automatically. So there are two tiers here:
//
//   1. PER SE KEYWORDS — an exact match, honoured automatically, no judgement.
//   2. FREE TEXT — "stop texting me", "take me off this list". Honoured
//      automatically where the intent is unambiguous, and otherwise routed to
//      a human queue rather than guessed at in either direction.
//
// Twilio also has its own Advanced Opt-Out on the sender number, which stays
// enabled as a second line of defence. It is NOT relied on: it is per-number
// and does not generalise, so Vanta's own suppression is authoritative.

export type InboundIntent =
  /** Revoke marketing consent. Act immediately. */
  | "stop"
  /** Resume, subject to the cooldown and a fresh consent. */
  | "start"
  /** Send identity, contact and opt-out instructions. Always answerable. */
  | "help"
  /** Confirms a pending double opt-in. */
  | "confirm"
  /** Reads as revocation but is not an exact keyword. Suppress AND flag. */
  | "probable_stop"
  /** Nothing actionable. Logged, never auto-replied. */
  | "unknown";

export type InboundClassification = {
  intent: InboundIntent;
  /** The exact keyword matched, for `sms_subscribers.opt_out_keyword`. */
  keyword: string | null;
  /** True when a human should look at this, whatever was done automatically. */
  needsReview: boolean;
};

/**
 * The seven per se opt-out keywords the FCC names, plus the variants carriers
 * and Twilio treat identically. An exact match on any of these is a revocation
 * and is never a judgement call.
 */
export const STOP_KEYWORDS = [
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout", "opt out",
] as const;

/** Twilio's own resume keywords. */
export const START_KEYWORDS = ["start", "unstop", "yes"] as const;

export const HELP_KEYWORDS = ["help", "info"] as const;

/**
 * Double-opt-in confirmation words.
 *
 * "YES" IS DELIBERATELY IN BOTH `START_KEYWORDS` AND HERE, and the ambiguity is
 * resolved by CONTEXT rather than by the word: when a confirmation is pending,
 * YES confirms it; otherwise YES resumes. Guessing from the text alone is how a
 * confirmation reply gets read as a resubscribe (or worse, the reverse).
 */
export const CONFIRM_KEYWORDS = ["yes", "y", "confirm", "join", "agree"] as const;

/**
 * Unambiguous free-text revocation.
 *
 * Every phrase here would be read as "stop messaging me" by any reasonable
 * person, which is the FCC's own standard. Anything requiring interpretation is
 * NOT here — it goes to the review queue instead, because the cost of guessing
 * wrong in the permissive direction is a statutory-damages claim.
 */
const FREE_TEXT_STOP = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bdon'?t (?:text|message|contact) me\b/i,
  /\bno more (?:texts|messages)\b/i,
  /\bleave me alone\b/i,
  /\bquit (?:texting|messaging)\b/i,
  /\bopt(?:ing)? out\b/i,
];

/** Normalise for exact matching: trim, collapse whitespace, strip punctuation. */
function normalise(body: string): string {
  return String(body ?? "")
    .trim()
    .toLowerCase()
    // Carriers and keyboards add trailing punctuation and stray periods. "STOP."
    // is STOP.
    .replace(/[.!?,;:'"]+/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Classify an inbound message.
 *
 * `confirmationPending` is what disambiguates YES. It comes from the
 * subscriber row, not from the message, because the message cannot know.
 */
export function classifyInbound(
  body: string,
  context: { confirmationPending?: boolean } = {},
): InboundClassification {
  const text = normalise(body);

  if (!text) return { intent: "unknown", keyword: null, needsReview: false };

  // 1. PER SE KEYWORDS FIRST, on an exact match of the whole message. Checked
  //    before free text so "STOP" is a clean keyword rather than a fuzzy hit,
  //    and so the recorded keyword is exact.
  if ((STOP_KEYWORDS as readonly string[]).includes(text)) {
    return { intent: "stop", keyword: text, needsReview: false };
  }
  if ((HELP_KEYWORDS as readonly string[]).includes(text)) {
    return { intent: "help", keyword: text, needsReview: false };
  }

  // 2. YES, RESOLVED BY CONTEXT rather than by the word.
  if ((CONFIRM_KEYWORDS as readonly string[]).includes(text)) {
    if (context.confirmationPending) {
      return { intent: "confirm", keyword: text, needsReview: false };
    }
    if ((START_KEYWORDS as readonly string[]).includes(text)) {
      return { intent: "start", keyword: text, needsReview: false };
    }
    // "JOIN" with nothing pending is a person trying to sign up by text. Not
    // actionable without a disclosure, so a human should see it.
    return { intent: "unknown", keyword: text, needsReview: true };
  }
  if ((START_KEYWORDS as readonly string[]).includes(text)) {
    return { intent: "start", keyword: text, needsReview: false };
  }

  // 3. FREE TEXT. Suppress AND flag: the suppression is automatic because the
  //    FCC requires revocation by any reasonable means, and the flag is because
  //    a regex is not a reader.
  for (const pattern of FREE_TEXT_STOP) {
    if (pattern.test(text)) {
      return { intent: "probable_stop", keyword: null, needsReview: true };
    }
  }

  // 4. Anything else. Logged, never auto-replied — an auto-reply to an
  //    unrecognised message is how a support conversation becomes a loop.
  return { intent: "unknown", keyword: null, needsReview: false };
}

/**
 * Does this classification suppress marketing?
 *
 * Both `stop` and `probable_stop` do. The difference is only whether a human is
 * also asked to look, never whether the messages stop.
 */
export function suppressesMarketing(classification: InboundClassification): boolean {
  return classification.intent === "stop" || classification.intent === "probable_stop";
}

/**
 * The HELP reply.
 *
 * Required to be answerable at all times, including for a suppressed number —
 * refusing to tell someone how to stop hearing from you, because they already
 * stopped hearing from you, is the one reply that is never acceptable.
 *
 * Kept under one 160-character GSM-7 segment so HELP never costs two segments.
 */
export function helpReply(input: { brandName: string; helpContact: string }): string {
  const brand = input.brandName.trim() || "Vanta Labs";
  const contact = input.helpContact.trim();
  const tail = contact ? ` Help: ${contact}` : "";
  return `${brand}: reply STOP to opt out.${tail} Msg&data rates may apply.`;
}

/** The single confirmation permitted after an opt-out. Exactly one, then silence. */
export function stopReply(input: { brandName: string }): string {
  const brand = input.brandName.trim() || "Vanta Labs";
  return `${brand}: you're unsubscribed and will get no further marketing texts. Reply HELP for help.`;
}
