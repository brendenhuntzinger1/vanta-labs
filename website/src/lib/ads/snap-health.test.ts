import { describe, expect, it } from "vitest";
import { buildSnapHealthReport, snapDetectorExplanation, UNTESTED_SNAP, type SnapHealthInput } from "./snap-health";

const healthy: SnapHealthInput = {
  available: true,
  consent: "accepted",
  configuredPixelId: "b6e3f2b8-0d0a-4d4e-b547-24b5a20d2a6e",
  loaderScripts: 1,
  stubPresent: true,
  sdkLoaded: true,
  queuedCalls: 0,
  pageViews: 2,
  probes: { viewContent: true, addToCart: true, checkout: true },
};

const row = (input: SnapHealthInput, id: string) => buildSnapHealthReport(input).find((check) => check.id === id)!;

describe("a working pixel", () => {
  it("is all green", () => {
    for (const check of buildSnapHealthReport(healthy)) {
      expect(["PASS", "VERIFIED"], `${check.id} is ${check.status}`).toContain(check.status);
    }
  });

  it("credits the SDK row to Snap, not to reading the code", () => {
    // The distinction the whole board exists for: source can prove the snippet
    // is correct and prove nothing about whether it ran.
    const sdk = row(healthy, "snap-sdk");
    expect(sdk.tier).toBe("SNAP");
    expect(sdk.status).toBe("VERIFIED");
    expect(row(healthy, "snap-funnel").tier).toBe("CODE");
  });
});

describe("the difference between gated and broken", () => {
  // Snapchat's detector reports both of these identically. Conflating them
  // leads to the one repair that must not happen: removing the consent gate.
  const gated: SnapHealthInput = {
    ...healthy,
    consent: "unset",
    loaderScripts: 0,
    stubPresent: false,
    sdkLoaded: false,
    pageViews: 0,
  };
  const blocked: SnapHealthInput = { ...healthy, sdkLoaded: false, queuedCalls: 2, pageViews: 0 };

  it("does not call a consent-gated pixel broken", () => {
    expect(row(gated, "snap-loader").status).not.toBe("FAIL");
    expect(row(gated, "snap-sdk").status).toBe("NOT_TESTED");
    expect(row(gated, "snap-loader").detail).toMatch(/consent has not been granted/i);
  });

  it("does call a blocked pixel broken, and says what is blocking it", () => {
    const sdk = row(blocked, "snap-sdk");
    expect(sdk.status).toBe("FAIL");
    expect(sdk.detail).toMatch(/2 call\(s\) are stuck/);
    expect(sdk.action).toMatch(/ad blocker|extension|network/i);
  });

  it("distinguishes a declined browser from an undecided one", () => {
    expect(row({ ...gated, consent: "declined" }, "snap-consent").detail).toMatch(/gate working/i);
    expect(row(gated, "snap-consent").detail).toMatch(/No choice stored/i);
  });

  it("flags a missing loader only once consent makes one expected", () => {
    expect(row({ ...gated, consent: "accepted" }, "snap-loader").status).toBe("FAIL");
    expect(row({ ...gated, consent: "accepted" }, "snap-loader").action).toMatch(/deploy/i);
  });
});

describe("a second pixel installed from outside the codebase", () => {
  const doubled: SnapHealthInput = { ...healthy, loaderScripts: 2 };

  it("fails loudly, because every conversion is being double counted", () => {
    const loader = row(doubled, "snap-loader");
    expect(loader.status).toBe("FAIL");
    expect(loader.detail).toMatch(/counted more than once/i);
    expect(loader.action).toMatch(/tag manager|site head/i);
  });
});

describe("page views", () => {
  it("fails when the SDK runs but nothing is counted", () => {
    expect(row({ ...healthy, pageViews: 0 }, "snap-pageview").status).toBe("FAIL");
  });

  it("stays untested when there is nothing to count yet", () => {
    expect(row({ ...healthy, sdkLoaded: false, pageViews: 0 }, "snap-pageview").status).toBe("NOT_TESTED");
  });
});

describe("the funnel row", () => {
  it("reports how many builders are complete", () => {
    const partial = row({ ...healthy, probes: { viewContent: true, addToCart: false, checkout: true } }, "snap-funnel");
    expect(partial.status).toBe("FAIL");
    expect(partial.detail).toMatch(/2 of 3/);
  });
});

describe("before anything has been measured", () => {
  it("claims nothing at all", () => {
    const checks = buildSnapHealthReport(UNTESTED_SNAP);
    expect(checks).toHaveLength(5);
    for (const check of checks) expect(check.status).toBe("NOT_TESTED");
  });

  it("never reports a green row from an unmeasured board", () => {
    // The failure this vocabulary exists to prevent: a board that looks healthy
    // because nothing ran.
    expect(buildSnapHealthReport(UNTESTED_SNAP).some((c) => ["PASS", "VERIFIED"].includes(c.status))).toBe(false);
  });
});

describe("explaining Snapchat's detector", () => {
  it("says the amber warning is the gate working, not a broken install", () => {
    expect(snapDetectorExplanation(healthy)).toMatch(/expected/i);
    expect(snapDetectorExplanation(healthy)).toMatch(/never accepts the cookie banner/i);
    expect(snapDetectorExplanation({ ...healthy, sdkLoaded: false })).toMatch(/consent gate working/i);
  });

  it("does not explain anything it has not measured", () => {
    expect(snapDetectorExplanation(UNTESTED_SNAP)).toMatch(/Open this board/i);
  });
});
