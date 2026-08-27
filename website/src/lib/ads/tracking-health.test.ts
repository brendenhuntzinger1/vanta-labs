import { describe, expect, it } from "vitest";
import {
  buildHealthReport,
  failures,
  nextAction,
  UNTESTED_BROWSER,
  type BrowserHealthInput,
  type ProbeResult,
  type ServerHealthInput,
} from "./tracking-health";
import { countLedger } from "./purchase-ledger";

const PIXEL = "D9SAES3C77U40SOI9D70";

const server = (over: Partial<ServerHealthInput> = {}): ServerHealthInput => ({
  pixelId: PIXEL,
  eventsApiTokenPresent: true,
  clientExposedSecretKeys: [],
  deployment: { env: "production", url: "https://vantalabsresearch.com", commit: "abcdef1234" },
  ads: { advertiserId: false, managementToken: false },
  probe: null,
  purchaseLedger: null,
  ...over,
});

const browser = (over: Partial<BrowserHealthInput> = {}): BrowserHealthInput => ({
  available: true,
  consent: "accepted",
  pixelLoaded: true,
  loadedPixelIds: [PIXEL],
  pageViewObserved: true,
  probes: { viewContent: true, addToCart: true, initiateCheckout: true },
  ...over,
});

const delivered: ProbeResult = { attempted: true, delivered: true, code: 0, message: "OK", requestId: "req-1", transportError: null };
const find = (checks: ReturnType<typeof buildHealthReport>, id: string) => checks.find((c) => c.id === id)!;

describe("evidence tiers", () => {
  it("never marks TikTok rows verified without a response from TikTok", () => {
    const checks = buildHealthReport(server(), browser());
    for (const id of ["tiktok-connection", "tiktok-production-events"]) {
      expect(["PASS", "VERIFIED"]).not.toContain(find(checks, id).status);
    }
  });

  it("a fully green browser and server still leaves production events unverified", () => {
    // This is the exact trap: everything we control is correct, and TikTok has
    // still received nothing. The board must say so rather than reading green.
    const checks = buildHealthReport(server(), browser());
    expect(find(checks, "pixel-init").status).toBe("PASS");
    expect(find(checks, "tiktok-production-events").status).toBe("NOT_VERIFIED");
  });

  it("marks the connection PASS only on TikTok's own success code", () => {
    expect(find(buildHealthReport(server({ probe: delivered }), browser()), "tiktok-connection").status).toBe("PASS");
    const rejected = { ...delivered, delivered: false, code: 40001, message: "param error" };
    expect(find(buildHealthReport(server({ probe: rejected }), browser()), "tiktok-connection").status).toBe("FAIL");
  });

  it("only counts real accepted conversions as production events", () => {
    const withLedger = server({ purchaseLedger: { available: true, total: 3, delivered: 2 }, probe: delivered });
    expect(find(buildHealthReport(withLedger, browser()), "tiktok-production-events").status).toBe("VERIFIED");
    // A test-code event is delivered but routed to Test Events, so it must not
    // flip this row.
    const testOnly = server({ probe: delivered, purchaseLedger: { available: true, total: 0, delivered: 0 } });
    expect(find(buildHealthReport(testOnly, browser()), "tiktok-production-events").status).toBe("NOT_VERIFIED");
  });
});

describe("consent is not a failure", () => {
  it("reports untested, not failed, when the visitor has not accepted cookies", () => {
    const checks = buildHealthReport(server(), browser({ consent: "declined", pixelLoaded: false }));
    for (const id of ["pixel-init", "pageview", "viewcontent", "addtocart", "initiatecheckout"]) {
      expect(find(checks, id).status).toBe("NOT_TESTED");
    }
    expect(failures(checks)).toHaveLength(0);
  });

  it("distinguishes consent given but pixel blocked, which IS a failure", () => {
    const checks = buildHealthReport(server(), browser({ pixelLoaded: false }));
    expect(find(checks, "pixel-init").status).toBe("FAIL");
    expect(find(checks, "pixel-init").detail).toMatch(/blocked/i);
  });

  it("reports untested when no browser has run the checks", () => {
    const checks = buildHealthReport(server(), UNTESTED_BROWSER);
    expect(find(checks, "pageview").status).toBe("NOT_TESTED");
    expect(failures(checks)).toHaveLength(0);
  });
});

