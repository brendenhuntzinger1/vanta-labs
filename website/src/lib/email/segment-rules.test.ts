import { describe, expect, it } from "vitest";
import {
  evaluateSegmentRule,
  parseSegmentRule,
  describeSegmentRule,
  lifecycleStageFor,
  emptyFacts,
  type ContactFacts,
  type SegmentRule,
  type SegmentFilter,
  FIELD_DEFS,
} from "@/lib/email/segment-rules";

const NOW = Date.parse("2026-09-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function facts(overrides: Partial<ContactFacts> = {}): ContactFacts {
  return { ...emptyFacts("buyer@example.test"), ...overrides };
}

/** One group, one condition, one filter — the shape most rules actually are. */
function rule(filter: Record<string, unknown>): SegmentRule {
  return { groups: [{ conditions: [{ junction: "and", filters: [filter] }] }] } as SegmentRule;
}

// ---------------------------------------------------------------------------
// THE SEGMENT RULE ENGINE.
//
// The six hardcoded segments could answer six questions. Anything else — "spent
// over $200 AND hasn't ordered in 60 days", "bought peptides but never bacteriostatic
// water" — needed a code change and a deploy. This is the general form.
//
// The structure mirrors the one every ESP converged on because it is the one
// operators can actually reason about:
//
//   groups[]        OR   — "this kind of customer, or that kind"
//     conditions[]  AND  — every condition in a group must hold
//       filters[]   junction — and/or within a single condition
//
// THE DANGEROUS FAILURE IS NOT AN ERROR, IT IS A MATCH. A rule the engine
// cannot understand must exclude, never include: a malformed rule that returns
// true is a campaign sent to the entire list. Every parse failure below is
// therefore asserted to produce null, and a null rule is asserted to match
// nobody — not everybody.
// ---------------------------------------------------------------------------

describe("numeric filters", () => {
  it("moreThan compares strictly", () => {
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "moreThan", value: 2 }), facts({ orderCount: 3 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "moreThan", value: 2 }), facts({ orderCount: 2 }), NOW)).toBe(false);
  });

  it("lessThan compares strictly", () => {
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "lessThan", value: 2 }), facts({ orderCount: 1 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "lessThan", value: 2 }), facts({ orderCount: 2 }), NOW)).toBe(false);
  });

  it("equals matches exactly", () => {
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "equals", value: 1 }), facts({ orderCount: 1 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "equals", value: 1 }), facts({ orderCount: 2 }), NOW)).toBe(false);
  });

  it("between is inclusive at both ends", () => {
    const r = rule({ field: "spendCents", operator: "between", valueFrom: 10_000, valueTo: 30_000 });
    expect(evaluateSegmentRule(r, facts({ spendCents: 10_000 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ spendCents: 30_000 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ spendCents: 9_999 }), NOW)).toBe(false);
    expect(evaluateSegmentRule(r, facts({ spendCents: 30_001 }), NOW)).toBe(false);
  });

  // Money is compared in CENTS, always. A rule written against dollars would be
  // out by a factor of 100 and still look plausible in the admin.
  it("spend is expressed in cents", () => {
    const r = rule({ field: "spendCents", operator: "moreThan", value: 20_000 });
    expect(evaluateSegmentRule(r, facts({ spendCents: 25_000 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ spendCents: 250 }), NOW)).toBe(false);
  });
});

describe("date filters", () => {
  it("inTheLast matches inside the window", () => {
    const r = rule({ field: "lastPaidAt", operator: "inTheLast", value: 30, unit: "days" });
    expect(evaluateSegmentRule(r, facts({ lastPaidAt: NOW - 10 * DAY }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ lastPaidAt: NOW - 40 * DAY }), NOW)).toBe(false);
  });

  // THE DORMANCY CASE, AND THE ONE THAT MUST NOT INCLUDE NON-BUYERS.
  // "Has not ordered in 60 days" is a win-back audience. Somebody who has never
  // ordered at all satisfies it literally, and mailing them a win-back is
  // nonsense — so an absent date does not satisfy notInTheLast.
  it("notInTheLast excludes contacts with no date at all", () => {
    const r = rule({ field: "lastPaidAt", operator: "notInTheLast", value: 60, unit: "days" });
    expect(evaluateSegmentRule(r, facts({ lastPaidAt: NOW - 90 * DAY }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ lastPaidAt: NOW - 10 * DAY }), NOW)).toBe(false);
    expect(evaluateSegmentRule(r, facts({ lastPaidAt: null }), NOW)).toBe(false);
  });

  it("supports weeks and months as units", () => {
    expect(evaluateSegmentRule(rule({ field: "lastPaidAt", operator: "inTheLast", value: 2, unit: "weeks" }), facts({ lastPaidAt: NOW - 10 * DAY }), NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "lastPaidAt", operator: "inTheLast", value: 1, unit: "months" }), facts({ lastPaidAt: NOW - 45 * DAY }), NOW)).toBe(false);
  });

  it("before and after compare against an absolute date", () => {
    const r = rule({ field: "lastPaidAt", operator: "after", value: "2026-06-01" });
    expect(evaluateSegmentRule(r, facts({ lastPaidAt: Date.parse("2026-07-01T00:00:00Z") }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ lastPaidAt: Date.parse("2026-05-01T00:00:00Z") }), NOW)).toBe(false);
  });
});

