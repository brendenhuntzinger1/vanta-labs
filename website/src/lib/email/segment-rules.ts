/**
 * The segment rule engine.
 *
 * The six hardcoded segments in audience.ts could answer six questions.
 * Anything else — "spent over $200 AND hasn't ordered in 60 days", "bought
 * peptides but never bacteriostatic water" — needed a code change and a deploy.
 * This is the general form of the same idea.
 *
 * The structure is the one every ESP converged on, because it is the one
 * operators can reason about without a truth table:
 *
 *   groups[]          OR   — "this kind of customer, or that kind"
 *     conditions[]    AND  — every condition in a group must hold
 *       filters[]     junction — `and` / `or` within a single condition
 *
 * CONSENT IS STILL THE FLOOR. Nothing here reaches anybody: the engine is a
 * predicate over a contact that is ALREADY in the consented audience, exactly
 * as applySegment is. A rule cannot add a recipient, only keep one.
 *
 * THE DANGEROUS FAILURE IS NOT AN ERROR, IT IS A MATCH. A rule the engine
 * cannot understand must exclude rather than include — a malformed rule that
 * evaluates true is a campaign sent to the entire list. So every unknown field,
 * unknown operator, missing bound and malformed value returns false, and
 * parseSegmentRule returns null rather than a permissive default. There is
 * deliberately no code path in this file that answers "true" by accident.
 *
 * Pure and clock-injected: `now` is a parameter so window boundaries are
 * assertable. No database, no `server-only` — the admin previews rules with it.
 */

export type FilterField =
  | "email"
  | "orderCount"
  | "spendCents"
  | "lastPaidAt"
  | "firstPaidAt"
  | "category"
  | "accountStatus"
  | "lifecycleStage";

export type FilterOperator =
  | "equals"
  | "notEquals"
  | "moreThan"
  | "lessThan"
  | "between"
  | "inTheLast"
  | "notInTheLast"
  | "before"
  | "after"
  | "anyOf"
  | "noneOf"
  | "contains"
  | "doesNotContain"
  | "startsWith"
  | "endsWith"
  | "exists"
  | "doesNotExist";

export type DateUnit = "days" | "weeks" | "months" | "years";

export type SegmentFilter = {
  field: FilterField;
  operator: FilterOperator;
  value?: string | number;
  values?: string[];
  valueFrom?: number;
  valueTo?: number;
  unit?: DateUnit;
};

export type SegmentCondition = { junction: "and" | "or"; filters: SegmentFilter[] };
export type SegmentGroup = { conditions: SegmentCondition[] };
export type SegmentRule = { groups: SegmentGroup[] };

/** RFM-style lifecycle buckets, plus `prospect` for a contact who has never ordered. */
export type LifecycleStage =
  | "champions"
  | "loyalists"
  | "recentCustomers"
  | "highPotential"
  | "needNurturing"
  | "atRisk"
  | "cantLose"
  | "prospect";

/** Everything a rule may ask about one contact. Assembled once per audience build. */
export type ContactFacts = {
  email: string;
  /** An account holder (customer_preferences) rather than a guest subscriber. */
  isAccount: boolean;
  orderCount: number;
  spendCents: number;
  lastPaidAt: number | null;
  firstPaidAt: number | null;
  categories: Set<string>;
};

export function emptyFacts(email: string): ContactFacts {
  return {
    email: String(email ?? "").trim().toLowerCase(),
    isAccount: false,
    orderCount: 0,
    spendCents: 0,
    lastPaidAt: null,
    firstPaidAt: null,
    categories: new Set<string>(),
  };
}

const FIELDS = new Set<string>([
  "email",
  "orderCount",
  "spendCents",
  "lastPaidAt",
  "firstPaidAt",
  "category",
  "accountStatus",
  "lifecycleStage",
]);

