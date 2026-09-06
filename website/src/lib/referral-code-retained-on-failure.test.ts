import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// A FAILED CODE SUBMISSION MUST NOT TAKE AWAY THE DISCOUNT ALREADY APPLIED.
//
// Reproduced in the browser on the local harness, at /checkout, with a real
// cart:
//
//   1. LOCKED22 applied.       Order summary: -$9.66, total $140.53.
//   2. One wrong code typed into the REFERRAL field and applied.
//   3. Order summary: no discount line at all, total $150.48.
//
// The shopper paid $9.95 more than a moment earlier, and nothing on screen said
// the first code had been removed. applyReferralCode cleared referralCode and
// referralDetails in every failure branch, so an applied code was lost by:
//
//   * pressing Apply on an empty box,
//   * mistyping a second code, or
//   * a single validation request failing — a network blip silently costing a
//     shopper a discount they had already earned, mid-checkout.
//
// Two branches SHOULD still clear: a paused referral programme and an active
// Buy 3 Get 1 Free both mean the applied code genuinely cannot be honoured any
// more. The distinction is the whole point, so this file asserts both halves —
// a fix that simply stopped clearing everywhere would be wrong too.
//
// Source-scanned rather than rendered: the logic lives in a React context whose
// state these branches set directly, and the defect IS which setters each
// branch calls.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(new URL("../components/cart-context.tsx", import.meta.url), "utf8");

/** The file with comments removed, so prose can never satisfy or break a scan. */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The body of applyReferralCode, up to the next top-level declaration. */
function applyReferralCodeBody() {
  const code = withoutComments(SOURCE);
  const start = code.indexOf("const applyReferralCode = async");
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf("const clearReferralCode =", start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

/**
 * The single `{ ... }` block containing `marker`, found by brace matching so a
 * neighbouring branch's setters can never be read as this branch's.
 */
function branchReporting(marker: string) {
  const body = applyReferralCodeBody();
  const at = body.indexOf(marker);
  expect(at, `no branch mentions ${JSON.stringify(marker)}`).toBeGreaterThan(-1);

  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i--) {
    if (body[i] === "}") depth++;
    else if (body[i] === "{") {
      if (depth === 0) { open = i; break; }
      depth--;
    }
  }
  expect(open, `no enclosing block for ${marker}`).toBeGreaterThan(-1);

  depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) return body.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block for ${marker}`);
}

const CLEARS_THE_APPLIED_CODE = [
  "setReferralCode(null)",
  "setReferralDetails(null)",
];

describe("a failed referral submission keeps the code that is already applied", () => {
  it.each([
    ["an empty box", "Enter a referral code."],
    ["a code that is not a live referral code", "That referral code is not active."],
    ["a validation request that failed outright", "Unable to check the referral code right now."],
  ])("does not clear the applied code for %s", (_label, message) => {
    const branch = branchReporting(message);
    for (const setter of CLEARS_THE_APPLIED_CODE) {
      expect(branch, `${message} branch still calls ${setter}`).not.toContain(setter);
    }
    // Nor the success line, which is what keeps "Referral code applied — 12%
    // off." on screen next to the error about the code that did not work.
    expect(branch).not.toContain("setReferralSuccess(null)");
  });
});

describe("the one branch that genuinely invalidates the applied code still clears it", () => {
  it.each([
    ["the referral programme is paused", "REFERRAL_PROGRAM_PAUSED_MESSAGE"],
  ])("clears when %s", (_label, marker) => {
    const branch = branchReporting(marker);
    for (const setter of CLEARS_THE_APPLIED_CODE) {
      expect(branch, `${marker} branch no longer calls ${setter}`).toContain(setter);
    }
  });

  // THERE USED TO BE TWO. The second cleared the applied code whenever a Buy X
  // Get Y promotion was running — "Referral codes cannot be combined with the
  // <name> promotion." — and it was never a genuine invalidation: the server
  // has never refused that combination, so the cart was turning away a code the
  // checkout would have accepted. The cost landed on the ambassador, who was
  // attributed nothing for any order placed during a promotion.
  //
  // A promotion and a referral now compete; the larger saving prices the order
  // and the code stays attached for attribution whichever way it goes.
  it("no longer refuses a referral code because a promotion is running", () => {
    expect(applyReferralCodeBody()).not.toContain("Referral codes cannot be combined with the");
  });
});

describe("the rejection message points at the other kind of code", () => {
  it("tells the shopper where promo codes go", () => {
    // The offers bar advertises promo codes ON the cart page, directly above a
    // field labelled "Referral Code" — and the cart has no coupon box at all,
    // only checkout does. Pasting the advertised code there returned "That
    // referral code is not active" about a perfectly live discount.
    expect(applyReferralCodeBody()).toContain(
      "That referral code is not active. Promo codes are applied at checkout.",
    );
  });
});