describe("existence and set filters", () => {
  it("exists and doesNotExist test presence", () => {
    expect(evaluateSegmentRule(rule({ field: "lastPaidAt", operator: "exists" }), facts({ lastPaidAt: NOW }), NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "lastPaidAt", operator: "exists" }), facts({ lastPaidAt: null }), NOW)).toBe(false);
    expect(evaluateSegmentRule(rule({ field: "lastPaidAt", operator: "doesNotExist" }), facts({ lastPaidAt: null }), NOW)).toBe(true);
  });

  it("anyOf and noneOf match against the categories bought", () => {
    const bought = facts({ categories: new Set(["peptides"]) });
    expect(evaluateSegmentRule(rule({ field: "category", operator: "anyOf", values: ["peptides", "glassware"] }), bought, NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "category", operator: "noneOf", values: ["peptides"] }), bought, NOW)).toBe(false);
    expect(evaluateSegmentRule(rule({ field: "category", operator: "noneOf", values: ["glassware"] }), bought, NOW)).toBe(true);
  });

  it("matches categories case-insensitively", () => {
    const bought = facts({ categories: new Set(["Peptides"]) });
    expect(evaluateSegmentRule(rule({ field: "category", operator: "anyOf", values: ["peptides"] }), bought, NOW)).toBe(true);
  });

  it("text filters work on the address", () => {
    const contact = facts({ email: "buyer@university.edu" });
    expect(evaluateSegmentRule(rule({ field: "email", operator: "endsWith", value: ".edu" }), contact, NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "email", operator: "contains", value: "university" }), contact, NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "email", operator: "doesNotContain", value: "gmail" }), contact, NOW)).toBe(true);
  });

  it("distinguishes account holders from guest subscribers", () => {
    expect(evaluateSegmentRule(rule({ field: "accountStatus", operator: "equals", value: "account" }), facts({ isAccount: true }), NOW)).toBe(true);
    expect(evaluateSegmentRule(rule({ field: "accountStatus", operator: "equals", value: "account" }), facts({ isAccount: false }), NOW)).toBe(false);
    expect(evaluateSegmentRule(rule({ field: "accountStatus", operator: "equals", value: "guest" }), facts({ isAccount: false }), NOW)).toBe(true);
  });
});

