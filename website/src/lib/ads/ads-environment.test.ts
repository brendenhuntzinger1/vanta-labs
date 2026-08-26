import { describe, it, expect } from "vitest";

import { adsReportingAllowed, type AdsEnvironment } from "@/lib/ads/ads-environment";

/**
 * K-16. Three live advertising pixel ids ship as hard-coded fallbacks
 * (tiktok-pixel.tsx:24, snap-pixel.tsx:37, ads/reddit-pixel-id.ts:13), and before
 * this module there was NO environment guard anywhere in the analytics path — the
 * only `VERCEL_ENV` checks in the repo gate crawlability, not tracking.
 *
 * So a preview deployment, a local run, a CI job or a Playwright script reported
 * into the real ad accounts, and the server legs sent real Purchase conversions
 * carrying real order values. Phase 20 of the audit plan schedules exactly that
 * (a paid test order on a preview), which is what made this urgent.
 *
 * `adsReportingAllowed` is the single chokepoint. It is DENY-BY-DEFAULT: every
 * caller must present a production environment, and any one disqualifying signal
 * refuses. These tests are the specification.
 */

/** A real production request, as Vercel presents it. Every case below mutates this. */
const PRODUCTION: AdsEnvironment = {
  vercelEnv: "production",
  nodeEnv: "production",
  ci: undefined,
  hostname: "vantalabs.com",
  webdriver: false,
};

describe("adsReportingAllowed — production still works", () => {
  it("allows a genuine production request", () => {
    expect(adsReportingAllowed(PRODUCTION).allowed).toBe(true);
  });

  it("allows production on the www host and on a custom apex", () => {
    expect(adsReportingAllowed({ ...PRODUCTION, hostname: "www.vantalabs.com" }).allowed).toBe(true);
    expect(adsReportingAllowed({ ...PRODUCTION, hostname: "shop.vantalabs.com" }).allowed).toBe(true);
  });

  it("allows production when the hostname is unknown (a server leg has no location)", () => {
    expect(adsReportingAllowed({ ...PRODUCTION, hostname: undefined }).allowed).toBe(true);
  });
});

describe("adsReportingAllowed — every non-production environment is refused", () => {
  it("refuses a Vercel PREVIEW deployment", () => {
    const verdict = adsReportingAllowed({ ...PRODUCTION, vercelEnv: "preview" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("not_production_environment");
  });

  it("refuses a Vercel DEVELOPMENT deployment", () => {
    expect(adsReportingAllowed({ ...PRODUCTION, vercelEnv: "development" }).allowed).toBe(false);
  });

  it("refuses when VERCEL_ENV is absent — self-hosted, local, or a fork", () => {
    const verdict = adsReportingAllowed({ ...PRODUCTION, vercelEnv: undefined });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("not_production_environment");
  });

  it("refuses when NODE_ENV is not production even if VERCEL_ENV claims it is", () => {
    const verdict = adsReportingAllowed({ ...PRODUCTION, nodeEnv: "development" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("not_production_build");
  });

  it("refuses when NODE_ENV is test", () => {
    expect(adsReportingAllowed({ ...PRODUCTION, nodeEnv: "test" }).allowed).toBe(false);
  });
});

describe("adsReportingAllowed — CI never reports", () => {
  // Vitest sets NODE_ENV=test, but a build step or an e2e job can run with
  // NODE_ENV=production. CI must be refused on its own signal, independently.
  it.each(["1", "true", "TRUE"])("refuses when CI=%s", (ci) => {
    const verdict = adsReportingAllowed({ ...PRODUCTION, ci });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("automated_environment");
  });

  it("ignores CI=false and CI=0, which some runners set explicitly", () => {
    expect(adsReportingAllowed({ ...PRODUCTION, ci: "false" }).allowed).toBe(true);
    expect(adsReportingAllowed({ ...PRODUCTION, ci: "0" }).allowed).toBe(true);
  });
});

describe("adsReportingAllowed — non-production hosts", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "[::1]",
    "vanta.local",
    "my-branch-abc123.vercel.app",
  ])("refuses the host %s even if every other signal says production", (hostname) => {
    const verdict = adsReportingAllowed({ ...PRODUCTION, hostname });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("non_production_host");
  });

  it("is case-insensitive and tolerates a port", () => {
    expect(adsReportingAllowed({ ...PRODUCTION, hostname: "LOCALHOST" }).allowed).toBe(false);
    expect(adsReportingAllowed({ ...PRODUCTION, hostname: "localhost:3000" }).allowed).toBe(false);
  });
});

describe("adsReportingAllowed — synthetic browser traffic", () => {
  /**
   * The one rule that must hold even in production. Playwright, Puppeteer and
   * Selenium all set navigator.webdriver. A QA run against the live site is the
   * case the audit plan explicitly contemplates, and it must not pollute the ad
   * account.
   */
  it("refuses automated browser traffic ON PRODUCTION", () => {
    const verdict = adsReportingAllowed({ ...PRODUCTION, webdriver: true });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("automated_browser");
  });

  it("treats an unknown webdriver flag as human (a server leg has no navigator)", () => {
    expect(adsReportingAllowed({ ...PRODUCTION, webdriver: undefined }).allowed).toBe(true);
  });
});

describe("adsReportingAllowed — deny by default", () => {
  it("refuses an entirely empty environment", () => {
    expect(adsReportingAllowed({}).allowed).toBe(false);
  });

  it("reports the FIRST disqualifying reason when several apply, so logs are stable", () => {
    const verdict = adsReportingAllowed({
      vercelEnv: "preview",
      nodeEnv: "development",
      ci: "1",
      hostname: "localhost",
      webdriver: true,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("not_production_environment");
  });

  it("never throws on hostile input", () => {
    expect(() =>
      adsReportingAllowed({ vercelEnv: "" as never, hostname: "" }),
    ).not.toThrow();
    expect(adsReportingAllowed({ vercelEnv: "" as never, hostname: "" }).allowed).toBe(false);
  });
});
