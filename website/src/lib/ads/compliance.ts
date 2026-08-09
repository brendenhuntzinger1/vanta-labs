/**
 * The compliance gate — executable, not prose.
 *
 * Vanta sells laboratory research materials, research-use-only. The rules that
 * keep an ad account alive already exist as guidance the Creative Director
 * reads, but guidance is advice: it depends on a model choosing to follow it
 * every single time, across thousands of generations, at 3am, under pressure to
 * produce something punchy. That is not a control.
 *
 * This is the control. Every generated concept passes through it before it can
 * be approved, and a BLOCK cannot be overridden by a good hook. A technically
 * excellent ad machine that gets the account restricted has negative value, so
 * the gate runs first and refuses loudly.
 *
 * Two deliberate design choices:
 *
 * **Regexes over judgement for the hard prohibitions.** A model asked "is this
 * compliant?" will sometimes say yes about a dosing instruction. A pattern
 * match will not. Language models are better at the nuanced cases, so those
 * return REVIEW rather than PASS — the machine narrows the human's work instead
 * of replacing it.
 *
 * **False positives are cheap; false negatives cost an ad account.** The gate
 * over-flags on purpose. Anything it flags wrongly costs one human glance.
 */

export type ComplianceSeverity = "block" | "review";

export type ComplianceFinding = {
  ruleId: string;
  severity: ComplianceSeverity;
  /** Which field tripped it, so a human can go straight there. */
  field: string;
  /** The exact text that matched. Never paraphrased. */
  matched: string;
  why: string;
  remedy: string;
};

export type ComplianceVerdict = {
  status: "PASS" | "REVIEW" | "BLOCK";
  findings: ComplianceFinding[];
  /** True only when nothing blocks. Review items still need a human. */
  approvable: boolean;
  checkedFields: string[];
};

type Rule = {
  id: string;
  severity: ComplianceSeverity;
  pattern: RegExp;
  why: string;
  remedy: string;
};

/**
 * Word-boundary helper. Without it "cure" matches "curetted", "dose" matches
 * "dosed the chromatography column", and the gate becomes noise people learn to
 * click past — which is the same as having no gate.
 */
const w = (body: string) => new RegExp(`\\b(?:${body})\\b`, "i");