const OPERATORS = new Set<string>([
  "equals",
  "notEquals",
  "moreThan",
  "lessThan",
  "between",
  "inTheLast",
  "notInTheLast",
  "before",
  "after",
  "anyOf",
  "noneOf",
  "contains",
  "doesNotContain",
  "startsWith",
  "endsWith",
  "exists",
  "doesNotExist",
]);

const UNIT_MS: Record<DateUnit, number> = {
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  months: 30 * 24 * 60 * 60 * 1000,
  years: 365 * 24 * 60 * 60 * 1000,
};

/**
 * How much someone must have spent, net, to count as high value.
 *
 * Kept equal to audience.ts's HIGH_VALUE_SPEND_CENTS on purpose: the lifecycle
 * stages and the legacy `high_value` segment should not disagree about who is
 * valuable.
 */
const HIGH_VALUE_CENTS = 30_000;
const RECENT_DAYS = 30;
const LAPSED_DAYS = 90;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** The lifecycle bucket for a contact. Never throws; a contact with no orders is a prospect. */
export function lifecycleStageFor(contact: ContactFacts, now: number): LifecycleStage {
  const orders = contact.orderCount;
  if (orders <= 0 || contact.lastPaidAt === null) return "prospect";

  const daysSince = (now - contact.lastPaidAt) / UNIT_MS.days;
  const recent = daysSince <= RECENT_DAYS;
  const lapsed = daysSince > LAPSED_DAYS;
  const valuable = contact.spendCents >= HIGH_VALUE_CENTS;
  const frequent = orders >= 3;

  if (lapsed) {
    // Losing a repeat, high-spend customer costs more than losing a one-off.
    if (frequent && valuable) return "cantLose";
    if (frequent) return "atRisk";
    return "needNurturing";
  }

  if (recent) {
    if (frequent && valuable) return "champions";
    if (frequent) return "loyalists";
    if (orders === 1) return "recentCustomers";
    return "highPotential";
  }

  // Between recent and lapsed: still active, not yet a worry.
  if (frequent) return "loyalists";
  return "highPotential";
}

/** The value a field resolves to for one contact, or undefined when it is absent. */
function valueFor(field: FilterField, contact: ContactFacts, now: number): string | number | Set<string> | undefined {
  switch (field) {
    case "email":
      return contact.email || undefined;
    case "orderCount":
      return contact.orderCount;
    case "spendCents":
      return contact.spendCents;
    case "lastPaidAt":
      return contact.lastPaidAt ?? undefined;
    case "firstPaidAt":
      return contact.firstPaidAt ?? undefined;
    case "category":
      return contact.categories;
    case "accountStatus":
      return contact.isAccount ? "account" : "guest";
    case "lifecycleStage":
      return lifecycleStageFor(contact, now);
    default:
      return undefined;
  }
}

