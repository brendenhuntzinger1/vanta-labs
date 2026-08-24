import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REQUIRED_CONFIRMATIONS,
  emptyAcknowledgements,
  type AcknowledgementKey,
} from "./checkout-confirmations";
import { hasAllAcknowledgements } from "./express-wallet";

const ROOT = path.join(__dirname, "..");
const CARD_LANE = path.join(ROOT, "app/checkout/page.tsx");
const EXPRESS_LANE = path.join(ROOT, "components/cart-drawer.tsx");

function read(file: string) {
  return readFileSync(file, "utf8");
}

const ALL_TRUE = Object.fromEntries(
  REQUIRED_CONFIRMATIONS.map((item) => [item.key, true]),
) as Record<AcknowledgementKey, boolean>;

describe("the two checkout lanes ask for exactly what the server requires", () => {
  // The defect this suite exists for: the express lane gained a fourth
  // statement and the server began requiring it, while the card lane still
  // rendered and sent three. Every card order was rejected with a 400.
  it("a payload built from the rendered list satisfies the server validator", () => {
    expect(hasAllAcknowledgements(ALL_TRUE)).toBe(true);
  });

  it("dropping ANY single rendered statement is rejected by the server", () => {
    for (const item of REQUIRED_CONFIRMATIONS) {
      const short = { ...ALL_TRUE };
      delete (short as Record<string, boolean>)[item.key];
      expect(
        hasAllAcknowledgements(short),
        `omitting "${item.key}" must be rejected`,
      ).toBe(false);

      expect(
        hasAllAcknowledgements({ ...ALL_TRUE, [item.key]: false }),
        `unticking "${item.key}" must be rejected`,
      ).toBe(false);
    }
  });

  it("neither lane keeps a private copy of the statement list", () => {
    for (const file of [CARD_LANE, EXPRESS_LANE]) {
      const src = read(file);
      expect(src, `${file} must not redeclare the list`).not.toMatch(
        /const REQUIRED_CONFIRMATIONS\s*[:=]/,
      );
      expect(src, `${file} must import the shared list`).toContain(
        '@/lib/checkout-confirmations"',
      );
    }
  });

  it("both lanes render the shared list rather than a hand-written subset", () => {
    for (const file of [CARD_LANE, EXPRESS_LANE]) {
      expect(read(file)).toContain("REQUIRED_CONFIRMATIONS.map(");
    }
  });
});

describe("affirmative consent", () => {
  it("every statement starts unticked in both lanes", () => {
    const empty = emptyAcknowledgements();
    expect(Object.keys(empty).sort()).toEqual(
      REQUIRED_CONFIRMATIONS.map((i) => i.key).sort(),
    );
    expect(Object.values(empty).every((v) => v === false)).toBe(true);
    expect(hasAllAcknowledgements(empty)).toBe(false);
  });

  it("neither lane seeds a ticked box", () => {
    for (const file of [CARD_LANE, EXPRESS_LANE]) {
      const src = read(file);
      expect(src).toContain("useState<");
      expect(src).toContain("emptyAcknowledgements");
      expect(src, `${file} must not default a statement to true`).not.toMatch(
        /(researchResponsibility|researchCompliance|ageLegalConfirmation|returnsPolicy):\s*true/,
      );
    }
  });

  it("the returns statement links to the returns policy", () => {
    const returns = REQUIRED_CONFIRMATIONS.find((i) => i.key === "returnsPolicy");
    expect(returns?.policyHref).toBe("/legal/refund");
    for (const file of [CARD_LANE, EXPRESS_LANE]) {
      expect(read(file)).toContain("item.policyHref");
    }
  });

  it("the statements stay separate — never merged into one box", () => {
    expect(REQUIRED_CONFIRMATIONS).toHaveLength(4);
    expect(new Set(REQUIRED_CONFIRMATIONS.map((i) => i.key)).size).toBe(4);
  });
});
