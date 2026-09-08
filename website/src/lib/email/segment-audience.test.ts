import { describe, expect, it } from "vitest";
import { buildContactFacts, applyRuleSegment } from "@/lib/email/segment-audience";
import { parseSegmentRule, type SegmentRule } from "@/lib/email/segment-rules";

const NOW = Date.parse("2026-09-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function audienceOf(accounts: string[], subscribers: string[]) {
  return {
    accounts: new Set(accounts),
    subscribers: new Set(subscribers),
    all: new Set([...accounts, ...subscribers]),
  };
}

const HISTORY = {
  lastPaidAt: new Map([["buyer@x.test", NOW - 10 * DAY]]),
  firstPaidAt: new Map([["buyer@x.test", NOW - 200 * DAY]]),
  orderCount: new Map([["buyer@x.test", 4]]),
  spendCents: new Map([["buyer@x.test", 45_000]]),
};

describe("buildContactFacts", () => {
  it("carries purchase history onto the contact", () => {
    const facts = buildContactFacts({
      audience: audienceOf(["buyer@x.test"], []),
      history: HISTORY,
      categoriesByEmail: new Map([["buyer@x.test", new Set(["peptides"])]]),
    });

    const buyer = facts.get("buyer@x.test");
    expect(buyer?.orderCount).toBe(4);
    expect(buyer?.spendCents).toBe(45_000);
    expect(buyer?.lastPaidAt).toBe(NOW - 10 * DAY);
    expect(buyer?.firstPaidAt).toBe(NOW - 200 * DAY);
    expect(buyer?.categories.has("peptides")).toBe(true);
  });

  // A CONTACT WITH NO ORDERS IS ZEROED, NOT MISSING. A rule asking "order count
  // is less than 2" must be answerable for somebody who has never ordered; if
  // they had no facts row the rule would silently skip them.
  it("gives a never-ordered contact zeroed facts rather than none", () => {
    const facts = buildContactFacts({
      audience: audienceOf([], ["newsletter@x.test"]),
      history: HISTORY,
      categoriesByEmail: new Map(),
    });

    const contact = facts.get("newsletter@x.test");
    expect(contact).toBeDefined();
    expect(contact?.orderCount).toBe(0);
    expect(contact?.spendCents).toBe(0);
    expect(contact?.lastPaidAt).toBeNull();
    expect(contact?.categories.size).toBe(0);
  });

  it("marks account holders apart from guest subscribers", () => {
    const facts = buildContactFacts({
      audience: audienceOf(["member@x.test"], ["guest@x.test"]),
      history: HISTORY,
      categoriesByEmail: new Map(),
    });

    expect(facts.get("member@x.test")?.isAccount).toBe(true);
    expect(facts.get("guest@x.test")?.isAccount).toBe(false);
  });

  // Purchase history is keyed by the order's email, which is not normalised the
  // same way the consent tables are. A mismatch here means a real customer's
  // spend silently reads as zero.
  it("matches history case-insensitively", () => {
    const facts = buildContactFacts({
      audience: audienceOf(["Buyer@X.test"], []),
      history: HISTORY,
      categoriesByEmail: new Map(),
    });

    expect(facts.get("buyer@x.test")?.orderCount).toBe(4);
  });
});

describe("applyRuleSegment", () => {
  const audience = audienceOf(["buyer@x.test", "member@x.test"], ["guest@x.test"]);
  const facts = buildContactFacts({
    audience,
    history: HISTORY,
    categoriesByEmail: new Map([["buyer@x.test", new Set(["peptides"])]]),
  });

  it("keeps only the contacts the rule matches", () => {
    const rule = parseSegmentRule({
      groups: [{ conditions: [{ junction: "and", filters: [{ field: "orderCount", operator: "moreThan", value: 2 }] }] }],
    });

    expect(applyRuleSegment({ rule, audience, facts, now: NOW })).toEqual(["buyer@x.test"]);
  });

  it("combines conditions across the whole consented set", () => {
    const rule = parseSegmentRule({
      groups: [{ conditions: [{ junction: "and", filters: [{ field: "accountStatus", operator: "equals", value: "guest" }] }] }],
    });

    expect(applyRuleSegment({ rule, audience, facts, now: NOW })).toEqual(["guest@x.test"]);
  });

  // ------------------------------------------------------------------
  // CONSENT IS THE FLOOR. This is the property the whole design rests on:
  // a rule is a FILTER over the consented audience, never a lookup that can
  // reach somebody outside it. Facts existing for an address is not permission
  // to mail that address.
  // ------------------------------------------------------------------
  it("can never return a contact who is not in the consented audience", () => {
    const unconsented = audienceOf(["buyer@x.test"], []);
    const factsIncludingOutsiders = buildContactFacts({
      audience: audienceOf(["buyer@x.test", "never-opted-in@x.test"], []),
      history: HISTORY,
      categoriesByEmail: new Map(),
    });

    // A rule that matches literally everyone it is offered.
    const matchAll = parseSegmentRule({
      groups: [{ conditions: [{ junction: "and", filters: [{ field: "email", operator: "contains", value: "@" }] }] }],
    });

    const selected = applyRuleSegment({
      rule: matchAll,
      audience: unconsented,
      facts: factsIncludingOutsiders,
      now: NOW,
    });

    expect(selected).toEqual(["buyer@x.test"]);
    expect(selected).not.toContain("never-opted-in@x.test");
  });

  // ------------------------------------------------------------------
  // FAIL CLOSED, ALL THE WAY OUT TO THE RECIPIENT LIST. A rule that could not
  // be parsed selects NOBODY. The alternative — treating an unusable rule as
  // "no filter" — sends the campaign to the entire list.
  // ------------------------------------------------------------------
  it("selects nobody when the rule could not be parsed", () => {
    expect(applyRuleSegment({ rule: null, audience, facts, now: NOW })).toEqual([]);
    expect(applyRuleSegment({ rule: parseSegmentRule("{broken"), audience, facts, now: NOW })).toEqual([]);
  });

  it("selects nobody when a contact has no facts row", () => {
    const rule = parseSegmentRule({
      groups: [{ conditions: [{ junction: "and", filters: [{ field: "orderCount", operator: "moreThan", value: 0 }] }] }],
    }) as SegmentRule;

    expect(applyRuleSegment({ rule, audience, facts: new Map(), now: NOW })).toEqual([]);
  });
});
