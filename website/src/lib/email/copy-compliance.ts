/**
 * THE BRAND'S COPY RULES, WHERE THEY CAN ACTUALLY STOP SOMETHING.
 *
 * `.claude/skills/vanta-creative-director/references/brand.md` states the
 * voice in one line — "No hype, no stacked adjectives, no emojis, no
 * exclamation marks" — and references/compliance.md repeats the prohibition
 * among the rules it calls non-negotiable. Both were written down, and nothing
 * in the application checked either, so the highest-volume lifecycle email in
 * the system shipped for weeks with the headline
 *
 *     RESEARCH. TESTED. TRANSPARENT 🧪
 *
 * to 54 recipients, at the worst open rate of any message the store sends
 * (20.4% against 45% for cart recovery). An emoji in a subject line is a mild
 * spam signal on top of being off-voice, so an unenforced style rule was
 * costing inbox placement as well.
 *
 * WHY ONLY THESE TWO RULES. They are the ones the brand states absolutely AND
 * that a machine can decide without judgement. "No hype" and "no stacked
 * adjectives" are equally real and are a human's call: a banned-word list
 * would refuse legitimate copy, and a check that produces false refusals is
 * one operators learn to work around — which costs more than it saves. A rule
 * that fires only when it is certainly right is a rule people trust.
 *
 * Applied at the write boundary rather than at send, so an operator finds out
 * while they are typing rather than from a delivered message.
 */

/**
 * Emoji, without catching ordinary text.
 *
 * Matching "non-ASCII" would refuse Café, Ångström, ±0.5 and µg — all of which
 * are legitimate here, and one of which is a unit this catalogue uses. These
 * are the pictographic ranges plus the two dingbats that read as emoji in a
 * subject line, and Variation Selector-16, which is what turns an otherwise
 * textual glyph (❗, ✅) into a coloured one.
 */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{E0020}-\u{E007F}]/u;

/**
 * The first rule this copy breaks, phrased for the person who has to fix it,
 * or null when it breaks none.
 *
 * One issue rather than a list: an operator fixes one thing and saves again,
 * and a wall of complaints about a single sentence reads as the tool being
 * broken rather than the copy.
 */
export function findCopyComplianceIssue(copy: string | null | undefined): string | null {
  const text = String(copy ?? "");
  if (!text) return null;

  if (EMOJI_PATTERN.test(text)) {
    return "Vanta copy carries no emoji — it reads as off-brand and it is a spam signal in a subject line. Remove it and say the thing plainly.";
  }
  if (text.includes("!")) {
    return "Vanta copy carries no exclamation marks. State it as a fact instead: \"Every batch has a published report\" rather than \"Every batch is tested!\".";
  }
  return null;
}

/** The same question over several fields at once, in the order a form shows them. */
export function findCopyComplianceIssueIn(
  fields: ReadonlyArray<{ label: string; value: string | null | undefined }>,
): string | null {
  for (const field of fields) {
    const issue = findCopyComplianceIssue(field.value);
    if (issue) return `${field.label}: ${issue}`;
  }
  return null;
}
