import { describe, expect, it } from "vitest";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";

// ---------------------------------------------------------------------------
// TWO NUMBERS, TWO OWNERS.
//
//   customer_discount_percent   what the SHOPPER saves using the code
//   commission_percent          what the AMBASSADOR earns on the sale
//
// They answer to different people and must never be derived from one another.
// Until this column existed the discount came from one global program setting,
// so every code gave the same percentage -- independent in name, because one of
// the two did not exist per ambassador.
//
// The rule that decides real money on every referred order is: override first,
// program default when unset. NULL inherits; it does not mean zero.
// ---------------------------------------------------------------------------

const PROGRAM_DEFAULT = 10;

describe("resolveAmbassadorCustomerDiscount", () => {
  it("uses the ambassador's own rate when one is set", () => {
    expect(resolveAmbassadorCustomerDiscount(15, PROGRAM_DEFAULT)).toBe(15);
  });

  // The distinction the whole column exists for. An owner who clears the field
  // means "follow the program"; reading it as 0% would quietly strip the
  // discount while the code kept working, and nobody would find out until the
  // ambassador asked why their audience stopped converting.
  it("inherits the program default when unset, rather than giving 0%", () => {
    expect(resolveAmbassadorCustomerDiscount(null, PROGRAM_DEFAULT)).toBe(PROGRAM_DEFAULT);
    expect(resolveAmbassadorCustomerDiscount(undefined, PROGRAM_DEFAULT)).toBe(PROGRAM_DEFAULT);
  });

  // A deliberate 0 is legitimate -- a code that tracks attribution without
  // discounting -- and must survive, which is why the check is `== null` and
  // not falsiness.
  it("honours a deliberate 0% override", () => {
    expect(resolveAmbassadorCustomerDiscount(0, PROGRAM_DEFAULT)).toBe(0);
  });

  // Corrupt values inherit rather than clamp. A stored 150 is a mistake, not a
  // request for 99% off, and inheriting is the only answer that cannot zero an
  // order or invert a total.
  it.each([100, 150, -5, Number.NaN, "abc", {}])("falls back on the invalid value %p", (bad) => {
    expect(resolveAmbassadorCustomerDiscount(bad, PROGRAM_DEFAULT)).toBe(PROGRAM_DEFAULT);
  });

  it("accepts a numeric string, since the column arrives as one from postgres", () => {
    expect(resolveAmbassadorCustomerDiscount("12.5", PROGRAM_DEFAULT)).toBe(12.5);
  });

  it("follows a changed program default for everyone still inheriting", () => {
    expect(resolveAmbassadorCustomerDiscount(null, 20)).toBe(20);
    // ...but never for someone carrying an override.
    expect(resolveAmbassadorCustomerDiscount(15, 20)).toBe(15);
  });
});

// The property the owner actually asked for, stated as a test: setting one
// ambassador's numbers cannot move another's, and the two rates on a single
// ambassador cannot move each other.
describe("the two rates are independent", () => {
  const program = 10;

  it("lets one ambassador discount more than another", () => {
    expect(resolveAmbassadorCustomerDiscount(15, program)).toBe(15);
    expect(resolveAmbassadorCustomerDiscount(5, program)).toBe(5);
    expect(resolveAmbassadorCustomerDiscount(null, program)).toBe(program);
  });

  // Connor: customers get 10%, Connor earns 20%. The resolver has no access to
  // the commission rate at all -- which is the structural guarantee, stronger
  // than any assertion about a particular pair of values.
  it("resolves the discount without reference to any commission rate", () => {
    expect(resolveAmbassadorCustomerDiscount.length).toBe(2);
    expect(resolveAmbassadorCustomerDiscount(10, program)).toBe(10);
  });
});