function evaluateFilter(filter: SegmentFilter, contact: ContactFacts, now: number): boolean {
  if (!filter || !FIELDS.has(filter.field) || !OPERATORS.has(filter.operator)) return false;

  const actual = valueFor(filter.field, contact, now);

  if (filter.operator === "exists") return actual !== undefined && !(actual instanceof Set && actual.size === 0);
  if (filter.operator === "doesNotExist") return actual === undefined || (actual instanceof Set && actual.size === 0);

  // A set-valued field (categories) only answers set questions.
  if (actual instanceof Set) {
    const wanted = (filter.values ?? []).map(text).filter(Boolean);
    if (wanted.length === 0) return false;
    const held = new Set([...actual].map(text));
    const overlaps = wanted.some((want) => held.has(want));
    if (filter.operator === "anyOf") return overlaps;
    if (filter.operator === "noneOf") return !overlaps;
    return false;
  }

  switch (filter.operator) {
    case "anyOf":
    case "noneOf": {
      const wanted = (filter.values ?? []).map(text).filter(Boolean);
      if (wanted.length === 0) return false;
      const hit = actual !== undefined && wanted.includes(text(actual));
      return filter.operator === "anyOf" ? hit : !hit;
    }

    case "equals":
    case "notEquals": {
      if (actual === undefined) return false;
      const same = isFiniteNumber(actual) && isFiniteNumber(filter.value)
        ? actual === filter.value
        : text(actual) === text(filter.value);
      return filter.operator === "equals" ? same : !same;
    }

    case "moreThan":
    case "lessThan": {
      if (!isFiniteNumber(actual) || !isFiniteNumber(filter.value)) return false;
      return filter.operator === "moreThan" ? actual > filter.value : actual < filter.value;
    }

    case "between": {
      // Both bounds required. A half-open "between" is a rule the operator did
      // not finish writing, not a rule that means "everything above 100".
      if (!isFiniteNumber(actual) || !isFiniteNumber(filter.valueFrom) || !isFiniteNumber(filter.valueTo)) return false;
      return actual >= filter.valueFrom && actual <= filter.valueTo;
    }

    case "inTheLast":
    case "notInTheLast": {
      const unit = filter.unit && UNIT_MS[filter.unit] ? filter.unit : undefined;
      if (!unit || !isFiniteNumber(filter.value)) return false;
      // AN ABSENT DATE IS NOT "LONG AGO". Someone who has never ordered
      // satisfies "has not ordered in 60 days" literally, and mailing them a
      // win-back is nonsense — so a missing date fails both directions.
      if (!isFiniteNumber(actual)) return false;
      const within = now - actual <= filter.value * UNIT_MS[unit];
      return filter.operator === "inTheLast" ? within : !within;
    }

    case "before":
    case "after": {
      if (!isFiniteNumber(actual)) return false;
      const boundary = Date.parse(String(filter.value ?? ""));
      if (!Number.isFinite(boundary)) return false;
      return filter.operator === "after" ? actual > boundary : actual < boundary;
    }

    case "contains":
    case "doesNotContain":
    case "startsWith":
    case "endsWith": {
      if (actual === undefined) return false;
      const haystack = text(actual);
      const needle = text(filter.value);
      if (!needle) return false;
      if (filter.operator === "contains") return haystack.includes(needle);
      if (filter.operator === "doesNotContain") return !haystack.includes(needle);
      if (filter.operator === "startsWith") return haystack.startsWith(needle);
      return haystack.endsWith(needle);
    }

    default:
      return false;
  }
}

function evaluateCondition(condition: SegmentCondition, contact: ContactFacts, now: number): boolean {
  const filters = Array.isArray(condition?.filters) ? condition.filters : [];
  if (filters.length === 0) return false;
  return condition.junction === "or"
    ? filters.some((filter) => evaluateFilter(filter, contact, now))
    : filters.every((filter) => evaluateFilter(filter, contact, now));
}

/**
 * Does this contact match the rule?
 *
 * Returns false for every rule shape that is not fully understood, including
 * null and undefined — see the fail-closed note at the top of the file.
 */
export function evaluateSegmentRule(
  rule: SegmentRule | null | undefined,
  contact: ContactFacts,
  now: number,
): boolean {
  const groups = Array.isArray(rule?.groups) ? rule.groups : [];
  if (groups.length === 0) return false;

  return groups.some((group) => {
    const conditions = Array.isArray(group?.conditions) ? group.conditions : [];
    if (conditions.length === 0) return false;
    return conditions.every((condition) => evaluateCondition(condition, contact, now));
  });
}

/**
 * Validate an untrusted rule (admin input, or a stored row) into a typed one.
 *
 * Returns null on ANY defect. The caller must treat null as "refuse", never as
 * "match everyone" — evaluateSegmentRule(null, …) is false for exactly that
 * reason, so the two halves cannot disagree.
 */
