import { describe, expect, it } from "vitest";

import { decideRequiresAction } from "@/lib/checkout-requires-action";

// ---------------------------------------------------------------------------
// WHAT THE CARD LANE DOES WHEN THE BANK ASKS A QUESTION.
//
// Veyra's checkout client (read from veyragate.com's own bundle, 2026-09-09)
// forwards `payment.requires_action` to the parent as
//
//     { session_id, redirect_url: <hosted 3DS page> | null }
//
// and its own SDK comment says the iframe "drives 3DS internally". In
// practice the iframe navigates ITSELF to redirect_url — inside a 560px frame,
// nested in our page, on iOS Safari. That is the one place a bank challenge is
// least likely to render. The Apple Pay lane already does the right thing with
// the same field: validate https, then send the shopper there at TOP LEVEL
// (express-apple-pay-button.tsx). The card lane discarded the payload entirely.
//
// This helper is the decision, isolated so it can be pinned without a browser:
// a usable https redirect_url means "navigate", anything else means "the
// challenge is happening inside the form — tell the shopper to wait".
// ---------------------------------------------------------------------------

describe("decideRequiresAction", () => {
  it("treats a missing or empty payload as an in-form verification", () => {
    expect(decideRequiresAction(undefined)).toEqual({ kind: "verifying" });
    expect(decideRequiresAction(null)).toEqual({ kind: "verifying" });
    expect(decideRequiresAction({})).toEqual({ kind: "verifying" });
    expect(decideRequiresAction({ session_id: "s", redirect_url: null })).toEqual({ kind: "verifying" });
  });

  it("navigates to a hosted challenge page when the processor provides one", () => {
    expect(decideRequiresAction({ session_id: "s", redirect_url: "https://veyragate.com/3ds/abc?x=1" })).toEqual({
      kind: "navigate",
      url: "https://veyragate.com/3ds/abc?x=1",
    });
  });

  it("refuses anything that is not a well-formed https URL — this value is navigated to", () => {
    for (const bad of ["http://veyragate.com/3ds/abc", "javascript:alert(1)", "not a url", "", 42, ["https://x"]]) {
      expect(decideRequiresAction({ redirect_url: bad })).toEqual({ kind: "verifying" });
    }
  });

  it("accepts the SDK's back-compat flat shape too (fields on the root, no payload wrapper)", () => {
    // checkout.js v1.2.0 handleMessage: `payload = data.payload ?? data`. Our
    // callback receives whichever survived, so both shapes must decide alike.
    expect(decideRequiresAction({ type: "payment.requires_action", redirect_url: "https://veyragate.com/3ds/z" })).toEqual({
      kind: "navigate",
      url: "https://veyragate.com/3ds/z",
    });
  });
});
