import { describe, expect, it } from "vitest";
import { referralAppliedMessage, referralCartStatus, referralQualifies, referralShortfall, referralStatusLine } from "@/lib/referral-qualification";

// ONE RULE, TWO SIDES.
//
// The cart preview and quote-order.ts must answer "does this basket qualify for
// the ambassador's discount?" identically, for the same reason
// resolveAmbassadorCustomerDiscount exists: when the two sides each carry their
// own copy of a money rule, they drift, and the drift is invisible until a real
// customer is quoted one price and charged another.
//
// The defect this module was extracted for: the cart announced
// "Ambassador X - 15% customer discount" on a $39.99 basket, applied no
// discount, still sent the code, and checkout returned HTTP 400.

describe("referralQualifies", () => {
  it("qualifies a basket above the minimum", () => {
    expect(referralQualifies(110.37, 100)).toBe(true);
  });

  it("does not qualify a basket below the minimum", () => {
    expect(referralQualifies(39.99, 100)).toBe(false);
  });

  it("qualifies a basket exactly ON the minimum", () => {
    // The published rule is "orders must be at least $100", so $100.00 earns.
    expect(referralQualifies(100, 100)).toBe(true);
  });

  it("does not qualify one cent under the minimum", () => {
    expect(referralQualifies(99.99, 100)).toBe(false);
  });

  it("compares in cents, so a sub-cent float artefact cannot rob a qualifying cart", () => {
    // A subtotal is built by summing per-line totals that have themselves been
    // through per-unit floor rounding. A value a hair under the minimum is, to
    // the cent, exactly ON it -- and a naive `subtotal >= minimum` would refuse
    // it. Rounding both sides to cents first is what makes the boundary stable.
    const hair = 99.999999999;
    expect(hair < 100).toBe(true);
    expect(Math.round(hair * 100)).toBe(10000);
    expect(referralQualifies(hair, 100)).toBe(true);
  });

  it("qualifies everything when the programme has no minimum", () => {
    expect(referralQualifies(1, 0)).toBe(true);
  });

  // A corrupt minimum must never silently strip every ambassador's discount.
  // That is the same failure mode resolveAmbassadorCustomerDiscount guards:
  // the code keeps working, nobody sees an error, and the ambassador's
  // audience simply stops converting.
  it.each([
    ["NaN", Number.NaN],
    ["negative", -50],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("treats a %s minimum as no minimum rather than blocking every referral", (_label, minimum) => {
    expect(referralQualifies(39.99, minimum as number)).toBe(true);
  });

  // A corrupt subtotal is a bug in the caller, not a request for a discount.
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses to qualify a %s subtotal", (_label, subtotal) => {
    expect(referralQualifies(subtotal as number, 100)).toBe(false);
  });

  // The no-minimum shortcut must not smuggle a corrupt subtotal past the
  // finiteness check. The docstring says a non-finite subtotal does not
  // qualify; that has to hold whatever the minimum is.
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("refuses a %s subtotal even when there is no minimum", (_label, subtotal) => {
    expect(referralQualifies(subtotal as number, 0)).toBe(false);
    expect(referralQualifies(subtotal as number, Number.NaN)).toBe(false);
  });
});

describe("referralShortfall", () => {
  it("reports how much more the customer needs to spend", () => {
    expect(referralShortfall(39.99, 100)).toBe(60.01);
  });

  it("is zero once the basket qualifies", () => {
    expect(referralShortfall(110.37, 100)).toBe(0);
  });

  it("is zero exactly on the minimum", () => {
    expect(referralShortfall(100, 100)).toBe(0);
  });

  it("rounds to whole cents so the cart never asks for $60.010000000000005", () => {
    expect(referralShortfall(39.99, 100)).toBe(60.01);
    expect(referralShortfall(0.1 + 0.2, 100)).toBe(99.7);
  });

  it("is zero when the programme has no usable minimum", () => {
    expect(referralShortfall(5, Number.NaN)).toBe(0);
    expect(referralShortfall(5, -10)).toBe(0);
  });
});