export function parseSegmentRule(input: unknown): SegmentRule | null {
  let raw: unknown = input;

  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!raw || typeof raw !== "object") return null;
  const groupsRaw = (raw as { groups?: unknown }).groups;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) return null;

  const groups: SegmentGroup[] = [];

  for (const groupRaw of groupsRaw) {
    if (!groupRaw || typeof groupRaw !== "object") return null;
    const conditionsRaw = (groupRaw as { conditions?: unknown }).conditions;
    if (!Array.isArray(conditionsRaw) || conditionsRaw.length === 0) return null;

    const conditions: SegmentCondition[] = [];

    for (const conditionRaw of conditionsRaw) {
      if (!conditionRaw || typeof conditionRaw !== "object") return null;
      const filtersRaw = (conditionRaw as { filters?: unknown }).filters;
      if (!Array.isArray(filtersRaw) || filtersRaw.length === 0) return null;

      const junctionRaw = (conditionRaw as { junction?: unknown }).junction;
      const junction = junctionRaw === "or" ? "or" : "and";

      const filters: SegmentFilter[] = [];

      for (const filterRaw of filtersRaw) {
        if (!filterRaw || typeof filterRaw !== "object") return null;
        const f = filterRaw as Record<string, unknown>;
        if (typeof f.field !== "string" || !FIELDS.has(f.field)) return null;
        if (typeof f.operator !== "string" || !OPERATORS.has(f.operator)) return null;

        const filter: SegmentFilter = {
          field: f.field as FilterField,
          operator: f.operator as FilterOperator,
        };
        if (typeof f.value === "string" || typeof f.value === "number") filter.value = f.value;
        if (Array.isArray(f.values)) filter.values = f.values.map((v) => String(v));
        if (isFiniteNumber(f.valueFrom)) filter.valueFrom = f.valueFrom;
        if (isFiniteNumber(f.valueTo)) filter.valueTo = f.valueTo;
        if (typeof f.unit === "string" && f.unit in UNIT_MS) filter.unit = f.unit as DateUnit;

        filters.push(filter);
      }

      conditions.push({ junction, filters });
    }

    groups.push({ conditions });
  }

  return { groups };
}

// ---------------------------------------------------------------------------
// WHAT THE COMPOSER MAY OFFER.
//
// The rule builder reads its dropdowns from here rather than carrying a second
// copy of the field and operator lists. A UI offering "is more than" on an
// email address, or an operator this engine does not implement, produces a rule
// that parses cleanly and then silently matches nobody — the hardest kind of
// bug to notice, because the campaign sends and simply reaches no one.
// ---------------------------------------------------------------------------

const NUMBER_OPERATORS: FilterOperator[] = ["equals", "notEquals", "moreThan", "lessThan", "between"];
const DATE_OPERATORS: FilterOperator[] = ["inTheLast", "notInTheLast", "before", "after", "exists", "doesNotExist"];
const TEXT_OPERATORS: FilterOperator[] = ["contains", "doesNotContain", "startsWith", "endsWith", "equals", "notEquals"];
const CHOICE_OPERATORS: FilterOperator[] = ["anyOf", "noneOf", "equals", "notEquals"];

export type FieldKind = "number" | "money" | "date" | "text" | "choice" | "multiChoice";

export type FieldDef = {
  field: FilterField;
  label: string;
  kind: FieldKind;
  operators: FilterOperator[];
  /** Fixed options, where the field has them. Category is loaded from the catalogue instead. */
  choices?: string[];
  hint?: string;
};

export const LIFECYCLE_STAGES: LifecycleStage[] = [
  "champions",
  "loyalists",
  "recentCustomers",
  "highPotential",
  "needNurturing",
  "atRisk",
  "cantLose",
  "prospect",
];

