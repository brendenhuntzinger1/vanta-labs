import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * K-16 ENFORCEMENT. `ads-environment.test.ts` proves the DECISION is right.
 * This file proves the decision is actually WIRED — that no advertising request
 * leaves a non-production deployment.
 *
 * The bar is deliberately behavioural rather than "the env var is read": every
 * assertion below drives the real exported function with a stubbed `fetch` and
 * asserts on whether a network call was attempted. A test that only inspected
 * `process.env` would have passed against the broken code, which is the whole
 * reason this finding survived to be found.
 */

const ORIGINAL = {
  vercelEnv: process.env.VERCEL_ENV,
  nodeEnv: process.env.NODE_ENV,
  ci: process.env.CI,
  tiktok: process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN,
  reddit: process.env.REDDIT_CONVERSIONS_ACCESS_TOKEN,
};

/** A deployment that is production in every respect, with both API tokens set. */
function makeProduction() {
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("CI", "");
  vi.stubEnv("TIKTOK_EVENTS_API_ACCESS_TOKEN", "tok-tiktok");
  vi.stubEnv("REDDIT_CONVERSIONS_ACCESS_TOKEN", "tok-reddit");
}

let fetchСalledWith: unknown[][] = [];

function stubFetch(status = 200, body: unknown = { code: 0, message: "OK", request_id: "req-1" }) {
  const spy = vi.fn(async (...args: unknown[]) => {
    fetchСalledWith.push(args);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  fetchСalledWith = [];
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries({
    VERCEL_ENV: ORIGINAL.vercelEnv, NODE_ENV: ORIGINAL.nodeEnv, CI: ORIGINAL.ci,
    TIKTOK_EVENTS_API_ACCESS_TOKEN: ORIGINAL.tiktok, REDDIT_CONVERSIONS_ACCESS_TOKEN: ORIGINAL.reddit,
  })) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
});

// ---------------------------------------------------------------------------
// TikTok Events API — the server leg that reports Purchase with a real order value
// ---------------------------------------------------------------------------

describe("sendServerEvents (TikTok) refuses to leave a non-production deployment", () => {
  // The same shape src/lib/ads/tiktok-events-api.test.ts uses, so a positive
  // control that reaches the network reaches it for the right reason.
  const event = {
    event: "Purchase",
    eventId: "purchase-ord-123",
    occurredAt: new Date("2026-08-26T12:00:00.000Z"),
    user: { email: "jo@example.com", ip: "203.0.113.9", userAgent: "Mozilla/5.0" },
    properties: {
      contents: [{ content_id: "bpc-157", content_type: "product", content_name: "BPC-157", quantity: 2, price: 42.99 }],
      currency: "USD",
      value: 85.98,
      order_id: "ord-123",
    },
  };

  it("sends on a real production deployment", async () => {
    makeProduction();
    const spy = stubFetch();
    const { sendServerEvents } = await import("@/lib/ads/tiktok-events-api");

    const outcome = await sendServerEvents([event as never]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(fetchСalledWith[0][0])).toContain("business-api.tiktok.com");
    expect(outcome.transportError).toBeNull();
  });

  it.each([
    ["a Vercel PREVIEW deployment", () => vi.stubEnv("VERCEL_ENV", "preview")],
    ["a Vercel DEVELOPMENT deployment", () => vi.stubEnv("VERCEL_ENV", "development")],
    ["an unset VERCEL_ENV (localhost / self-hosted / a fork)", () => vi.stubEnv("VERCEL_ENV", "")],
    ["a non-production build", () => vi.stubEnv("NODE_ENV", "test")],
    ["CI", () => vi.stubEnv("CI", "1")],
  ])("sends NOTHING from %s", async (_label, degrade) => {
    makeProduction();
    degrade();
    const spy = stubFetch();
    const { sendServerEvents } = await import("@/lib/ads/tiktok-events-api");

    const outcome = await sendServerEvents([event as never]);

    // The assertion that matters: no request was attempted at all.
    expect(spy).not.toHaveBeenCalled();
    expect(outcome.delivered).toBe(false);
    expect(outcome.transportError).toMatch(/^ads reporting disabled: /);
  });

  it("reports the ENVIRONMENT refusal, not a missing token, when both apply", async () => {
    // Ordering is diagnosable behaviour, not cosmetics. On a preview with no
    // token, "TIKTOK_EVENTS_API_ACCESS_TOKEN is not set" sends an operator off to
    // add a token — which would then be the one thing standing between that
    // preview and the live ad account. The environment answer has to win.
    //
    // The token is deliberately UNSET here: with it set, both orderings produce
    // the same string and the assertion proves nothing. (Found by mutation M9,
    // which moved the gate after the token check and passed.)
    makeProduction();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("TIKTOK_EVENTS_API_ACCESS_TOKEN", "");
    const spy = stubFetch();
    const { sendServerEvents } = await import("@/lib/ads/tiktok-events-api");

    const outcome = await sendServerEvents([event as never]);

    expect(spy).not.toHaveBeenCalled();
    expect(outcome.transportError).toBe("ads reporting disabled: not_production_environment");
  });

  it("still sends no request when the environment is fine but the token is missing", async () => {
    // The positive control for the test above: with the environment healthy the
    // token check must still fire, so the reordering is not being bought by
    // weakening the token gate.
    makeProduction();
    vi.stubEnv("TIKTOK_EVENTS_API_ACCESS_TOKEN", "");
    const spy = stubFetch();
    const { sendServerEvents } = await import("@/lib/ads/tiktok-events-api");

    const outcome = await sendServerEvents([event as never]);

    expect(spy).not.toHaveBeenCalled();
    expect(outcome.transportError).toBe("TIKTOK_EVENTS_API_ACCESS_TOKEN is not set");
  });
});