// The same sentence is rendered on the cart page, the cart drawer and the
// checkout panel. Three hand-written copies of a promise about money is how the
// three drift, so the sentence is built once and tested once.
describe("referralStatusLine", () => {
  const money = (n: number) => `$${n.toFixed(2)}`;

  it("states the discount plainly when the basket qualifies", () => {
    expect(referralStatusLine({
      ambassadorName: "Xavier Martinez",
      discountPercent: 15,
      meetsMinimum: true,
      amountToQualify: 0,
      minimumOrder: 100,
      formatCurrency: money,
      referralDiscountApplied: true,
    })).toBe("Xavier Martinez · 15% customer discount");
  });

  it("says what is missing, and how much, when the basket does not qualify", () => {
    // The defect: this used to read "15% customer discount" on a $39.99 basket
    // that was about to be charged full price and then refused at the pay button.
    expect(referralStatusLine({
      ambassadorName: "Xavier Martinez",
      discountPercent: 15,
      meetsMinimum: false,
      amountToQualify: 60.01,
      minimumOrder: 100,
      formatCurrency: money,
    })).toBe("Xavier Martinez · 15% off orders of $100.00 or more — add $60.01 to unlock it");
  });

  it("never promises a discount in the non-qualifying sentence", () => {
    const line = referralStatusLine({
      ambassadorName: "Eloa wolf",
      discountPercent: 10,
      meetsMinimum: false,
      amountToQualify: 5,
      minimumOrder: 100,
      formatCurrency: money,
    });
    expect(line).toContain("to unlock it");
    expect(line).not.toMatch(/customer discount/);
  });
});

// The confirmation shown after the shopper types a code and presses Apply.
//
// Before the fix, applyReferralCode REFUSED a code below the minimum: it cleared
// the code entirely and showed a blocking error. That disagreed with the link
// path (which kept the code) and, after the server stopped throwing, with the
// server too — which would have accepted it. So Apply now accepts the code and
// this is what it says.
describe("referralAppliedMessage", () => {
  const money = (n: number) => `$${n.toFixed(2)}`;

  it("confirms the discount when the basket already qualifies", () => {
    expect(referralAppliedMessage({
      discountPercent: 15, meetsMinimum: true, amountToQualify: 0, minimumOrder: 100, formatCurrency: money,
    })).toBe("Referral code applied — 15% off.");
  });

  it("confirms the code is saved, and says what unlocks it, when it does not", () => {
    expect(referralAppliedMessage({
      discountPercent: 15, meetsMinimum: false, amountToQualify: 60.01, minimumOrder: 100, formatCurrency: money,
    })).toBe("Referral code saved — 15% off unlocks at $100.00. Add $60.01 to qualify.");
  });

  it("does not claim a discount is off when it is not", () => {
    const msg = referralAppliedMessage({
      discountPercent: 10, meetsMinimum: false, amountToQualify: 1, minimumOrder: 100, formatCurrency: money,
    });
    expect(msg).not.toBe("Referral code applied — 10% off.");
    expect(msg).toContain("unlocks at");
  });
});

// A commission-only ambassador — customer_discount_percent = 0, which
// resolveAmbassadorCustomerDiscount accepts verbatim — gives the customer
// nothing at any basket size. Talking about a minimum in that case is a false
// claim ("0% off orders over $100.00 — add $0.00 to unlock it" on a $500 order),
// and it was reachable through referralMeetsMinimum folding code VALIDITY in
// with basket SIZE.
describe("referralStatusLine with a code that gives the customer nothing", () => {
  const money = (n: number) => `$${n.toFixed(2)}`;

  it.each([true, false])("never mentions a minimum at 0%% (meetsMinimum=%s)", (meetsMinimum) => {
    const line = referralStatusLine({
      ambassadorName: "Sara Chen",
      discountPercent: 0,
      meetsMinimum,
      amountToQualify: meetsMinimum ? 0 : 60,
      minimumOrder: 100,
      formatCurrency: money,
    });
    expect(line).toBe("Sara Chen · referral code applied");
    expect(line).not.toContain("%");
    expect(line).not.toContain("orders of");
  });

  it("still describes a real rate normally", () => {
    expect(referralStatusLine({
      ambassadorName: "Sara Chen", discountPercent: 15, meetsMinimum: true,
      amountToQualify: 0, minimumOrder: 100, formatCurrency: money,
      referralDiscountApplied: true,
    })).toBe("Sara Chen · 15% customer discount");
  });
});

