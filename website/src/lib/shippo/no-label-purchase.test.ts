import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { labelPurchasingEnabled } from "@/lib/shippo/service";

// ---------------------------------------------------------------------------
// VANTA DOES NOT BUY POSTAGE.
//
// Labels are purchased directly in Shippo and synced back here with their
// tracking number and real carrier cost. That is the standing business rule,
// so the DEFAULT — the environment variable unset — must be refuse.
//
// The risk this closes is not hypothetical. Two live paths reached the one
// function in this application that spends money:
//
//   POST /api/admin/orders/<id>/shipping/label      one order
//   POST /api/admin/fulfillment/labels              a whole batch, from the
//                                                   fulfillment workstation UI
//
// The batch one is the dangerous one: a single click could buy postage for
// every order in the list. Nothing in the code stopped it, because until now
// buying was the intended behaviour.
//
// The gate lives in purchaseLabelForOrder rather than in those two routes.
// Route guards protect the routes that exist today; the money-spending function
// protects the next caller too.
//
// WHY AN ENVIRONMENT VARIABLE AND NOT AN ADMIN TOGGLE. An admin toggle is one
// mis-click from a batch of postage nobody meant to buy, and the entire point
// is that the owner-facing workflow cannot spend by accident. Turning it back
// on should be a deployment decision, not a checkbox.
// ---------------------------------------------------------------------------

const KEY = "SHIPPO_ALLOW_LABEL_PURCHASE";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("the default posture", () => {
  it("refuses to buy postage when nothing is configured", () => {
    expect(labelPurchasingEnabled()).toBe(false);
  });

  it("stays refused for every value that is not exactly true", () => {
    // Note "TRUE " is absent: trimming and case-folding are deliberate, so an
    // operator who sets this on purpose is not defeated by a stray space. That
    // case is asserted positively below.
    for (const value of ["", "false", "0", "no", "off", "yes", "1", "enabled", "true-ish"]) {
      process.env[KEY] = value;
      expect(labelPurchasingEnabled(), `value ${JSON.stringify(value)} must not enable spending`).toBe(false);
    }
  });

  it("opens only on an explicit true", () => {
    process.env[KEY] = "true";
    expect(labelPurchasingEnabled()).toBe(true);
    // Case and surrounding whitespace are tolerated — an operator setting this
    // deliberately should not be defeated by a capital letter.
    process.env[KEY] = "  TRUE  ";
    expect(labelPurchasingEnabled()).toBe(true);
  });
});

describe("what the refusal has to be", () => {
  /**
   * The refusal is what an operator reads when they click something that used
   * to buy a label, so it has to say where the label actually comes from. A
   * bare "forbidden" would send them looking for a broken feature.
   */
  it("names Shippo as the place labels are bought", async () => {
    const { PURCHASING_DISABLED_MESSAGE } = await import("@/lib/shippo/service");
    expect(PURCHASING_DISABLED_MESSAGE.toLowerCase()).toContain("shippo");
    expect(PURCHASING_DISABLED_MESSAGE.toLowerCase()).toContain("sync");
  });

  it("is a policy refusal, not a retryable failure", async () => {
    const { httpStatusForShippoError } = await import(
      "@/app/api/admin/orders/[orderId]/shipping/error-status"
    );
    // 403: correct request, refused on purpose. Not 4xx-fix-your-input, not
    // 5xx-try-again — retrying changes nothing while the rule stands.
    expect(httpStatusForShippoError("purchasing_disabled")).toBe(403);
  });
});