export const FIELD_DEFS: FieldDef[] = [
  { field: "orderCount", label: "Order count", kind: "number", operators: NUMBER_OPERATORS, hint: "Paid orders. Reships and membership charges don't count." },
  { field: "spendCents", label: "Total spend", kind: "money", operators: NUMBER_OPERATORS, hint: "Net of refunds, across paid orders." },
  { field: "lastPaidAt", label: "Last order", kind: "date", operators: DATE_OPERATORS, hint: "Somebody who has never ordered matches neither direction." },
  { field: "firstPaidAt", label: "First order", kind: "date", operators: DATE_OPERATORS, hint: "How long they have been a customer." },
  { field: "category", label: "Category bought", kind: "multiChoice", operators: ["anyOf", "noneOf"], hint: "Any paid order containing a product in the category." },
  { field: "lifecycleStage", label: "Lifecycle stage", kind: "choice", operators: CHOICE_OPERATORS, choices: LIFECYCLE_STAGES, hint: "Computed from how recently, how often and how much they buy." },
  { field: "accountStatus", label: "Contact type", kind: "choice", operators: CHOICE_OPERATORS, choices: ["account", "guest"], hint: "An account holder, or a guest who opted in without one." },
  { field: "email", label: "Email address", kind: "text", operators: TEXT_OPERATORS, hint: "Useful for domains — everyone on a .edu address, say." },
];

// ---------------------------------------------------------------------------
// Rendering a rule back as English. The admin shows this before Send and the
// audit log stores it: a rule nobody can read is a rule nobody can check.
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<FilterField, string> = {
  email: "Email",
  orderCount: "Order count",
  spendCents: "Total spend",
  lastPaidAt: "Last order",
  firstPaidAt: "First order",
  category: "Category bought",
  accountStatus: "Contact type",
  lifecycleStage: "Lifecycle stage",
};

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: "is",
  notEquals: "is not",
  moreThan: "is more than",
  lessThan: "is less than",
  between: "is between",
  inTheLast: "is in the last",
  notInTheLast: "is not in the last",
  before: "is before",
  after: "is after",
  anyOf: "is any of",
  noneOf: "is none of",
  contains: "contains",
  doesNotContain: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  exists: "is set",
  doesNotExist: "is not set",
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function describeFilter(filter: SegmentFilter): string {
  const field = FIELD_LABELS[filter.field] ?? filter.field;
  const operator = OPERATOR_LABELS[filter.operator] ?? filter.operator;
  const isMoney = filter.field === "spendCents";

  if (filter.operator === "exists" || filter.operator === "doesNotExist") {
    return `${field} ${operator}`;
  }
  if (filter.operator === "between") {
    const from = isMoney ? money(Number(filter.valueFrom)) : String(filter.valueFrom);
    const to = isMoney ? money(Number(filter.valueTo)) : String(filter.valueTo);
    return `${field} ${operator} ${from} and ${to}`;
  }
  if (filter.operator === "inTheLast" || filter.operator === "notInTheLast") {
    return `${field} ${operator} ${filter.value} ${filter.unit ?? "days"}`;
  }
  if (filter.operator === "anyOf" || filter.operator === "noneOf") {
    return `${field} ${operator} ${(filter.values ?? []).join(", ")}`;
  }
  const value = isMoney && isFiniteNumber(filter.value) ? money(filter.value) : String(filter.value ?? "");
  return `${field} ${operator} ${value}`;
}

/** A one-line, human-readable rendering of a rule. Safe on null. */
export function describeSegmentRule(rule: SegmentRule | null | undefined): string {
  const groups = Array.isArray(rule?.groups) ? rule.groups : [];
  if (groups.length === 0) return "No valid rule — this segment matches nobody.";

  const rendered = groups.map((group) => {
    const conditions = (group.conditions ?? []).map((condition) => {
      const parts = (condition.filters ?? []).map(describeFilter);
      const joiner = condition.junction === "or" ? " OR " : " AND ";
      return parts.length > 1 ? `(${parts.join(joiner)})` : parts.join(joiner);
    });
    const joined = conditions.join(" AND ");
    // Parenthesise only when there is something to disambiguate. A single group
    // reads as a sentence; several need their boundaries shown.
    return groups.length > 1 ? `(${joined})` : joined;
  });

  return rendered.join(" OR ");
}