// Everything else that can stop a referral from giving anything.
describe("referralStatusLine — the other reasons a code gives nothing", () => {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const base = { ambassadorName: "Jane Doe", discountPercent: 15, minimumOrder: 100, formatCurrency: money };

  // Another discount winning short-circuits the referral entirely, so
  // "add $60.01 to unlock it" is advice that cannot unlock anything, and
  // "15% customer discount" is simply false.
  it.each([
    ["qualifying", true, 0],
    ["below the minimum", false, 60.01],
  ])("says only that the code is applied when another discount has taken over and is unnamed (%s)", (_l, meetsMinimum, amountToQualify) => {
    expect(referralStatusLine({
      ...base, meetsMinimum, amountToQualify,
      referralDiscountApplied: false, competingDiscountApplied: true,
    })).toBe("Jane Doe · referral code applied");
  });

  // A CODE WITH NOTHING BESIDE IT READS AS A CODE THAT FAILED.
  //
  // That reading is what used to cost the ambassador the sale: a shopper whose
  // promotion or promo code was worth more saw "Jane Doe · referral code
  // applied" against a total the code had not moved, concluded it was broken,
  // and removed it — taking the attribution with it. The sentence now says why,
  // in the same shape describeCouponOutcome uses for the coupon side.
  it.each([
    ["a promo code", "Promo code SAVE20"],
    ["a promotion", "Buy 2 Get 1 Free"],
    ["catalogue bundle pricing", "Bundle pricing"],
    ["membership", "Membership discount"],
  ])("names %s as the offer that beat the code", (_l, winner) => {
    expect(referralStatusLine({
      ...base, meetsMinimum: true, amountToQualify: 0,
      referralDiscountApplied: false, competingDiscountApplied: true,
      competingDiscountLabel: winner,
    })).toBe(`Jane Doe · referral code applied · your ${winner} saves you more, so we kept that`);
  });

  it("never names a winner when the referral is the discount being given", () => {
    expect(referralStatusLine({
      ...base, meetsMinimum: true, amountToQualify: 0,
      referralDiscountApplied: true, competingDiscountApplied: false,
      competingDiscountLabel: "Promo code SAVE20",
    })).toBe("Jane Doe · 15% customer discount");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["whitespace", "   "],
  ])("falls back to the plain sentence for a %s winner label", (_l, winner) => {
    expect(referralStatusLine({
      ...base, meetsMinimum: true, amountToQualify: 0,
      referralDiscountApplied: false, competingDiscountApplied: true,
      competingDiscountLabel: winner,
    })).toBe("Jane Doe · referral code applied");
  });

  // THE CLAIM FOLLOWS THE MONEY, NOT THE BASKET SIZE.
  //
  // Qualifying on size is not the same as being given the discount. Two units
  // of a $100 item carry $10 of quantity-bundle pricing, and a 5% ambassador's
  // $10 competes to exactly $0 against it — the basket clears the minimum and
  // the code is worth nothing. The first version of this sentence read
  // "5% customer discount" while the totals underneath credited "Bundle
  // pricing", which is the defect the whole module was extracted to stop.
  it("never claims a discount that is not being given, however big the basket", () => {
    expect(referralStatusLine({
      ...base, meetsMinimum: true, amountToQualify: 0,
      referralDiscountApplied: false, competingDiscountApplied: false,
    })).toBe("Jane Doe · referral code applied");
  });

  it("claims the discount when the referral is the one actually applied", () => {
    expect(referralStatusLine({
      ...base, meetsMinimum: true, amountToQualify: 0,
      referralDiscountApplied: true, competingDiscountApplied: false,
    })).toBe("Jane Doe · 15% customer discount");
  });

  // referral-client.ts returns ambassador_name straight from the RPC. Before
  // this sentence was built in a template literal, a null name rendered as
  // nothing; now it would render the literal text "null".
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ])("never prints a %s ambassador name", (_l, name) => {
    const line = referralStatusLine({ ...base, ambassadorName: name as unknown as string, meetsMinimum: true, amountToQualify: 0, referralDiscountApplied: true });
    expect(line).toBe("Your ambassador · 15% customer discount");
    expect(line).not.toMatch(/null|undefined/);
  });
});

