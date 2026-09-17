import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A FREE REWARD THAT CANNOT SHIP MUST NOT CANCEL A PAID ORDER.
//
// Every line was held in ONE all-or-nothing call, gift included. So a reward
// whose last unit went while the shopper was typing their address took the
// whole order down with it:
//
//   payment-service.ts  reserveInventoryForOrder(... all lines ...)
//                       !ok -> cancel the order, throw CustomerFacingError
//
// The customer was told to "adjust your cart" over a $0 line they never chose
// and cannot remove. Reproduced from the deployed code on 2026-09-17: the
// wheel's Tesamorelin had 5 units against ~6.4 expected winners, and a real
// customer order took one of them mid-session.
//
// WHY THE SPLIT IS CONDITIONAL, and why that condition is the whole safety
// argument rather than a nicety:
//
//   planInventoryAdjustments MERGES adjustments with the same slug+variant. A
//   paid line of 1 and a reward line of 1 for the same product become a single
//   hold for 2. Split into two calls, the second hits reserve_inventory's
//   idempotency check ("an active hold for this order line already exists"),
//   holds NOTHING, and the order ships two units having reserved one. That is
//   an oversell — strictly worse than the bug being fixed.
//
//   `offerAbsorbedUnits === 0` rules that out. Absorption consumes matching
//   paid lines first, so zero absorbed means no paid line shares the reward's
//   product, which means the two calls are disjoint and cannot merge.
//
// The absorbed case therefore keeps the old behaviour on purpose: absorption
// shrank a line the customer is paying for, so dropping the reward would ship
// them less than they ordered at the price they already agreed to.
// ---------------------------------------------------------------------------

const SERVICE = readFileSync("src/lib/payment-service.ts", "utf8");
const QUOTE = readFileSync("src/lib/quote-order.ts", "utf8");
const ROUTE = readFileSync("src/app/api/checkout/create-session/route.ts", "utf8");
const CHECKOUT = readFileSync("src/app/checkout/page.tsx", "utf8");

describe("the quote reports whether the reward took units from the paid lines", () => {
  it("exposes offerAbsorbedUnits, because the till cannot infer it", () => {
    expect(QUOTE).toMatch(/offerAbsorbedUnits:\s*number/);
    // Counted from absorbedFromCart, which the withdrawal branch empties when it
    // restores borrowed units — so a withdrawn reward reports zero.
    expect(QUOTE).toMatch(/offerAbsorbedUnits:\s*absorbedFromCart\.reduce/);
  });
});

describe("the paid lines and the reward are held separately, but only when that is safe", () => {
  it("gates the split on nothing having been absorbed", () => {
    expect(SERVICE).toContain("quote.offerAbsorbedUnits === 0");
    expect(SERVICE).toMatch(/const splitRewardHold =[^\n]*offerAbsorbedUnits === 0/);
  });

  it("holds the paid lines first, all-or-nothing, exactly as before", () => {
    const paidHold = SERVICE.indexOf("const reservation = await reserveInventoryForOrder(");
    const rewardHold = SERVICE.indexOf("const rewardHold = await reserveInventoryForOrder(");
    expect(paidHold).toBeGreaterThan(-1);
    expect(rewardHold).toBeGreaterThan(-1);
    expect(paidHold, "the paid lines must be held before the reward").toBeLessThan(rewardHold);

    // The paid-line failure path is untouched: still cancel, still name the item.
    expect(SERVICE).toContain("throw new CustomerFacingError(describeUnavailable(reservation.unavailable))");
  });

  it("never lets the reward's own hold cancel the order", () => {
    const rewardBlock = SERVICE.slice(
      SERVICE.indexOf("if (rewardItems.length > 0) {"),
      SERVICE.indexOf("// Hold the non-cash tender the same way"),
    );
    expect(rewardBlock.length).toBeGreaterThan(200);
    expect(rewardBlock, "the reward hold must not throw").not.toMatch(/throw /);
    expect(rewardBlock, "the reward hold must not cancel the order").not.toMatch(/payment_status: "canceled"/);
  });
});

