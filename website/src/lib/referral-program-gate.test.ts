import { describe, expect, it } from "vitest";

import {
  REFERRAL_PROGRAM_PAUSED_MESSAGE,
  referralProgramAllowsCodes,
  referralProgramIsOff,
} from "@/lib/referral-program-gate";

// ---------------------------------------------------------------------------
// THE MASTER SWITCH THE CLIENT COULD NOT SEE.
//
// quote-order.ts refuses any order still carrying a referral code when the
// Control Center referral switch is off:
//
//   if (referralCodeEntered && !referralProgram.enabled) throw ...
//
// The client had no way to know. /api/catalog/promotions sent
// referralDiscountPercent and referralMinimumOrder and never `enabled`, and the
// validation RPC returns nothing programme-level. So an ambassador link already
// in the wild kept working, the cart kept previewing "15% customer discount",
// and the shopper was stopped at the pay button — proven end to end against a
// production build: HTTP 400, "The referral program is currently unavailable.
// Remove the code to continue.", no order written.
//
// THE TRI-STATE IS THE WHOLE POINT. "Off" and "not known yet" are different
// answers and must not collapse into each other:
//
//   true   the programme is on — behave exactly as before
//   false  definitively off — attach nothing, apply nothing, promise nothing
//   null   not resolved yet — the config request has not landed
//
// Which way `null` leans is a money decision. Leaning it toward OFF would strip
// a legitimate discount from every referred shopper during any hiccup, silently
// and in the store's favour. Leaning it toward ON preserves exactly today's
// behaviour for the milliseconds before the config lands, and the server throw
// stays underneath as the backstop. The route's own catch already answers
// `true`, matching getReferralProgramConfig's fallback, so a failed read is a
// definite answer and not this state at all.
// ---------------------------------------------------------------------------

describe("referralProgramAllowsCodes", () => {
  it("allows codes when the programme is on", () => {
    expect(referralProgramAllowsCodes(true)).toBe(true);
  });

  it("refuses codes when the programme is definitively off", () => {
    expect(referralProgramAllowsCodes(false)).toBe(false);
  });

  // The unresolved window is the first render, before the config request lands.
  // Failing closed here would take a real discount off a real basket on the
  // strength of a request that had not answered yet.
  it("allows codes while the answer is still unknown", () => {
    expect(referralProgramAllowsCodes(null)).toBe(true);
  });

  it("treats an absent answer the same as an unknown one", () => {
    expect(referralProgramAllowsCodes(undefined)).toBe(true);
  });
});

describe("referralProgramIsOff", () => {
  // The inverse is NOT `!allowsCodes` at the call sites that clear state: only
  // a definite "off" may throw away a shopper's attached code. Unknown must
  // never trigger a clear.
  it("is true only for a definite off", () => {
    expect(referralProgramIsOff(false)).toBe(true);
  });

  it.each([
    ["on", true],
    ["unknown", null],
    ["absent", undefined],
  ])("is false when the programme is %s", (_label, state) => {
    expect(referralProgramIsOff(state)).toBe(false);
  });

  it("never disagrees with referralProgramAllowsCodes", () => {
    for (const state of [true, false, null, undefined] as const) {
      expect(referralProgramIsOff(state)).toBe(!referralProgramAllowsCodes(state));
    }
  });
});

describe("the message a shopper gets when they type a code into a paused programme", () => {
  it("says the programme is paused, not that the code is invalid", () => {
    // The code is fine and the ambassador is real. Telling her the code is
    // wrong sends her back to the ambassador to ask for a working one.
    expect(REFERRAL_PROGRAM_PAUSED_MESSAGE).toMatch(/paused|unavailable/i);
    expect(REFERRAL_PROGRAM_PAUSED_MESSAGE).not.toMatch(/invalid|not found|incorrect/i);
  });

  it("does not promise a discount it cannot give", () => {
    expect(REFERRAL_PROGRAM_PAUSED_MESSAGE).not.toMatch(/\d+%/);
  });

  it("is short enough to render on one line at 390px", () => {
    expect(REFERRAL_PROGRAM_PAUSED_MESSAGE.length).toBeLessThanOrEqual(120);
  });
});