const RULES: Rule[] = [
  // --- Human use -----------------------------------------------------------
  {
    id: "human-use/second-person-outcome",
    severity: "block",
    pattern: w("your (?:results|gains|recovery|progress|transformation|journey|protocol|cycle|dose)"),
    why: "Addresses the reader as the person taking the compound. These are research materials, not consumer products.",
    remedy: "Describe the material, not a person using it.",
  },
  {
    id: "human-use/administration",
    severity: "block",
    pattern: w("inject(?:ing|ion|ed)?|subcutaneous|intramuscular|administer(?:ed|ing)?|take (?:it|this|one)|consume|ingest"),
    why: "Implies human administration.",
    remedy: "Remove entirely. There is no compliant phrasing for administering these.",
  },
  {
    id: "dosing/amount-or-schedule",
    severity: "block",
    // A number next to a unit next to a frequency is a dose, whatever it is called.
    pattern: /\b\d+\s?(?:mcg|mg|iu|ml|cc)\b[^.]{0,40}\b(?:per|a|each|every|daily|weekly|day|week|dose|doses|cycle|protocol|stack)\b/i,
    why: "States a dose, frequency or protocol.",
    remedy: "Vial size alone is fine ('5mg vial'). A quantity tied to a schedule is not.",
  },
  {
    id: "dosing/protocol-language",
    severity: "block",
    pattern: w("dosage|titrat(?:e|ion)|stack(?:ing)? with|cycle length|loading phase|maintenance dose"),
    why: "Protocol guidance.",
    remedy: "Remove. Direct research-use questions to documentation, not a protocol.",
  },
  {
    id: "reconstitution/instructions",
    severity: "block",
    pattern: w("reconstitut(?:e|ion|ing)|mix with (?:bacteriostatic|bac|sterile)|dilut(?:e|ion) (?:with|instructions)|draw (?:up|into)"),
    why: "Preparation-for-use instructions.",
    remedy: "Remove from advertising. Handling documentation belongs on the site, not in an ad.",
  },

  // --- Claims --------------------------------------------------------------
  {
    id: "claim/medical",
    severity: "block",
    pattern: w("heal(?:s|ing)?|cure(?:s|d)?|treat(?:s|ment|ing)?|prevent(?:s|ion)?|diagnos(?:e|is|tic)|therapy|therapeutic|remedy"),
    why: "Medical or therapeutic claim.",
    remedy: "Say what the material is, never what it does to a body.",
  },
  {
    id: "claim/performance-or-body",
    severity: "block",
    pattern: w("fat loss|weight loss|lose weight|muscle (?:gain|growth)|lean mass|anti-?ag(?:e|ing)|libido|testosterone boost|energy boost|recovery time|joint pain|hair (?:growth|regrowth)|skin tightening"),
    why: "Body-composition, performance or wellness outcome claim.",
    remedy: "Remove. The documentation angle outperforms outcome claims and survives review.",
  },
  {
    id: "claim/guaranteed-outcome",
    severity: "block",
    pattern: w("guarantee(?:d|s)?|proven to|will (?:improve|increase|reduce|boost)|results in \\d|100% effective"),
    why: "Promises or predicts a result.",
    remedy: "Remove the promise. State only what is documented.",
  },
  {
    id: "claim/transformation",
    severity: "block",
    pattern: /\bbefore\s?(?:\/|and|&|-)\s?after\b|\btransformation\b|\bday \d+ (?:vs|versus) day \d+\b/i,
    why: "Transformation or progress narrative.",
    remedy: "Remove. This framing makes an outcome claim without words.",
  },

  // --- Evidence ------------------------------------------------------------
  {
    id: "proof/fabricated-social",
    severity: "block",
    pattern: w("customers? (?:say|love|rave)|testimonial|\\d+(?:,\\d{3})* (?:happy )?(?:customers|reviews)|\\d(?:\\.\\d)? stars?|rated \\d|verified buyer"),
    why: "Social proof that must be real, permissioned and substantiated — and usually is not.",
    remedy: "Remove unless it is a real, documented, permissioned review that is itself compliant.",
  },
  {
    id: "proof/unverified-certification",
    severity: "block",
    pattern: w("gmp|cgmp|iso[- ]?\\d+|fda[- ](?:approved|registered|cleared)|usp[- ]?verified|clinically (?:proven|tested|validated)|pharmaceutical grade"),
    why: "Certification or approval claim the business has not documented.",
    remedy: "Remove unless you hold the certificate and can produce it.",
  },
  {
    id: "scarcity/manufactured",
    severity: "review",
    pattern: w("only \\d+ left|selling out|last chance|ends (?:tonight|today)|limited time|hurry|don't miss"),
    why: "Urgency must reflect what the live store actually shows.",
    remedy: "Keep only if the store genuinely shows this state right now.",
  },

  // --- Platform ------------------------------------------------------------
  {
    id: "platform/moderation-evasion",
    severity: "block",
    // Deliberate obfuscation: a letter replaced by a digit or symbol inside a
    // compound name, or spaced-out spelling.
    pattern: /\b(?:p[e3]pt[i1]d[e3]s?|s[e3]m[a@]glut[i1]d[e3]|t[i1]rz[e3]p[a@]t[i1]d[e3])\b(?<!peptide)(?<!peptides)(?<!semaglutide)(?<!tirzepatide)|\b(?:p\s+e\s+p\s+t\s+i\s+d\s+e)\b/i,
    why: "Looks like a deliberate attempt to spell around a moderation filter.",
    remedy: "Never obfuscate a product name. If a term is ineligible, the answer is to flag it, not disguise it.",
  },
  {
    id: "platform/named-competitor",
    severity: "review",
    pattern: w("better than [A-Z][a-z]+|unlike [A-Z][a-z]+|compared to [A-Z][a-z]+"),
    why: "Possible named comparison. Structure may be learned from competitors; their name and assets may not be used.",
    remedy: "Compare to the unnamed category norm instead.",
  },

  // --- Brand voice ---------------------------------------------------------
  {
    id: "voice/emoji",
    severity: "review",
    pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    why: "The brand uses no emoji.",
    remedy: "Remove.",
  },
  {
    id: "voice/exclamation",
    severity: "review",
    pattern: /!/,
    why: "The brand uses no exclamation marks.",
    remedy: "Rewrite as a declarative sentence.",
  },
];

/**
 * Substantiation. Any number that looks like a test result must be traceable to
 * a published document, recorded in the concept's own claims list.
 *
 * This is separate from the pattern rules because it is relational: the text is
 * only a violation when the supporting record is absent. "99.2% purity" is
 * perfectly fine on a batch that has a published COA saying so, and a
 * fabrication on one that does not.
 */