describe("the entitlement survives a reward that could not be shipped", () => {
  it("releases the offer rather than spending it", () => {
    const rewardBlock = SERVICE.slice(SERVICE.indexOf("if (rewardItems.length > 0) {"));
    expect(rewardBlock).toContain("releaseCustomerOffer(orderId)");
    // Released BEFORE the line is removed: a failure between the two must leave
    // the customer holding their reward, not neither.
    const release = rewardBlock.indexOf("releaseCustomerOffer(orderId)");
    const remove = rewardBlock.indexOf('.from("order_items")');
    expect(release).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(-1);
    expect(release, "release the entitlement before removing the line").toBeLessThan(remove);
  });

  it("removes the $0 line so the order describes what actually ships", () => {
    const rewardBlock = SERVICE.slice(SERVICE.indexOf("if (rewardItems.length > 0) {"));
    expect(rewardBlock).toMatch(/\.delete\(\)[\s\S]{0,120}\.eq\("order_id", orderId\)/);
  });

  it("tells the caller, so the customer hears it from the store", () => {
    expect(SERVICE).toMatch(/rewardWithheld\?:\s*\{ name: string \} \| null/);
    expect(SERVICE).toContain("rewardWithheld: rewardWithheld ? { name: rewardWithheld.name } : null");
  });
});

// ---------------------------------------------------------------------------
// A FACT NOBODY IS TOLD IS NOT A FIX.
//
// payment-service computed `rewardWithheld` and handed it back on PendingOrder,
// and the trail stopped there: the route's response literal did not carry it,
// so it could not be serialised, so the browser could not render it. The order
// shipped one item lighter for the same money and the first notice of it was
// the parcel.
//
// The place to say it is BEFORE the card form. The order and its holds exist by
// then, but nothing is charged until the processor page — so the shopper can
// still decide, which is the difference between an explanation and an apology.
// ---------------------------------------------------------------------------

describe("the withheld reward reaches the customer", () => {
  it("is serialised by the checkout route", () => {
    expect(ROUTE, "create-session must return rewardWithheld").toMatch(/rewardWithheld/);
  });

  it("keeps `undefined` distinct from `null` across the wire", () => {
    // The duplicate-submit paths resume an order an earlier attempt created and
    // leave the field absent, because they have no standing to answer. `?? null`
    // would turn "not decided here" into "nothing was withheld" — the
    // reassuring one of the two, and the wrong one.
    expect(ROUTE).not.toMatch(/rewardWithheld:\s*result\.rewardWithheld\s*\?\?\s*null/);
    expect(ROUTE).toMatch(/result\.rewardWithheld === undefined \? \{\} : \{ rewardWithheld: result\.rewardWithheld \}/);
  });

  it("stops the shopper in front of the card form rather than after it", () => {
    const guard = CHECKOUT.indexOf("if (result.rewardWithheld");
    const redirect = CHECKOUT.indexOf("window.location.assign(result.hostedCheckoutUrl)");
    expect(guard).toBeGreaterThan(-1);
    expect(redirect).toBeGreaterThan(-1);
    expect(guard, "the notice must come before the redirect to the processor").toBeLessThan(redirect);
  });

  it("does not re-arm the submit button, which would mint a second order", () => {
    // The order and its inventory hold already exist. Re-enabling the button
    // here with a fresh idempotency key is a second order for one purchase —
    // the same failure the redirect path's engaged latch exists to prevent.
    const block = CHECKOUT.slice(
      CHECKOUT.indexOf("if (result.rewardWithheld"),
      CHECKOUT.indexOf("// The submit latch is deliberately LEFT ENGAGED here"),
    );
    expect(block.length).toBeGreaterThan(100);
    expect(block).toContain("idempotencyKeyRef.current = null");
    expect(block, "the latch must stay engaged").not.toMatch(/submitLatchRef\.current = false/);
    expect(block, "the button must not be re-enabled").not.toMatch(/setIsSubmitting\(false\)/);
  });

  it("tells the customer the three things they would otherwise get wrong", () => {
    const panel = CHECKOUT.slice(CHECKOUT.indexOf("if (withheldReward) {"));
    // What went.
    expect(panel).toMatch(/just sold out/);
    // What it costs them — nothing, because the line was $0.
    expect(panel).toMatch(/total has not changed/i);
    // That the prize survives. This is the one a shopper cannot deduce, and the
    // one payment-service went to the trouble of releasing rather than spending.
    expect(panel).toMatch(/You keep the reward/i);
    // And that no money has moved yet.
    expect(panel).toMatch(/Nothing has been charged yet/i);
  });

  it("offers both doors, because continuing is the customer's call", () => {
    const panel = CHECKOUT.slice(CHECKOUT.indexOf("if (withheldReward) {"));
    expect(panel).toContain("withheldReward.payUrl");
    expect(panel).toMatch(/href="\/cart"/);
  });
});