// ---------------------------------------------------------------------------
// THE WHOLE STATUS, DERIVED ONCE — AND FOLLOWING THE MONEY.
//
// referralStatusLine takes the answers; something has to work them out. That
// something lived in cart-context.tsx, and the three surfaces that show the
// sentence — cart page, drawer, checkout panel — each hand-copied six fields
// into the call. That is the identical shape of the drift discount-resolution.ts
// was extracted to end: a decision inside a React component that nothing can
// import is a decision nothing can test, and three hand-written copies of it
// are three chances to pass the wrong flag.
//
// The first version of this function asked the wrong question. It took the
// Buy-3-Get-1 amount and treated only that as "the referral is suppressed",
// because Buy-3-Get-1 was the case in front of me. But the referral competes
// against EVERY other candidate in resolveCustomerDiscount, and it loses to
// several of them:
//
//   • a commission-only ambassador (customer_discount_percent = 0)
//   • Buy-3-Get-1 (profit-engine: `!isBundle && hasReferral`)
//   • quantity-bundle pricing, via compete() — DEFAULT catalogue pricing, not
//     an opt-in promo: two units of a $100 item bake in $10 of savings, and a
//     5% ambassador's $10 competes to exactly $0
//   • membership, bulk savings or an ambassador personal discount winning
//
// In every one of those the basket clears the minimum, the code is worth $0.00,
// and the old sentence announced "N% customer discount" while the totals below
// it credited "Bundle pricing" or "Membership discount".
//
// So the input is no longer a bundle amount. It is the outcome: did the
// referral actually win, and is some other discount applied instead. Both are
// already computed — resolveCartDiscount on the client, resolveCustomerDiscount
// on the server — so nothing is re-derived here.
// ---------------------------------------------------------------------------
describe("referralCartStatus", () => {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const base = {
    ambassadorName: "Xavier Martinez",
    discountPercent: 15,
    minimumQualifyingOrder: 100,
    referralDiscountApplied: true,
    competingDiscountApplied: false,
    formatCurrency: money,
  };

  it("passes the winner's name through to the sentence", () => {
    const s = referralCartStatus({
      ...base, subtotal: 200,
      referralDiscountApplied: false,
      competingDiscountApplied: true,
      competingDiscountLabel: "Promo code SAVE20",
    });
    expect(s.line).toBe("Xavier Martinez · referral code applied · your Promo code SAVE20 saves you more, so we kept that");
    expect(s.referralDiscountApplied).toBe(false);
    // Amber is a call to action, and there is none: no basket size changes this.
    expect(s.needsMoreToQualify).toBe(false);
  });

  it("reports a qualifying basket as qualifying, with nothing left to add", () => {
    const s = referralCartStatus({ ...base, subtotal: 110.37 });
    expect(s.meetsMinimum).toBe(true);
    expect(s.amountToQualify).toBe(0);
    expect(s.needsMoreToQualify).toBe(false);
    expect(s.line).toBe("Xavier Martinez · 15% customer discount");
  });

  it("reports the exact shortfall on a basket that is short", () => {
    const s = referralCartStatus({ ...base, subtotal: 39.99, referralDiscountApplied: false });
    expect(s.meetsMinimum).toBe(false);
    expect(s.amountToQualify).toBeCloseTo(60.01, 10);
    expect(s.needsMoreToQualify).toBe(true);
    expect(s.line).toBe("Xavier Martinez · 15% off orders of $100.00 or more — add $60.01 to unlock it");
  });

  // The reason this function exists at all.
  it.each([
    ["a short basket", 39.99],
    ["a qualifying basket", 240],
  ])("never asks the shopper to add money while another discount has taken over (%s)", (_label, subtotal) => {
    const s = referralCartStatus({ ...base, subtotal, referralDiscountApplied: false, competingDiscountApplied: true });
    expect(s.needsMoreToQualify).toBe(false);
    expect(s.line).toBe("Xavier Martinez · referral code applied");
    expect(s.line).not.toContain("unlock");
    expect(s.line).not.toContain("customer discount");
  });

  // THE CASE THE FIRST VERSION MISSED. Nothing is "applied" here at all: the
  // quantity-bundle saving is already inside the subtotal, so it is not a
  // discount line — it just competes the referral down to zero. The basket
  // qualifies, no other discount shows, and the referral still gives nothing.
  it("claims nothing when the referral qualifies on size but wins nothing", () => {
    const s = referralCartStatus({ ...base, subtotal: 190, referralDiscountApplied: false, competingDiscountApplied: false });
    expect(s.meetsMinimum).toBe(true);
    expect(s.referralDiscountApplied).toBe(false);
    expect(s.needsMoreToQualify).toBe(false);
    expect(s.line).toBe("Xavier Martinez · referral code applied");
  });

  // needsMoreToQualify drives the amber styling. Amber on a sentence with no
  // call to action is noise, and a commission-only code has no call to action
  // at any size.
  it("does not flag a commission-only code as needing a bigger basket", () => {
    const s = referralCartStatus({ ...base, discountPercent: 0, subtotal: 39.99, referralDiscountApplied: false });
    expect(s.needsMoreToQualify).toBe(false);
    expect(s.line).toBe("Xavier Martinez · referral code applied");
  });

  it("owns the whole sentence, so no caller needs to prefix a word to it", () => {
    // cart-client.tsx rendered `Ambassador {referralStatusLine(...)}`, which
    // with a null ambassador_name would now read "Ambassador Your ambassador".
    const s = referralCartStatus({ ...base, ambassadorName: null as unknown as string, subtotal: 240 });
    expect(s.line).toBe("Your ambassador · 15% customer discount");
  });

  it("treats a programme with no minimum as always qualifying", () => {
    const s = referralCartStatus({ ...base, minimumQualifyingOrder: 0, subtotal: 1 });
    expect(s.meetsMinimum).toBe(true);
    expect(s.amountToQualify).toBe(0);
    expect(s.line).toBe("Xavier Martinez · 15% customer discount");
  });
});