const SUBSTANTIATION_PATTERNS: { id: string; pattern: RegExp; kind: string }[] = [
  { id: "purity", pattern: /\b\d{1,3}(?:\.\d+)?\s?%\s?(?:purity|pure|hplc)?/i, kind: "a purity figure" },
  { id: "batch", pattern: /\b(?:batch|lot)\s?(?:number|no\.?|#)?\s?[A-Z0-9][A-Z0-9-]{3,}/i, kind: "a batch or lot number" },
  // Deliberately case-SENSITIVE and verb-anchored. With /i the capital-letter
  // requirement did nothing and the bare word "laboratory" matched ordinary
  // visual direction like "dark matte laboratory field" — a brand that sells
  // laboratory materials says the word constantly. What actually needs a source
  // is an attribution to a named lab.
  { id: "lab", pattern: /\b(?:tested|analysed|analyzed|certified|assayed|verified)\s+by\s+[A-Z][A-Za-z]+/, kind: "a laboratory name" },
  { id: "third-party", pattern: /\bthird[- ]party tested\b/i, kind: "a third-party testing claim" },
];

export type ConceptForReview = {
  creativeId?: string;
  hook?: string;
  script?: string;
  caption?: string;
  cta?: string;
  onScreenText?: string[];
  visualDirection?: string;
  /** Each factual claim and where it is substantiated. */
  claimsUsed?: { claim: string; source: string }[];
};

function fieldsOf(concept: ConceptForReview): { field: string; text: string }[] {
  const fields: { field: string; text: string }[] = [
    { field: "hook", text: concept.hook ?? "" },
    { field: "script", text: concept.script ?? "" },
    { field: "caption", text: concept.caption ?? "" },
    { field: "cta", text: concept.cta ?? "" },
    { field: "visualDirection", text: concept.visualDirection ?? "" },
  ];
  (concept.onScreenText ?? []).forEach((text, i) => fields.push({ field: `onScreenText[${i}]`, text }));
  return fields.filter((f) => f.text.trim().length > 0);
}

/** A claim counts as substantiated when its source is a real, non-placeholder reference. */
function hasSubstantiation(concept: ConceptForReview, kind: string): boolean {
  return (concept.claimsUsed ?? []).some((c) => {
    const source = String(c.source ?? "").trim().toLowerCase();
    if (!source) return false;
    // Placeholders are the common failure: a claims list filled in to satisfy
    // the field rather than to record where a number came from.
    if (/^(tbd|todo|n\/?a|pending|unknown|see site|assumed)$/.test(source)) return false;
    return true;
  }) && (concept.claimsUsed ?? []).length > 0 && kind.length > 0;
}

/**
 * Run every rule. Returns a verdict, never throws — a caller wants to show the
 * findings to a human, not lose them to an exception.
 */
export function reviewConcept(concept: ConceptForReview): ComplianceVerdict {
  const findings: ComplianceFinding[] = [];
  const fields = fieldsOf(concept);

  for (const { field, text } of fields) {
    for (const rule of RULES) {
      const match = text.match(rule.pattern);
      if (!match) continue;
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        field,
        matched: match[0],
        why: rule.why,
        remedy: rule.remedy,
      });
    }

    for (const check of SUBSTANTIATION_PATTERNS) {
      const match = text.match(check.pattern);
      if (!match) continue;
      if (hasSubstantiation(concept, check.kind)) continue;
      findings.push({
        ruleId: `substantiation/${check.id}`,
        severity: "block",
        field,
        matched: match[0],
        why: `States ${check.kind} with nothing in CLAIMS_USED recording where it came from.`,
        remedy: "Record the published COA this came from, or remove the number. No source, no claim.",
      });
    }
  }

  const blocked = findings.some((f) => f.severity === "block");
  return {
    status: blocked ? "BLOCK" : findings.length > 0 ? "REVIEW" : "PASS",
    findings,
    approvable: !blocked,
    checkedFields: fields.map((f) => f.field),
  };
}

/**
 * The approval gate itself.
 *
 * Called wherever a concept moves toward being published. Throws on BLOCK,
 * because a blocked concept reaching an ad account is the failure this whole
 * file exists to prevent — and a return value can be ignored while an exception
 * cannot.
 */
export function assertApprovable(concept: ConceptForReview): ComplianceVerdict {
  const verdict = reviewConcept(concept);
  if (!verdict.approvable) {
    const summary = verdict.findings
      .filter((f) => f.severity === "block")
      .map((f) => `${f.ruleId} in ${f.field}: "${f.matched}"`)
      .join("; ");
    throw new Error(`Concept ${concept.creativeId ?? "(unnamed)"} cannot be approved — ${summary}`);
  }
  return verdict;
}

/** Counts by rule, for the dashboard: which rule is costing the most rework. */
export function summariseFindings(verdicts: ComplianceVerdict[]): { ruleId: string; count: number; severity: ComplianceSeverity }[] {
  const counts = new Map<string, { count: number; severity: ComplianceSeverity }>();
  for (const verdict of verdicts) {
    for (const finding of verdict.findings) {
      const entry = counts.get(finding.ruleId) ?? { count: 0, severity: finding.severity };
      entry.count += 1;
      counts.set(finding.ruleId, entry);
    }
  }
  return [...counts.entries()]
    .map(([ruleId, v]) => ({ ruleId, ...v }))
    .sort((a, b) => b.count - a.count);
}
