// NO `server-only` HERE, DELIBERATELY.
//
// The admin composer is a Client Component, and the whole point of this check
// is that it answers WHILE SOMEONE IS TYPING — a verdict that only arrives
// after Send is a verdict that arrives too late. Adding `server-only` would
// make the module unimportable from the composer and push the check back to
// the server round trip it exists to avoid. It is a pure function over strings
// with no secrets, no I/O and no database, so both sides can hold it.

/**
 * A heuristic read of campaign copy, in the register mailbox filters use.
 *
 * WHAT THIS IS NOT: a prediction of Gmail's verdict. Nothing running locally
 * can be. Placement depends on the recipient's own history with the sender,
 * the domain's reputation, engagement rates and a dozen signals no static
 * check can see. A clean report here is not a promise of the inbox.
 *
 * WHAT IT IS: the signals that are well documented, cheap to detect and — the
 * part that matters — fixable by the person reading the report. Every finding
 * names what to do about it, because a warning an operator cannot act on is
 * just an obstacle they learn to click past.
 */

export type DeliverabilityRisk = "low" | "medium" | "high";

export interface DeliverabilityFinding {
  /** Stable identifier, so tests and the UI can name a finding without matching prose. */
  code: string;
  severity: "warn" | "critical";
  /** What is wrong, in the words of the person who typed the copy. */
  message: string;
  /** What to do instead. Never omitted — see the note above. */
  fix: string;
}

export interface DeliverabilityReport {
  risk: DeliverabilityRisk;
  findings: DeliverabilityFinding[];
}

export interface CampaignCopy {
  subject: string;
  previewText?: string | null;
  headline: string;
  body: string;
  promoCode?: string | null;
  ctaLabel: string;
}

/**
 * Phrases bulk filters have scored against for years — urgency, pressure and
 * "this is an advert" wording.
 *
 * THE CTA LABEL IS NOT SCANNED FOR THESE, and that exclusion is the difference
 * between a useful tool and one that gets ignored. "Shop now" on a button is
 * ordinary commerce; two of this store's win-back automations use exactly that
 * and deliver cleanly. Flagging them would train the operator to dismiss the
 * panel, and a warning nobody reads protects nothing. What filters actually
 * score is this language in the SUBJECT and BODY, which is what is scanned.
 */
const TRIGGER_PHRASES = [
  "act fast",
  "act now",
  "apply now",
  "buy 2 get 1",
  "call now",
  "cash bonus",
  "click here",
  "congratulations",
  "don't miss",
  "dont miss",
  "double your",
  "exclusive deal",
  "expires today",
  "extra cash",
  "final hours",
  "for free",
  "free gift",
  "free offer",
  "guaranteed",
  "hurry",
  "instant access",
  "last chance",
  "limited time",
  "no obligation",
  "offer expires",
  "once in a lifetime",
  "one time offer",
  "only today",
  "order now",
  "risk free",
  "risk-free",
  "satisfaction guaranteed",
  "special promotion",
  "this won't last",
  "urgent",
  "while supplies last",
  "why pay more",
  "winner",
  "you have been selected",
];

/**
 * Below this, the body is doing no work.
 *
 * Twelve is a judgement call and is stated rather than buried. It clears every
 * automation this store already sends — the shortest, `winback_60`, runs to
 * fourteen — and catches the three-word draft the audit found. Raising it would
 * start flagging copy that is merely brief; lowering it lets a one-liner with a
 * discount code through, which is the case this exists for.
 */
const MIN_BODY_WORDS = 12;

/**
 * Gmail and Apple Mail cut a subject around here on a phone, which is where
 * most of this store's traffic reads its mail.
 */
const MAX_SUBJECT_CHARS = 60;

/**
 * Below this many letters there is not enough of a subject to judge its case.
 * Without the floor, a deliberately short subject like "New COAs" would read as
 * 100% capitals and be flagged for shouting.
 */
const MIN_LETTERS_TO_JUDGE_CASE = 8;

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase();
}