describe("one data source", () => {
  it("fails when a second pixel is initialised in the page", () => {
    const checks = buildHealthReport(server(), browser({ loadedPixelIds: [PIXEL, "SOMEOTHERPIXEL"] }));
    expect(find(checks, "pixel-single-source").status).toBe("FAIL");
    expect(find(checks, "pixel-single-source").detail).toContain("SOMEOTHERPIXEL");
  });

  it("passes when the only loaded id is the configured one", () => {
    expect(find(buildHealthReport(server(), browser()), "pixel-single-source").status).toBe("PASS");
  });
});

describe("credentials", () => {
  it("separates a missing token from a rejected one", () => {
    expect(find(buildHealthReport(server({ eventsApiTokenPresent: false }), browser()), "api-auth").status).toBe("FAIL");
    const authError = { ...delivered, delivered: false, code: 40101, message: "Access token is invalid" };
    const row = find(buildHealthReport(server({ probe: authError }), browser()), "api-auth");
    expect(row.status).toBe("FAIL");
    expect(row.action).toMatch(/Regenerate/);
  });

  it("does not blame the credential for a payload error", () => {
    const paramError = { ...delivered, delivered: false, code: 40001, message: "param error: event_time" };
    expect(find(buildHealthReport(server({ probe: paramError }), browser()), "api-auth").status).toBe("PASS");
  });

  it("keeps campaign and reporting access tied to the management credential, not the events one", () => {
    const checks = buildHealthReport(server(), browser());
    expect(find(checks, "campaign-api").status).toBe("NOT_AVAILABLE");
    expect(find(checks, "reporting-api").status).toBe("NOT_AVAILABLE");
    const connected = server({ ads: { advertiserId: true, managementToken: true } });
    expect(find(buildHealthReport(connected, browser()), "campaign-api").status).toBe("AVAILABLE");
  });
});

describe("secrets", () => {
  it("fails loudly when a secret is exposed to the browser", () => {
    const checks = buildHealthReport(server({ clientExposedSecretKeys: ["NEXT_PUBLIC_TIKTOK_ACCESS_TOKEN"] }), browser());
    expect(find(checks, "secrets").status).toBe("FAIL");
    expect(find(checks, "secrets").action).toMatch(/Rotate/);
  });
});

describe("purchase", () => {
  it("never claims a browser Purchase was tested, because it cannot be synthesised", () => {
    const checks = buildHealthReport(server({ purchaseLedger: { available: true, total: 5, delivered: 5 } }), browser());
    expect(find(checks, "purchase-browser").status).toBe("NOT_TESTED");
  });

  it("fails the server Purchase row when attempts happened and none were accepted", () => {
    const checks = buildHealthReport(server({ purchaseLedger: { available: true, total: 4, delivered: 0 } }), browser());
    expect(find(checks, "purchase-server").status).toBe("FAIL");
  });
});

describe("next action", () => {
  it("returns exactly one thing to do, preferring failures over unverified rows", () => {
    const checks = buildHealthReport(server({ eventsApiTokenPresent: false }), browser());
    expect(nextAction(checks)).toMatch(/Vercel/);
  });

  it("falls back to the unverified production row when nothing is broken", () => {
    expect(nextAction(buildHealthReport(server(), browser()))).toMatch(/accept the cookie banner/i);
  });

  it("is silent when everything green is genuinely green", () => {
    const allGood = server({
      probe: delivered,
      purchaseLedger: { available: true, total: 2, delivered: 2 },
      ads: { advertiserId: true, managementToken: true },
    });
    expect(nextAction(buildHealthReport(allGood, browser()))).toBeNull();
  });
});

