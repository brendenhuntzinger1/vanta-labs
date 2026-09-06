import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_MINIMUM_QUALIFYING_ORDER } from "@/lib/referral-config";
import {
  hasMinimumQualifyingOrder,
  referralQualifies,
  referralShortfall,
  referralStatusLine,
} from "@/lib/referral-qualification";

// ---------------------------------------------------------------------------
// THE QUALIFYING MINIMUM IS GONE.
//
// The programme used to withhold commission — and the customer's discount —
// from any basket under $100. Against the live order book that gate was doing
// almost all of the work: of eleven paid orders, eight sat under it, so an
// ambassador could send real traffic that converted and still earn nothing.
// The owner removed the minimum outright.
//
// "Removed" has to mean removed in BOTH layers or it is not removed at all:
//
//   1. the stored Control Center value, which is what production reads, and
//   2. DEFAULT_MINIMUM_QUALIFYING_ORDER, which is what every fallback path
//      reads — `getAmbassadorProgramSettings` returns it from its own catch,
//      and the cart holds it as the optimistic value before the server answers.
//
// Leaving the constant at 100 would mean a single unreadable control table
// silently reinstated a $100 gate on live baskets, with nothing logged and
// nobody told. That is the exact failure mode `resolveAmbassadorCustomerDiscount`
// and `minimumCents` are each written to avoid, and it is why this file pins
// the constant rather than only the stored value.
// ---------------------------------------------------------------------------

describe("the programme has no qualifying minimum", () => {
  it("defaults to 0 — a failed settings read cannot reinstate a gate", () => {
    expect(DEFAULT_MINIMUM_QUALIFYING_ORDER).toBe(0);
  });

  // The near-misses from the real catalogue, plus the extremes. Every one of
  // these used to earn the ambassador nothing.
  it.each([0.01, 1, 39.99, 89, 99.98, 99.99, 100, 244.97, 10_000])(
    "a $%s referred order qualifies",
    (subtotal) => {
      expect(referralQualifies(subtotal, DEFAULT_MINIMUM_QUALIFYING_ORDER)).toBe(true);
    },
  );

  it("never asks the shopper to add anything to qualify", () => {
    for (const subtotal of [0.01, 39.99, 99.99, 244.97]) {
      expect(referralShortfall(subtotal, DEFAULT_MINIMUM_QUALIFYING_ORDER)).toBe(0);
    }
  });

  // Not a regression guard for its own sake: `minimumCents` resolves a corrupt
  // stored value to "no minimum" precisely so a bad write cannot strip every
  // ambassador's customers. With the minimum removed that path and the normal
  // path now agree, and this pins that they do.
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "treats %s as no minimum rather than an impossible one",
    (stored) => {
      expect(referralQualifies(1, stored as number)).toBe(true);
      expect(referralShortfall(1, stored as number)).toBe(0);
    },
  );

  // A subtotal that is not a number is a bug in the caller, not a request for
  // a discount. Removing the minimum must not turn that into a free discount.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, "89" as unknown as number, null as unknown as number])(
    "still refuses a non-finite subtotal (%s)",
    (subtotal) => {
      expect(referralQualifies(subtotal as number, DEFAULT_MINIMUM_QUALIFYING_ORDER)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// ONE RULE, NOT A FOURTH COPY OF IT.
//
// `minimumCents` already owns the question "is there a minimum at all" — it is
// what decides that 0, a negative, and a corrupt value all mean "no gate". The
// customer-facing copy has to ask the same question, and asking it with its own
// `> 0` check is how the three copies of `subtotal < minimum` that
// referral-qualification.ts exists to have replaced got there in the first
// place.
// ---------------------------------------------------------------------------
describe("hasMinimumQualifyingOrder", () => {
  it.each([0, -1, -0.004, Number.NaN, Number.POSITIVE_INFINITY])("is false for %s", (value) => {
    expect(hasMinimumQualifyingOrder(value as number)).toBe(false);
  });

  it.each([0.01, 1, 100, 250])("is true for %s", (value) => {
    expect(hasMinimumQualifyingOrder(value as number)).toBe(true);
  });

  it("agrees with referralQualifies about what counts as a gate", () => {
    // If there is no minimum, nothing can fail it. If there is one, something
    // must be able to. Stated as a property so the two cannot drift apart.
    for (const minimum of [0, -5, Number.NaN, 0.01, 50, 100]) {
      const gated = hasMinimumQualifyingOrder(minimum);
      expect(referralQualifies(0.001, minimum)).toBe(!gated);
    }
  });
});

// ---------------------------------------------------------------------------
// WHAT THE SHOPPER AND THE APPLICANT ARE TOLD.
// ---------------------------------------------------------------------------
const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

describe("the cart never mentions a minimum that no longer exists", () => {
  it("does not tell the shopper to add more to unlock the code", () => {
    const line = referralStatusLine({
      ambassadorName: "Jaeley Reynolds",
      discountPercent: 15,
      meetsMinimum: referralQualifies(39.99, DEFAULT_MINIMUM_QUALIFYING_ORDER),
      amountToQualify: referralShortfall(39.99, DEFAULT_MINIMUM_QUALIFYING_ORDER),
      minimumOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER,
      formatCurrency: money,
      referralDiscountApplied: true,
    });

    expect(line).not.toMatch(/add \$/i);
    expect(line).not.toMatch(/or more/i);
    expect(line).not.toContain("$0.00");
  });
});

// Same idiom as landing-pages-quote-live-terms.test.ts: vitest runs in a node
// environment and nothing here renders a page, so the WIRING is what can be
// pinned. Comments are stripped because they describe the old policy on purpose.
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the recruitment pages cannot advertise a $0 minimum", () => {
  it.each([
    ["/ambassador", "src/app/ambassador/ambassador-client.tsx"],
    ["/partner", "src/components/partner-program-landing.tsx"],
  ])("%s branches on whether a minimum exists", (_route, path) => {
    const code = codeOnly(read(path));
    expect(code).toContain("hasMinimumQualifyingOrder");
  });

  it("/partner no longer hard-codes an 'or more' promise around the number", () => {
    const code = codeOnly(read("src/components/partner-program-landing.tsx"));
    // The old line read: `...every completed order of $${Math.round(
    // terms.minimumQualifyingOrder)} or more placed with your code.` With the
    // minimum at 0 that renders "$0 or more", which is not a benefit.
    expect(code).not.toContain("Math.round(terms.minimumQualifyingOrder)");
  });

  // The approval email already got this right, and is the precedent the pages
  // are being brought in line with rather than a second rule.
  it("the approval email omits the clause when there is no minimum", () => {
    const code = codeOnly(read("src/lib/email/templates.ts"));
    expect(code).toContain("hasMinimumQualifyingOrder");
  });
});
