import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A KILL SWITCH THAT ALSO CONFISCATES.
//
// `spin_wheel.enabled` is the one control that stops the promotion. It gated
// four things, and one of them was wrong: /api/spin/claim, which is how a
// customer who span on their phone reaches the SAME prize on their laptop.
//
// So pausing the wheel an hour after someone won took their prize away from
// every device but the one holding the cookie — while the row sat in
// customer_offers, live, for the full 72 hours it was promised for. From the
// customer's side that is indistinguishable from being robbed.
//
// ISSUING AND RETRIEVING ARE DIFFERENT ACTS. The switch exists to stop the
// first. claimSpinForAccount cannot do the first: it reads an existing row for
// a verified address and rotates its bearer token, returning null when there
// is none. The draw — /api/spin — and the page keep their gate, and this file
// is what stops the two drifting back together.
// ---------------------------------------------------------------------------

const CLAIM = readFileSync("src/app/api/spin/claim/route.ts", "utf8");
const DRAW = readFileSync("src/app/api/spin/route.ts", "utf8");
const PAGE = readFileSync("src/app/spin/page.tsx", "utf8");
const SERVICE = readFileSync("src/lib/spin/spin-claim.ts", "utf8");

describe("pausing the wheel stops new prizes", () => {
  it("still gates the draw", () => {
    expect(DRAW).toMatch(/if \(!config\.enabled\)/);
  });

  it("still gates the page", () => {
    expect(PAGE).toMatch(/if \(!config\.enabled\)/);
  });
});

describe("pausing the wheel does not strand a prize already won", () => {
  it("does not gate retrieval", () => {
    expect(
      CLAIM,
      "claim must not refuse on `enabled`: that is the switch confiscating, not pausing",
    ).not.toMatch(/if \(!config\.enabled\)/);
  });

  it("still reads the config, because campaignId is what scopes the claim", () => {
    // Dropping the read entirely would let a claim resolve against any spin the
    // address has ever had, including last quarter's promotion.
    expect(CLAIM).toContain("getSpinWheelConfig()");
    expect(CLAIM).toContain("campaignId: config.campaignId");
  });

  it("retrieval cannot mint, which is why ungating it is safe", () => {
    // The whole safety argument in one assertion: spin-claim.ts selects and
    // updates. If an insert ever appears here, the switch has a hole and this
    // test is the thing that says so.
    expect(SERVICE, "claim must never insert a new offer row").not.toMatch(/\.insert\(/);
    expect(SERVICE).toMatch(/\.update\(/);
  });

  it("still refuses an unverified caller", () => {
    // Identity comes from the session. Ungating `enabled` must not also have
    // loosened who may claim.
    expect(CLAIM).toContain("getAuthenticatedUser()");
    expect(CLAIM).toMatch(/if \(!verifiedEmail\)/);
  });
});
