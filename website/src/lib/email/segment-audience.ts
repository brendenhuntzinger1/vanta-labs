import { emptyFacts, evaluateSegmentRule, type ContactFacts, type SegmentRule } from "@/lib/email/segment-rules";

/**
 * Turning the consented audience plus purchase history into facts a rule can be
 * evaluated against, and applying a rule to produce a recipient list.
 *
 * Kept separate from audience.ts so both halves stay testable without a
 * database: everything here is pure, and the loaders that feed it live with the
 * other loaders.
 *
 * CONSENT IS THE FLOOR, ENFORCED STRUCTURALLY. applyRuleSegment iterates the
 * CONSENTED SET and asks the rule about each member. It never iterates the
 * facts map — which contains anyone the history mentions, consented or not — so
 * there is no arrangement of rule and data that can select somebody who has not
 * opted in. Facts existing for an address is not permission to mail it.
 */

export type PurchaseFacts = {
  lastPaidAt: Map<string, number>;
  firstPaidAt: Map<string, number>;
  orderCount: Map<string, number>;
  spendCents: Map<string, number>;
};

type AudienceSets = {
  accounts: Set<string>;
  subscribers: Set<string>;
  all: Set<string>;
};

function normalize(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * Assemble one facts row per consented contact.
 *
 * EVERY CONTACT GETS A ROW, including one who has never ordered — zeroed rather
 * than absent. A rule asking "order count is less than 2" has to be answerable
 * for a contact with no orders; if they had no row, the rule would skip them
 * and the segment would quietly exclude exactly the people it was written for.
 */
export function buildContactFacts(input: {
  audience: AudienceSets;
  history: PurchaseFacts;
  categoriesByEmail: Map<string, Set<string>>;
}): Map<string, ContactFacts> {
  const { audience, history, categoriesByEmail } = input;
  const facts = new Map<string, ContactFacts>();

  for (const raw of audience.all) {
    const email = normalize(raw);
    if (!email) continue;

    const contact = emptyFacts(email);
    contact.isAccount = audience.accounts.has(raw) || audience.accounts.has(email);
    contact.orderCount = history.orderCount.get(email) ?? 0;
    contact.spendCents = history.spendCents.get(email) ?? 0;
    contact.lastPaidAt = history.lastPaidAt.get(email) ?? null;
    contact.firstPaidAt = history.firstPaidAt.get(email) ?? null;
    contact.categories = categoriesByEmail.get(email) ?? new Set<string>();

    facts.set(email, contact);
  }

  return facts;
}

/**
 * The addresses in the consented audience that match the rule.
 *
 * A null rule — one that failed to parse — selects NOBODY. Treating an unusable
 * rule as "no filter" would send the campaign to the entire list, which is the
 * single worst outcome available here; evaluateSegmentRule answers false for
 * null for the same reason, so the two halves cannot drift apart.
 */
export function applyRuleSegment(input: {
  rule: SegmentRule | null | undefined;
  audience: AudienceSets;
  facts: Map<string, ContactFacts>;
  now: number;
}): string[] {
  const { rule, audience, facts, now } = input;
  if (!rule) return [];

  const selected: string[] = [];

  for (const raw of audience.all) {
    const email = normalize(raw);
    const contact = facts.get(email);
    // No facts row means the contact was not part of the audience this facts
    // map was built from. Refuse rather than guess at zeroed defaults.
    if (!contact) continue;
    if (evaluateSegmentRule(rule, contact, now)) selected.push(email);
  }

  return selected;
}
