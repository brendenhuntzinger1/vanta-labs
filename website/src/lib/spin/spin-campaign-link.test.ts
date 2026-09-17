import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// TURNING AN ORDINARY CAMPAIGN INTO A WHEEL.
//
// The operator sets the campaign's CTA path to /spin and changes nothing else.
// This is the piece that makes that work, and its failure modes are all
// "somebody gets a link they should not have" or "a click dies".
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ enabled: true, campaignId: "winback_2026q4", throws: false }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin-control", () => ({
  getSpinWheelConfig: async () => {
    if (state.throws) throw new Error("control store unavailable");
    return { enabled: state.enabled, campaignId: state.campaignId };
  },
}));

const { attachSpinLink, SPIN_CTA_PATH } = await import("@/lib/spin/spin-campaign-link");
const { verifySpinToken } = await import("@/lib/spin/spin-token");

const EMAIL = "lapsed@example.test";
const SPIN_URL = "https://vantalabsresearch.com/spin";

beforeEach(() => {
  process.env.UNSUBSCRIBE_SECRET ??= "test-secret-for-spin-tokens";
  state.enabled = true;
  state.campaignId = "winback_2026q4";
  state.throws = false;
});

describe("a campaign pointed at the wheel", () => {
  it("personalises the destination for that recipient", async () => {
    const result = await attachSpinLink(SPIN_URL, EMAIL);
    const token = new URL(result).searchParams.get("t");

    expect(token).toBeTruthy();
    expect(await verifySpinToken(token!)).toEqual({ email: EMAIL, campaignId: "winback_2026q4" });
  });

  it("signs the SPIN campaign, not the email campaign", async () => {
    // Two different ideas that are easy to conflate. The email campaign id
    // identifies the send; the spin campaign id scopes one-spin-per-customer.
    // Two separate emails in one spin campaign must share a single spin.
    state.campaignId = "winback_2027q1";
    const token = new URL(await attachSpinLink(SPIN_URL, EMAIL)).searchParams.get("t");
    expect((await verifySpinToken(token!))?.campaignId).toBe("winback_2027q1");
  });

  it("lowercases the address so one person is one spinner", async () => {
    const token = new URL(await attachSpinLink(SPIN_URL, "Lapsed@Example.TEST")).searchParams.get("t");
    expect((await verifySpinToken(token!))?.email).toBe(EMAIL);
  });

  it("keeps whatever the campaign already put on the URL", async () => {
    // utmForCampaign has already tagged the destination by the time this runs.
    const tagged = `${SPIN_URL}?utm_source=email&utm_campaign=winback`;
    const url = new URL(await attachSpinLink(tagged, EMAIL));
    expect(url.searchParams.get("utm_source")).toBe("email");
    expect(url.searchParams.get("t")).toBeTruthy();
  });
});

describe("everything it must leave alone", () => {
  it("does not touch another destination", async () => {
    for (const other of [
      "https://vantalabsresearch.com/products",
      "https://vantalabsresearch.com/",
      "https://vantalabsresearch.com/coa-library",
      // Near-misses: only the exact path is the wheel.
      "https://vantalabsresearch.com/spinner",
      "https://vantalabsresearch.com/spin/extra",
    ]) {
      expect(await attachSpinLink(other, EMAIL), other).toBe(other);
    }
  });

  it("does not mint while the wheel is switched off", async () => {
    state.enabled = false;
    expect(await attachSpinLink(SPIN_URL, EMAIL)).toBe(SPIN_URL);
  });

  it("does not mint without an address", async () => {
    expect(await attachSpinLink(SPIN_URL, "")).toBe(SPIN_URL);
  });
});

describe("when something goes wrong", () => {
  it("still lands the customer on the page if the control store is down", async () => {
    // A click is worth more than a personalised link. They reach /spin and are
    // told the link is not valid, which is recoverable; a failed redirect is
    // not.
    state.throws = true;
    expect(await attachSpinLink(SPIN_URL, EMAIL)).toBe(SPIN_URL);
  });

  it("passes through a destination that is not a URL at all", async () => {
    expect(await attachSpinLink("not-a-url", EMAIL)).toBe("not-a-url");
  });
});

describe("the CTA path an operator types", () => {
  it("is exactly /spin", () => {
    expect(SPIN_CTA_PATH).toBe("/spin");
  });
});