function countWords(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

/**
 * The text a filter reads as the message's own language.
 *
 * The CTA label is excluded for the reason given on TRIGGER_PHRASES; the promo
 * CODE is excluded because a code is an opaque token ("B2G1"), not prose, and
 * scoring it would penalise the code for the words the campaign already gets
 * scored on.
 */
function scannableText(copy: CampaignCopy): string {
  return [copy.subject, copy.previewText, copy.headline, copy.body]
    .map(normalize)
    .filter(Boolean)
    .join(" ");
}

/**
 * Every trigger phrase present in a piece of text.
 *
 * Exported because the compiled-in templates need the same vocabulary as the
 * copy typed into the composer. One list, checked in both places — otherwise
 * the guard on hand-written campaigns would be stricter than the guard on the
 * order and affiliate mail that goes out far more often.
 */
export function findTriggerPhrases(text: string): string[] {
  const haystack = normalize(text);
  return TRIGGER_PHRASES.filter((phrase) => haystack.includes(phrase));
}

/**
 * Mechanical hygiene for a subject line: present, not shouted, not padded with
 * punctuation, not so long the inbox truncates it.
 *
 * Deliberately says nothing about the WORDS — that is findTriggerPhrases' job,
 * and keeping them apart is what lets the template sweep apply both to a
 * compiled subject while the composer applies phrase density across the whole
 * of a campaign's copy.
 */
export function checkSubjectLine(rawSubject: string): DeliverabilityFinding[] {
  const findings: DeliverabilityFinding[] = [];
  const subject = String(rawSubject ?? "").trim();

  if (!subject) {
    findings.push({
      code: "subject_missing",
      severity: "critical",
      message: "This campaign has no subject line.",
      fix: "Write one. A message with an empty subject is filtered almost everywhere.",
    });
    return findings;
  }

  // SHOUTING IS MEASURED AS A PROPORTION, NOT AS THE PRESENCE OF CAPITALS.
  // "Your COA is ready to download" is this store's own vocabulary and must
  // pass; "BUY TWO GET ONE THIS WEEK" must not. What separates them is the
  // share of letters in capitals, so that is what is counted.
  const letters = subject.replace(/[^a-z]/gi, "");
  const capitals = subject.replace(/[^A-Z]/g, "");
  if (letters.length >= MIN_LETTERS_TO_JUDGE_CASE && capitals.length / letters.length >= 0.7) {
    findings.push({
      code: "shouting_subject",
      severity: "warn",
      message: "The subject line is written almost entirely in capitals.",
      fix: "Use sentence case. Capitals read as shouting to a person and score as shouting to a filter.",
    });
  }

  if (/[!?]{2,}/.test(subject) || (subject.match(/!/g) ?? []).length > 1) {
    findings.push({
      code: "excessive_punctuation",
      severity: "warn",
      message: "The subject line uses repeated exclamation or question marks.",
      fix: "One is plenty; none is usually better.",
    });
  }

  if (subject.length > MAX_SUBJECT_CHARS) {
    findings.push({
      code: "subject_too_long",
      severity: "warn",
      message: `The subject line is ${subject.length} characters, so most inboxes will cut it off.`,
      fix: `Aim for ${MAX_SUBJECT_CHARS} characters or fewer, and put the point at the front.`,
    });
  }

  return findings;
}

export function checkCampaignDeliverability(copy: CampaignCopy): DeliverabilityReport {
  const findings: DeliverabilityFinding[] = [];
  const text = scannableText(copy);
  const words = countWords(text);

  const hits = findTriggerPhrases(text);

  // DENSITY, NOT A COUNT. One "limited time" in a paragraph of real writing is
  // ordinary marketing and scores as such. The same phrase in a message that is
  // ONLY such phrases is what filters treat as an advert with no content, and
  // the difference between the two is the ratio, not the tally.
  const density = words > 0 ? hits.length / words : 0;

  if (hits.length > 0) {
    const critical = density >= 0.12 || hits.length >= 4;
    findings.push({
      code: "trigger_phrases",
      severity: critical ? "critical" : "warn",
      message:
        `${hits.length} urgency/promotional phrase${hits.length === 1 ? "" : "s"} ` +
        `in ${words} words of copy: ${hits.map((h) => `"${h}"`).join(", ")}.`,
      fix:
        "Say the same thing in plain sentences. The automations that already reach the inbox " +
        "here — \"How's your research going?\", \"Still researching?\" — carry none of this phrasing.",
    });
  }

  findings.push(...checkSubjectLine(copy.subject));

  // The preheader is the line an inbox shows AFTER the subject. Left blank,
  // campaignTemplate falls back to the headline — so the reader sees the same
  // sentence twice and the one piece of copy that could have earned the open is
  // wasted. Not a filter signal on its own; it is an open-rate signal, and open
  // rates are what a domain's reputation is eventually built from.
  if (!String(copy.previewText ?? "").trim()) {
    findings.push({
      code: "preview_text_missing",
      severity: "warn",
      message: "There is no preview text, so the inbox will repeat the headline instead.",
      fix: "Add one line that continues the subject rather than restating it.",
    });
  }

  // A BODY IS THE PRETEXT FOR THE LINK. Strip it away and what is left is a
  // discount code and a button, which is the shape of an advert with nothing
  // around it. The promo code is what turns thin into critical: a short note
  // with no offer attached reads as a short note, while a short note wrapped
  // around a code reads as the offer being the entire message.
  const bodyWords = countWords(normalize(copy.body));
  if (bodyWords > 0 && bodyWords < MIN_BODY_WORDS) {
    const hasCode = Boolean(String(copy.promoCode ?? "").trim());
    findings.push({
      code: "thin_body",
      severity: hasCode ? "critical" : "warn",
      message:
        `The message is ${bodyWords} word${bodyWords === 1 ? "" : "s"} long` +
        `${hasCode ? ", wrapped around a promo code and a link" : ""}.`,
      fix:
        "Give the reader a reason the email exists before the offer — what is new, what it is for, " +
        "why now. Two or three sentences is enough.",
    });
  }

  const risk: DeliverabilityRisk = findings.some((f) => f.severity === "critical")
    ? "high"
    : findings.length > 0
      ? "medium"
      : "low";

  return { risk, findings };
}
