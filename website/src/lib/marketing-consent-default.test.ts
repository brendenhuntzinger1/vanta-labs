import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE MARKETING OPT-IN DEFAULT IS A JURISDICTION DECISION, NOT A STYLE CHOICE.
//
// src/app/checkout/page.tsx derives the marketing checkbox from the shipping
// destination, and from nothing else until the shopper touches the box:
//
//   const marketingOptIn = marketingTouched ? marketingChoice : isUnitedStates(form.country);
//
// Ticked for the United States, unticked for Canada. That split is law rather
// than preference. CAN-SPAM is an opt-OUT regime, so a pre-ticked box is lawful
// for a US destination. CASL requires EXPRESS consent, and a box the shopper
// never touched is not express consent — mailing a Canadian address on the
// strength of one is the violation, and it is assessed per message.
//
// One token changing — `isUnitedStates(form.country)` becoming `true` — puts
// every Canadian shopper back on the list, and nothing else in the suite
// notices: the box still renders, the order still places, checkout stays green.
// That silence is the whole reason this file exists.
//
// HOW IT IS ASSERTED. `isUnitedStates` and the ternary are module-private to a
// "use client" page, so there is nothing to import; and vitest runs with
// environment "node" with no jsdom, so rendering 1400 lines of checkout for one
// attribute is not available either — the same trade checkout-no-bypass.test.ts
// already declined for this very file.
//
// So the real expression is LIFTED OUT OF THE PAGE AND EXECUTED, the technique
// harness-embed-parity.test.ts uses on the shim's select parser. That runs the
// shipped code instead of pattern-matching its spelling: both country helpers
// are supplied, so a behaviour-identical rewrite (the `!isCanada(...)` form this
// line once had) still passes, while one that drops the jurisdiction check
// cannot.
// ---------------------------------------------------------------------------

const CHECKOUT = "src/app/checkout/page.tsx";
const source = readFileSync(join(process.cwd(), CHECKOUT), "utf8");

/**
 * Lift a top-level `function name(country: string) { ... }` out of the page and
 * make it callable. The only TypeScript inside these two helpers is the
 * parameter annotation, stripped so `new Function` will accept the declaration.
 */
function liftCountryHelper(name: string): (country: string) => boolean {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is no longer declared in ${CHECKOUT}`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`could not find the end of ${name} in ${CHECKOUT}`);
  const declaration = source.slice(start, end + 2).replace(/:\s*string/g, "");
  return new Function(`${declaration}\nreturn ${name};`)() as (country: string) => boolean;
}

const isUnitedStates = liftCountryHelper("isUnitedStates");
const isCanada = liftCountryHelper("isCanada");

const ASSIGNMENT = "const marketingOptIn =";

/** The right-hand side of the real assignment, verbatim from the page. */
function liftDefaultExpression(): string {
  const start = source.indexOf(ASSIGNMENT);
  if (start < 0) throw new Error(`\`${ASSIGNMENT}\` is gone from ${CHECKOUT}`);
  const end = source.indexOf(";", start);
  if (end < 0) throw new Error(`the marketingOptIn assignment is unterminated in ${CHECKOUT}`);
  return source.slice(start + ASSIGNMENT.length, end).trim();
}

type Resolver = (
  marketingTouched: boolean,
  marketingChoice: boolean,
  form: { country: string },
  isUS: (country: string) => boolean,
  isCA: (country: string) => boolean,
) => boolean;

function compile(expression: string): Resolver {
  return new Function(
    "marketingTouched",
    "marketingChoice",
    "form",
    "isUnitedStates",
    "isCanada",
    `return (${expression});`,
  ) as Resolver;
}

const resolve = compile(liftDefaultExpression());

/** What the box does before the shopper has touched it — the legal question. */
const defaultFor = (country: string) => resolve(false, true, { country }, isUnitedStates, isCanada);
/** Once touched, the shopper's own choice must win everywhere. */
const afterChoosing = (choice: boolean, country: string) =>
  resolve(true, choice, { country }, isUnitedStates, isCanada);

const US = "United States";
const CANADA = "Canada";

describe("marketing consent default", () => {
  it("leaves the box UNTICKED for Canada (CASL needs express consent)", () => {
    expect(defaultFor(CANADA)).toBe(false);
  });

  it("pre-ticks the box for the United States (CAN-SPAM is opt-out)", () => {
    expect(defaultFor(US)).toBe(true);
  });

  it("actually distinguishes the two — the default is not a constant", () => {
    expect(defaultFor(US)).not.toBe(defaultFor(CANADA));
  });

  it("is an allowlist: every non-US destination defaults to unticked", () => {
    for (const country of [CANADA, "Mexico", "United Kingdom", "Germany", "", "   "]) {
      expect(defaultFor(country), `${JSON.stringify(country)} must default off`).toBe(false);
    }
  });

  it("honours the shopper's own choice once they touch the box", () => {
    expect(afterChoosing(false, US)).toBe(false);
    expect(afterChoosing(true, CANADA)).toBe(true);
  });

  it("recognises the country spellings the form can produce", () => {
    for (const spelling of ["United States", "USA", "us", "U.S.", "u.s.a.", "  united states  "]) {
      expect(isUnitedStates(spelling), spelling).toBe(true);
    }
    for (const spelling of ["Canada", "CA", "can", " canada "]) {
      expect(isUnitedStates(spelling), spelling).toBe(false);
      expect(isCanada(spelling), spelling).toBe(true);
    }
  });
});

describe("marketing consent default — the mutations this file exists to catch", () => {
  const regressions: Array<[string, string]> = [
    ["defaults everyone in", "marketingTouched ? marketingChoice : true"],
    ["seeds the default from the choice", "marketingTouched ? marketingChoice : marketingChoice"],
    ["inverts the jurisdiction test", "marketingTouched ? marketingChoice : !isUnitedStates(form.country)"],
  ];

  for (const [name, expression] of regressions) {
    it(`rejects a rewrite that ${name}`, () => {
      const mutant = compile(expression);
      const untouched = (country: string) => mutant(false, true, { country }, isUnitedStates, isCanada);
      const stillCompliant =
        untouched(CANADA) === false && untouched(US) === true && untouched(US) !== untouched(CANADA);
      expect(stillCompliant, `"${name}" would slip through`).toBe(false);
    });
  }

  it("accepts a behaviour-identical rewrite, so this tests result and not spelling", () => {
    const rewritten = compile("marketingTouched ? marketingChoice : !isCanada(form.country)");
    expect(rewritten(false, true, { country: CANADA }, isUnitedStates, isCanada)).toBe(false);
    expect(rewritten(false, true, { country: US }, isUnitedStates, isCanada)).toBe(true);
  });
});

describe("marketing consent default — the wiring that makes it reach the shopper", () => {
  it("starts untouched, so the jurisdiction default is what renders first", () => {
    expect(source).toContain("const [marketingTouched, setMarketingTouched] = useState(false);");
  });

  it("drives the checkbox from the derived value, not from defaultChecked", () => {
    const index = source.indexOf("Email me exclusive offers");
    expect(index, "the marketing checkbox label has moved or been reworded").toBeGreaterThan(-1);
    const label = source.slice(source.lastIndexOf("<label", index), index);
    expect(label).toContain('type="checkbox"');
    expect(label).toContain("checked={marketingOptIn}");
    expect(label).not.toContain("defaultChecked");
  });

  it("submits the derived value, so the default is what the order records", () => {
    expect(source).toMatch(/^\s*marketingOptIn,$/m);
  });
});