// ---------------------------------------------------------------------------
// Reddit Conversions API
// ---------------------------------------------------------------------------

describe("sendRedditConversion refuses to leave a non-production deployment", () => {
  // sendRedditConversion reads event.properties.currency (reddit-conversions.ts:107),
  // so the event carries the same shape as the TikTok ServerEvent.
  const input = {
    event: {
      event: "Purchase",
      eventId: "purchase-ord-123",
      occurredAt: new Date("2026-08-26T12:00:00.000Z"),
      user: { email: "jo@example.com" },
      properties: { currency: "USD", value: 85.98, order_id: "ord-123", contents: [] },
    },
    user: { email: "jo@example.com", ip: "203.0.113.9", userAgent: "Mozilla/5.0" },
    occurredAt: new Date(),
  };

  it("sends on a real production deployment", async () => {
    makeProduction();
    const spy = stubFetch(200, { });
    const { sendRedditConversion } = await import("@/lib/ads/reddit-conversions");

    await sendRedditConversion(input as never);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(fetchСalledWith[0][0])).toContain("reddit.com");
  });

  it.each([
    ["a Vercel PREVIEW deployment", () => vi.stubEnv("VERCEL_ENV", "preview")],
    ["an unset VERCEL_ENV", () => vi.stubEnv("VERCEL_ENV", "")],
    ["a non-production build", () => vi.stubEnv("NODE_ENV", "development")],
    ["CI", () => vi.stubEnv("CI", "true")],
  ])("sends NOTHING from %s", async (_label, degrade) => {
    makeProduction();
    degrade();
    const spy = stubFetch();
    const { sendRedditConversion } = await import("@/lib/ads/reddit-conversions");

    const outcome = await sendRedditConversion(input as never);

    expect(spy).not.toHaveBeenCalled();
    expect(outcome.delivered).toBe(false);
    expect(outcome.transportError).toMatch(/^ads reporting disabled: /);
  });
});

// ---------------------------------------------------------------------------
// The browser pixels
// ---------------------------------------------------------------------------

describe("browserAdsReportingAllowed under real browser conditions", () => {
  function stubBrowser(hostname: string, webdriver: boolean) {
    vi.stubGlobal("window", { location: { hostname } });
    vi.stubGlobal("navigator", { webdriver });
  }

  it("allows a human on the production storefront", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    stubBrowser("vantalabs.com", false);
    const { browserAdsReportingAllowed } = await import("@/lib/ads/ads-environment");
    expect(browserAdsReportingAllowed().allowed).toBe(true);
  });

  it("refuses PLAYWRIGHT ON PRODUCTION — navigator.webdriver is set by every driver", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    stubBrowser("vantalabs.com", true);
    const { browserAdsReportingAllowed } = await import("@/lib/ads/ads-environment");
    const verdict = browserAdsReportingAllowed();
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("automated_browser");
  });

  it("refuses localhost even with production env vars pulled down locally", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    stubBrowser("localhost", false);
    const { browserAdsReportingAllowed } = await import("@/lib/ads/ads-environment");
    expect(browserAdsReportingAllowed().reason).toBe("non_production_host");
  });

  it("refuses a preview host", async () => {
    vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    stubBrowser("vanta-git-branch-team.vercel.app", false);
    const { browserAdsReportingAllowed } = await import("@/lib/ads/ads-environment");
    expect(browserAdsReportingAllowed().reason).toBe("non_production_host");
  });
});

// ---------------------------------------------------------------------------
// The components are actually wired to it
// ---------------------------------------------------------------------------

describe("every pixel component consults the gate", () => {
  const read = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("node:fs") as typeof import("node:fs")).readFileSync(`src/components/${p}`, "utf8");

  it.each(["tiktok-pixel.tsx", "snap-pixel.tsx", "reddit-pixel.tsx", "consented-analytics.tsx"])(
    "%s imports the gate and refuses before rendering the SDK",
    (file) => {
      const source = read(file);
      expect(source).toContain("browserAdsReportingAllowed");
      expect(source).toContain("if (!adsAllowed) return null;");
      // The environment gate must come BEFORE the consent gate and before the
      // Script tag, so no ordering change can let the SDK through.
      expect(source.indexOf("if (!adsAllowed) return null;")).toBeLessThan(
        source.indexOf("if (!accepted) return null;"),
      );
    },
  );

  it("resolves the verdict in an effect, not during render, so hydration cannot mismatch", () => {
    for (const file of ["tiktok-pixel.tsx", "snap-pixel.tsx", "reddit-pixel.tsx", "consented-analytics.tsx"]) {
      const source = read(file);
      // Starting closed is what makes a hydration failure fail safe.
      expect(source).toContain("const [adsAllowed, setAdsAllowed] = useState(false);");
      expect(source).toContain("setAdsAllowed(browserAdsReportingAllowed().allowed);");
    }
  });
});
