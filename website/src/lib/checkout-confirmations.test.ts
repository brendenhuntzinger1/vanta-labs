import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  REQUIRED_CONFIRMATIONS,
  defaultAcknowledgements,
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

describe("the default state is a decision, not an accident", () => {
  // These used to assert the OPPOSITE — that every box started unticked. That
  // was a product requirement, not a technical one, and the owner overrode it
  // in writing on 2026-08-24 after being shown the trade. Rewritten rather
  // than deleted, so the rule the code actually follows is the rule the tests
  // actually check.
  it("every statement starts TICKED in both lanes", () => {
    const initial = defaultAcknowledgements();
    expect(Object.keys(initial).sort()).toEqual(
      REQUIRED_CONFIRMATIONS.map((i) => i.key).sort(),
    );
    expect(Object.values(initial).every((v) => v === true)).toBe(true);
    // Pre-ticked is only legitimate if the pre-ticked value is one the server
    // would genuinely accept. If these ever disagree the UI is lying.
    expect(hasAllAcknowledgements(initial)).toBe(true);
  });

  it("both lanes seed from the SAME default — neither hardcodes it", () => {
    for (const file of [CARD_LANE, EXPRESS_LANE]) {
      const src = read(file);
      expect(src).toContain("defaultAcknowledgements");
      // A lane writing its own literal is how the two drift apart again.
      expect(src, `${file} must not hardcode the default`).not.toMatch(
        /(researchCompliance|returnsPolicy):\s*(true|false)/,
      );
    }
  });

  it("the customer can still untick — the default is not a fiction", () => {
    // The control is real precisely because the server refuses the unticked
    // value. If this ever passes, the checkbox is decorative.
    for (const item of REQUIRED_CONFIRMATIONS) {
      expect(
        hasAllAcknowledgements({ ...defaultAcknowledgements(), [item.key]: false }),
        `unticking "${item.key}" must still be refused by the server`,
      ).toBe(false);
    }
  });

  it("neither lane disables or hides the checkbox", () => {
    for (const file of [CARD_LANE, EXPRESS_LANE]) {
      const src = read(file);
      const row = src.slice(src.indexOf("REQUIRED_CONFIRMATIONS.map("));
      const input = row.slice(row.indexOf('type="checkbox"'), row.indexOf('type="checkbox"') + 400);
      expect(input, `${file} must not disable the acknowledgement input`).not.toMatch(/disabled/);
      expect(input, `${file} must not make it read-only`).not.toMatch(/readOnly/);
    }
  });

  it("each statement links the document it incorporates by reference", () => {
    const research = REQUIRED_CONFIRMATIONS.find((i) => i.key === "researchCompliance");
    const returns = REQUIRED_CONFIRMATIONS.find((i) => i.key === "returnsPolicy");
    expect(research?.policyHref).toBe("/legal/research-disclaimer");
    expect(returns?.policyHref).toBe("/legal/refund");
    // The link must NAME the document — "Read the full policy" beside a merged
    // statement does not tell the shopper what they are agreeing to.
    expect(research?.policyLabel).toMatch(/Research & Compliance Terms/);
    expect(returns?.policyLabel).toMatch(/Return & Reimbursement Policy/);
    for (const file of [CARD_LANE, EXPRESS_LANE]) {
      expect(read(file)).toContain("item.policyLabel");
    }
  });

  it("the merged statement keeps the assertions that carry the weight", () => {
    // Three statements became one. These are the ones that must survive that
    // merge for a research-peptide store; the rest are incorporated by the
    // linked Research Disclaimer.
    const body = REQUIRED_CONFIRMATIONS.find((i) => i.key === "researchCompliance")!.body;
    expect(body).toMatch(/21 or older/i);
    expect(body).toMatch(/legally permitted/i);
    expect(body).toMatch(/laboratory research only/i);
    expect(body).toMatch(/not for human or veterinary use/i);
  });

  it("the two statements stay separate from each other", () => {
    expect(REQUIRED_CONFIRMATIONS).toHaveLength(2);
    expect(new Set(REQUIRED_CONFIRMATIONS.map((i) => i.key)).size).toBe(2);
    // Merging the returns statement into the research one would bury a
    // commercial term inside a compliance attestation.
    const research = REQUIRED_CONFIRMATIONS.find((i) => i.key === "researchCompliance")!;
    expect(research.body).not.toMatch(/return|refund|reimbursement/i);
  });
});