describe("the health board must not count another platform's rows or the migration's suppression rows", () => {
  // ads-purchase-ledger-per-platform.sql widens the ledger key to
  // (order_id, platform) and backfills `backfill-no-send` rows so orders that
  // predate the change cannot newly report on a channel the old single-column
  // key had silenced. Those rows were never sent. The reader that feeds the
  // TikTok health card selected every row regardless of platform, so after the
  // migration this card would have counted Reddit's genuine sends and the
  // suppression rows as TikTok's own.
  const mixed = [
    { order_id: "VL-1001", platform: "tiktok", delivered: true, event_id: "purchase-VL-1001" },
    { order_id: "VL-1001", platform: "reddit", delivered: true, event_id: "VL-1001" },
    { order_id: "VL-1001", platform: "reddit", delivered: false, event_id: "backfill-no-send" },
    { order_id: "VL-1001", platform: "google", delivered: false, event_id: "backfill-no-send" },
  ];

  it("counts exactly one accepted of one total for TikTok, not four", () => {
    expect(countLedger(mixed, "tiktok")).toEqual({ available: true, total: 1, delivered: 1 });
  });

  it("renders the TikTok card as 'accepted 1 of 1' and passes", () => {
    const check = find(
      buildHealthReport(server({ purchaseLedger: countLedger(mixed, "tiktok") }), browser()),
      "purchase-server",
    );
    expect(check.status).toBe("PASS");
    expect(check.detail).toContain("accepted 1 of 1");
    expect(check.detail).not.toContain("of 4");
  });

  it("scores Reddit's genuine send to Reddit and ignores its suppression row", () => {
    expect(countLedger(mixed, "reddit")).toEqual({ available: true, total: 1, delivered: 1 });
  });

  it("counts a channel that has only suppression rows as nothing at all", () => {
    expect(countLedger(mixed, "google")).toEqual({ available: true, total: 0, delivered: 0 });
  });

  it("REGRESSION: suppression rows must not flip an untested channel to FAIL", () => {
    // The sharpest consequence of the defect. An account with no delivered
    // TikTok row but a backfilled ledger makes `ledger.total > 0` true, and
    // that alone turns NOT_TESTED into FAIL — a green integration reporting as
    // broken.
    const onlyBackfill = [
      { order_id: "VL-1001", platform: "reddit", delivered: false, event_id: "backfill-no-send" },
      { order_id: "VL-1001", platform: "google", delivered: false, event_id: "backfill-no-send" },
    ];
    const counted = countLedger(onlyBackfill, "tiktok");
    expect(counted).toEqual({ available: true, total: 0, delivered: 0 });
    const check = find(buildHealthReport(server({ purchaseLedger: counted }), browser()), "purchase-server");
    expect(check.status).toBe("NOT_TESTED");
    expect(check.status).not.toBe("FAIL");
  });

  it("still reports a genuine TikTok rejection as FAIL", () => {
    // The guard must not become a way to hide real failures.
    const rejected = [{ order_id: "VL-1001", platform: "tiktok", delivered: false, event_id: "purchase-VL-1001" }];
    const check = find(
      buildHealthReport(server({ purchaseLedger: countLedger(rejected, "tiktok") }), browser()),
      "purchase-server",
    );
    expect(check.status).toBe("FAIL");
  });

  it("treats a legacy row with no platform as TikTok's, matching the column default", () => {
    const legacy = [{ order_id: "VL-1000", platform: null, delivered: true, event_id: "purchase-VL-1000" }];
    expect(countLedger(legacy, "tiktok")).toEqual({ available: true, total: 1, delivered: 1 });
    expect(countLedger(legacy, "reddit")).toEqual({ available: true, total: 0, delivered: 0 });
  });
});