describe("boolean structure", () => {
  const spentOver: SegmentFilter = { field: "spendCents", operator: "moreThan", value: 20_000 };
  const dormant: SegmentFilter = { field: "lastPaidAt", operator: "notInTheLast", value: 60, unit: "days" };

  it("conditions within a group are ANDed", () => {
    const r: SegmentRule = { groups: [{ conditions: [
      { junction: "and", filters: [spentOver] },
      { junction: "and", filters: [dormant] },
    ] }] };

    expect(evaluateSegmentRule(r, facts({ spendCents: 25_000, lastPaidAt: NOW - 90 * DAY }), NOW)).toBe(true);
    // High value but recent — fails the second condition.
    expect(evaluateSegmentRule(r, facts({ spendCents: 25_000, lastPaidAt: NOW - 10 * DAY }), NOW)).toBe(false);
    // Dormant but low value — fails the first.
    expect(evaluateSegmentRule(r, facts({ spendCents: 500, lastPaidAt: NOW - 90 * DAY }), NOW)).toBe(false);
  });

  it("groups are ORed", () => {
    const r: SegmentRule = { groups: [
      { conditions: [{ junction: "and", filters: [spentOver] }] },
      { conditions: [{ junction: "and", filters: [dormant] }] },
    ] };

    expect(evaluateSegmentRule(r, facts({ spendCents: 25_000, lastPaidAt: NOW - 1 * DAY }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ spendCents: 100, lastPaidAt: NOW - 90 * DAY }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ spendCents: 100, lastPaidAt: NOW - 1 * DAY }), NOW)).toBe(false);
  });

  it("filters within one condition honour their junction", () => {
    const orRule: SegmentRule = { groups: [{ conditions: [
      { junction: "or", filters: [spentOver, { field: "orderCount", operator: "moreThan", value: 4 }] },
    ] }] };

    expect(evaluateSegmentRule(orRule, facts({ spendCents: 25_000, orderCount: 1 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(orRule, facts({ spendCents: 100, orderCount: 5 }), NOW)).toBe(true);
    expect(evaluateSegmentRule(orRule, facts({ spendCents: 100, orderCount: 1 }), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FAIL CLOSED. Everything below is about the one outcome this engine must never
// produce: a rule nobody wrote, matching everybody.
// ---------------------------------------------------------------------------

describe("a rule that cannot be understood matches nobody", () => {
  it("an empty rule matches nobody", () => {
    expect(evaluateSegmentRule({ groups: [] }, facts(), NOW)).toBe(false);
  });

  it("a group with no conditions matches nobody", () => {
    expect(evaluateSegmentRule({ groups: [{ conditions: [] }] }, facts(), NOW)).toBe(false);
  });

  it("a condition with no filters matches nobody", () => {
    expect(evaluateSegmentRule({ groups: [{ conditions: [{ junction: "and", filters: [] }] }] }, facts(), NOW)).toBe(false);
  });

  it("an unknown field matches nobody", () => {
    expect(evaluateSegmentRule(rule({ field: "favourite_colour", operator: "equals", value: "blue" }), facts(), NOW)).toBe(false);
  });

  it("an unknown operator matches nobody", () => {
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "isVibing", value: 1 }), facts(), NOW)).toBe(false);
  });

  it("a null or undefined rule matches nobody", () => {
    expect(evaluateSegmentRule(null, facts(), NOW)).toBe(false);
    expect(evaluateSegmentRule(undefined, facts(), NOW)).toBe(false);
  });

  it("a between filter missing a bound matches nobody", () => {
    expect(evaluateSegmentRule(rule({ field: "spendCents", operator: "between", valueFrom: 100 }), facts({ spendCents: 500 }), NOW)).toBe(false);
  });

  it("a numeric filter with a non-numeric value matches nobody", () => {
    expect(evaluateSegmentRule(rule({ field: "orderCount", operator: "moreThan", value: "lots" }), facts({ orderCount: 99 }), NOW)).toBe(false);
  });
});

describe("parseSegmentRule refuses anything it cannot fully understand", () => {
  it("accepts a well-formed rule", () => {
    const parsed = parseSegmentRule({ groups: [{ conditions: [{ junction: "and", filters: [{ field: "orderCount", operator: "moreThan", value: 1 }] }] }] });
    expect(parsed).not.toBeNull();
    expect(parsed?.groups).toHaveLength(1);
  });

  it("accepts a JSON string", () => {
    const parsed = parseSegmentRule('{"groups":[{"conditions":[{"junction":"and","filters":[{"field":"orderCount","operator":"equals","value":1}]}]}]}');
    expect(parsed).not.toBeNull();
  });

  it.each([
    ["not an object", "nonsense"],
    ["no groups key", { conditions: [] }],
    ["groups not an array", { groups: {} }],
    ["an unknown field anywhere", { groups: [{ conditions: [{ junction: "and", filters: [{ field: "nope", operator: "equals", value: 1 }] }] }] }],
    ["an unknown operator anywhere", { groups: [{ conditions: [{ junction: "and", filters: [{ field: "orderCount", operator: "nope", value: 1 }] }] }] }],
    ["an empty group", { groups: [{ conditions: [] }] }],
    ["malformed JSON", "{not json"],
  ])("rejects %s", (_label, input) => {
    expect(parseSegmentRule(input)).toBeNull();
  });

  // A REJECTED RULE IS NOT AN EMPTY RULE THAT MATCHES EVERYONE. The caller gets
  // null and must refuse the send; it never gets a permissive default.
  it("returns null rather than a permissive default", () => {
    const parsed = parseSegmentRule({ groups: "everyone" });
    expect(parsed).toBeNull();
    expect(evaluateSegmentRule(parsed, facts(), NOW)).toBe(false);
  });
});

describe("lifecycle stages", () => {
  it("calls a frequent recent buyer a champion", () => {
    expect(lifecycleStageFor(facts({ orderCount: 6, spendCents: 60_000, lastPaidAt: NOW - 5 * DAY }), NOW)).toBe("champions");
  });

  it("calls a single recent buyer a recent customer", () => {
    expect(lifecycleStageFor(facts({ orderCount: 1, spendCents: 8_000, lastPaidAt: NOW - 3 * DAY }), NOW)).toBe("recentCustomers");
  });

  it("calls a high-value lapsed buyer cantLose", () => {
    expect(lifecycleStageFor(facts({ orderCount: 5, spendCents: 80_000, lastPaidAt: NOW - 200 * DAY }), NOW)).toBe("cantLose");
  });

  it("calls a never-ordered contact a prospect", () => {
    expect(lifecycleStageFor(facts({ orderCount: 0, lastPaidAt: null }), NOW)).toBe("prospect");
  });

  it("is filterable as a field", () => {
    const r = rule({ field: "lifecycleStage", operator: "anyOf", values: ["champions", "loyalists"] });
    expect(evaluateSegmentRule(r, facts({ orderCount: 6, spendCents: 60_000, lastPaidAt: NOW - 5 * DAY }), NOW)).toBe(true);
    expect(evaluateSegmentRule(r, facts({ orderCount: 0, lastPaidAt: null }), NOW)).toBe(false);
  });
});

describe("describeSegmentRule", () => {
  // The admin shows this back to the operator before they press Send, and the
  // audit log stores it. A rule nobody can read is a rule nobody can check.
  it("renders a single filter in plain language", () => {
    expect(describeSegmentRule(rule({ field: "orderCount", operator: "moreThan", value: 2 }))).toBe("Order count is more than 2");
  });

  it("renders money in dollars even though it compares in cents", () => {
    expect(describeSegmentRule(rule({ field: "spendCents", operator: "moreThan", value: 20_000 }))).toBe("Total spend is more than $200.00");
  });

  it("joins conditions with AND and groups with OR", () => {
    const r: SegmentRule = { groups: [
      { conditions: [
        { junction: "and", filters: [{ field: "orderCount", operator: "moreThan", value: 2 }] },
        { junction: "and", filters: [{ field: "lastPaidAt", operator: "notInTheLast", value: 60, unit: "days" }] },
      ] },
      { conditions: [{ junction: "and", filters: [{ field: "spendCents", operator: "moreThan", value: 50_000 }] }] },
    ] };

    expect(describeSegmentRule(r)).toBe(
      "(Order count is more than 2 AND Last order is not in the last 60 days) OR (Total spend is more than $500.00)",
    );
  });

  it("says so plainly when the rule is unusable", () => {
    expect(describeSegmentRule(null)).toBe("No valid rule — this segment matches nobody.");
  });
});

// ---------------------------------------------------------------------------
// The composer builds its dropdowns from this, rather than hardcoding a second
// copy of the field and operator lists. A UI that offers "is more than" on an
// email address produces a rule the engine will silently never match.
// ---------------------------------------------------------------------------

describe("FIELD_DEFS drives the composer", () => {
  it("describes every field the engine accepts", () => {
    const described = new Set(FIELD_DEFS.map((def) => def.field));
    for (const field of ["email", "orderCount", "spendCents", "lastPaidAt", "firstPaidAt", "category", "accountStatus", "lifecycleStage"]) {
      expect(described.has(field as never)).toBe(true);
    }
  });

  it("offers only operators that field can answer", () => {
    const numeric = FIELD_DEFS.find((def) => def.field === "orderCount");
    expect(numeric?.operators).toContain("moreThan");
    expect(numeric?.operators).not.toContain("startsWith");

    const text = FIELD_DEFS.find((def) => def.field === "email");
    expect(text?.operators).toContain("contains");
    expect(text?.operators).not.toContain("moreThan");

    const date = FIELD_DEFS.find((def) => def.field === "lastPaidAt");
    expect(date?.operators).toContain("inTheLast");
    expect(date?.operators).not.toContain("contains");
  });

  it("names the choices for fields that have a fixed set", () => {
    const stage = FIELD_DEFS.find((def) => def.field === "lifecycleStage");
    expect(stage?.choices).toContain("champions");

    const status = FIELD_DEFS.find((def) => def.field === "accountStatus");
    expect(status?.choices).toEqual(["account", "guest"]);
  });

  it("marks which fields are money, so the composer can ask in dollars", () => {
    expect(FIELD_DEFS.find((def) => def.field === "spendCents")?.kind).toBe("money");
    expect(FIELD_DEFS.find((def) => def.field === "orderCount")?.kind).toBe("number");
  });

  // Every operator a field offers must be one the engine knows, or the composer
  // can build a rule that parses and then matches nobody.
  it("offers no operator the engine cannot evaluate", () => {
    const parsed = FIELD_DEFS.flatMap((def) =>
      def.operators.map((operator) => parseSegmentRule({
        groups: [{ conditions: [{ junction: "and", filters: [{ field: def.field, operator, value: 1 }] }] }],
      })),
    );
    expect(parsed.every((rule) => rule !== null)).toBe(true);
  });
});
