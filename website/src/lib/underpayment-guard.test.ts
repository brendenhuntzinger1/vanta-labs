import { describe, expect, it } from "vitest";

import { isUnderpaidTotal } from "@/lib/quote-order";

// ---------------------------------------------------------------------------
// THE GUARD THAT DECIDES WHETHER A REAL CUSTOMER MAY BUY SOMETHING.
//
// quoteOrder refuses a request whose claimed total is below the server's, with
// a deliberate one-cent tolerance: the client previews the same pricing maths in
// floating point and can legitimately land a cent away. Overpayment is not
// blocked at all, because the server charges its own authoritative figure.
//
// It was written as three floating-point operations:
//
//   Number(input.expectedTotal) < expectedTotal - 0.01
//
// 0.01 has no exact binary representation, so `expectedTotal - 0.01` is not "a
// cent less than the total" — it is a value a fraction above or below it,
// depending on the cents involved. The client's own figure carries its own
// accumulated error. At some amounts a legitimate one-cent-under total is
// therefore REFUSED, and the shopper is told a discount is no longer available
// and hard-400ed, with no way forward: reloading recomputes the same cent.
//
// The sweep below is the point of this file. It does not assert a hand-picked
// amount; it walks every cent across a wide range and proves the rule is the
// same at all of them — which is the property the float version could not have.
// ---------------------------------------------------------------------------

/** Money as a customer's cart would hold it: a float rounded to cents. */
const dollars = (cents: number) => Math.round(cents) / 100;

describe("the underpayment guard, in integer cents", () => {
  it("accepts a total that matches exactly", () => {
    expect(isUnderpaidTotal(224.58, 224.58)).toBe(false);
  });

  it("accepts the deliberate one-cent tolerance", () => {
    expect(isUnderpaidTotal(224.57, 224.58)).toBe(false);
  });

  it("refuses two cents short", () => {
    expect(isUnderpaidTotal(224.56, 224.58)).toBe(true);
  });

  it("accepts overpayment, which the server never honours anyway", () => {
    expect(isUnderpaidTotal(500, 224.58)).toBe(false);
    expect(isUnderpaidTotal(224.59, 224.58)).toBe(false);
  });

  it("treats an unparseable claim as no claim at all", () => {
    // The caller only applies the guard when a total was sent, but a NaN
    // reaching here must never throw away a legitimate order.
    expect(isUnderpaidTotal(undefined, 224.58)).toBe(false);
    expect(isUnderpaidTotal("not a number", 224.58)).toBe(false);
    expect(isUnderpaidTotal(Number.NaN, 224.58)).toBe(false);
  });

  it("still reads an explicit null as a claim of nothing, exactly as before", () => {
    // Number(null) is 0, not NaN, so `expectedTotal: null` is a claim to owe
    // nothing and is refused. The float version did the same thing — it is
    // asserted here so the behaviour is deliberate and preserved rather than an
    // accident of whichever coercion the rewrite happened to use.
    expect(isUnderpaidTotal(null, 224.58)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // THE SWEEP. Every cent from $0.00 to $1,000.00, three claims each.
  // -------------------------------------------------------------------------
  it("behaves identically at every cent value from $0 to $1,000", () => {
    const wrong: string[] = [];
    for (let cents = 0; cents <= 100_000; cents += 1) {
      const server = dollars(cents);

      if (isUnderpaidTotal(server, server)) wrong.push(`exact ${server}`);
      if (cents >= 1 && isUnderpaidTotal(dollars(cents - 1), server)) wrong.push(`one cent under ${server}`);
      if (cents >= 2 && !isUnderpaidTotal(dollars(cents - 2), server)) wrong.push(`two cents under ${server}`);

      if (wrong.length > 5) break;   // a handful is enough to read in a failure
    }
    expect(wrong).toEqual([]);
  });

  it("is the rule the float comparison FAILED to be", () => {
    // The float version, verbatim, so the difference is demonstrated rather than
    // described. Walk the same range and collect the amounts where a legitimate
    // one-cent-under total would have been refused.
    const floatGuard = (client: number, server: number) => client < server - 0.01;
    const refusedByFloat: number[] = [];
    for (let cents = 1; cents <= 100_000; cents += 1) {
      const server = dollars(cents);
      const oneCentUnder = dollars(cents - 1);
      if (floatGuard(oneCentUnder, server)) refusedByFloat.push(server);
      if (refusedByFloat.length >= 3) break;
    }

    // If this ever comes back empty the premise is wrong and this file should be
    // reconsidered — so it is asserted, not assumed.
    expect(refusedByFloat.length).toBeGreaterThan(0);

    // Every one of those amounts is accepted by the rule that replaced it.
    for (const server of refusedByFloat) {
      const oneCentUnder = dollars(Math.round(server * 100) - 1);
      expect(isUnderpaidTotal(oneCentUnder, server)).toBe(false);
    }
  });

  it("still refuses the underpayment attempt the guard exists for", () => {
    // The original case: a crafted request claiming to owe a penny.
    expect(isUnderpaidTotal(0.01, 224.58)).toBe(true);
    expect(isUnderpaidTotal(0, 224.58)).toBe(true);
  });

  it("holds at the amounts this store actually failed at", () => {
    // $194.98 was the largest payment that had ever succeeded before the 3DS
    // removal; $269.35 was David's. Both sides of the old $200 wall, and the
    // $500+ case nothing on the payment path had ever exercised.
    for (const server of [194.98, 199.99, 200, 200.01, 224.58, 269.35, 500, 1000]) {
      const serverCents = Math.round(server * 100);
      expect(isUnderpaidTotal(server, server)).toBe(false);
      expect(isUnderpaidTotal(dollars(serverCents - 1), server)).toBe(false);
      expect(isUnderpaidTotal(dollars(serverCents - 2), server)).toBe(true);
    }
  });
});
